/* 资料上传（1.9.0）：把拖到精灵身上的文件交给知识库的「资料库」。
 * 哪个接入能收资料：标了 knowledge 的接入里写了 library: { base }（资料库接口地址，https；企业预置文件里写，仓库里不放地址）。
 * 凭据沿用这个接入自己的个人 Key（和 MCP 是同一把），只在主进程用，不进界面、不进日志。
 * 接口约定（资料库服务）：
 *   GET  <base>/api/me      → { user, upload, admin, domains, platforms, upload_scopes, my_departments }
 *   POST <base>/api/upload  请求体是文件原文；X-Filename（URL 编码）、X-Visibility、X-Domain、X-Platform、X-Dept、X-Tags
 *                           → { doc_id, status: queued | duplicate, review, dept }；出错 { error }
 * 这里只有纯函数和请求，不碰窗口；文件读取由调用方给（方便测试）。上传是写操作，调用方必须先让人确认。 */
import path from 'node:path';

export const TEXT_EXT = ['.md', '.txt', '.csv', '.json', '.yaml', '.yml', '.xml', '.log', '.html', '.htm'];
export const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const ALLOWED_EXT = new Set([...TEXT_EXT, ...IMG_EXT, '.pdf', '.docx', '.doc', '.xlsx', '.xlsm', '.pptx']);
export const MAX_BYTES = 60 * 1024 * 1024;
export const MAX_FILES = 20;
export const VISIBILITY = { all: '全员可见', dept: '本部门可见' };

const isLocal = u => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(u || ''));
/* 资料库地址：只接受 https（本机调试用的 http://127.0.0.1 除外），去掉末尾的斜杠 */
export function libraryBase(integ) {
  const raw = integ?.library?.base; if (!raw || typeof raw !== 'string') return null;
  try { const u = new URL(raw); if (u.protocol !== 'https:' && !isLocal(u.href)) return null; if (u.username || u.password || u.search || u.hash) return null; return u.href.replace(/\/+$/, ''); } catch { return null; }
}
/* 能收资料的接入：启用、标了知识库、写了资料库地址 */
export function targets(integs) {
  return (integs || []).filter(i => i && i.enabled !== false && i.knowledge && libraryBase(i)).map(i => ({ id: i.id, name: String(i.name || i.id).slice(0, 30), base: libraryBase(i) }));
}

const mb = n => (n / 1048576).toFixed(n < 1048576 * 10 ? 1 : 0) + ' MB';
export const sizeText = n => (n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : mb(n));
/* 逐个检查拖进来的东西：只收单个文件，类型和大小按资料库的规则先挡一遍，省得传到一半才被拒。
 * stat(p) → { isFile, isDirectory, size }，读不到时抛错。 */
export function checkFiles(paths, stat) {
  const seen = new Set(), out = [];
  for (const p of (Array.isArray(paths) ? paths : []).filter(x => typeof x === 'string' && x)) {
    if (seen.has(p)) continue; seen.add(p);
    const name = path.basename(p), ext = path.extname(name).toLowerCase();
    const it = { path: p, name, size: 0, ok: false, reason: '' };
    if (out.filter(x => x.ok).length >= MAX_FILES) { it.reason = `一次最多 ${MAX_FILES} 份`; out.push(it); continue; }
    let st; try { st = stat(p); } catch { it.reason = '读不到这个文件'; out.push(it); continue; }
    it.size = st.size || 0;
    if (st.isDirectory) it.reason = '是文件夹：请把里面的文件拖进来';
    else if (!st.isFile) it.reason = '不是普通文件';
    else if (name.startsWith('.')) it.reason = '隐藏文件不收';
    else if (!ALLOWED_EXT.has(ext)) it.reason = `资料库不收 ${ext || '没有扩展名的'} 文件`;
    else if (!it.size) it.reason = '空文件';
    else if (it.size > MAX_BYTES) it.reason = `超过 ${mb(MAX_BYTES)}（这份 ${mb(it.size)}）`;
    else it.ok = true;
    out.push(it);
  }
  return out;
}

const ERRORS = {
  portal_login_required: '个人 Key 没有通过验证：在「设置 › 接入」里重新填一次',
  login_required: '个人 Key 没有通过验证：在「设置 › 接入」里重新填一次',
  unsupported_file: '资料库不收这种文件',
  file_too_large: '文件太大',
  visibility_invalid: '可见范围不对',
  domain_invalid: '大类不在资料库的列表里', platform_invalid: '平台不在资料库的列表里',
  region_invalid: '区域不在资料库的列表里', category_invalid: '资料分类不在资料库的列表里',
  library_unavailable: '资料库暂时连不上，稍后再试',
};
async function request(url, { method = 'GET', token, headers = {}, body, fetchImpl = fetch, timeoutMs = 60000 }) {
  if (!token) throw new Error('还没有填个人 Key：在「设置 › 接入」里填一次');
  let res;
  try { res = await fetchImpl(url, { method, headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...headers }, body, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new Error(e?.name === 'TimeoutError' ? '资料库响应超时' : '连不上资料库：' + String(e?.message || e).slice(0, 80)); }
  let j = null; try { j = await res.json(); } catch {}
  if (!res.ok) {
    const code = j && typeof j.error === 'string' ? j.error : '';
    throw new Error(ERRORS[code] || (code && /[\u4e00-\u9fff]/.test(code) ? code.slice(0, 120) : res.status === 401 ? ERRORS.login_required : res.status === 413 ? ERRORS.file_too_large : `资料库返回 ${res.status}`));
  }
  if (!j || typeof j !== 'object') throw new Error('资料库没有认这把个人 Key（被转去了登录页），或者资料库地址不对：在「设置 › 接入」里核对');
  return j;
}

const strs = (a, n = 200) => (Array.isArray(a) ? a : []).filter(x => typeof x === 'string' && x).map(x => x.slice(0, 60)).slice(0, n);
/* 我能往哪里传：服务端返回的是全部大类 / 平台和我的上传授权，这里算出下拉框里该列哪些。
 * 管理员不受限；其余人只列授权里出现的大类和平台（授权里写 * 或留空表示不限）。服务端仍会再校验一遍。 */
export function options(me) {
  const admin = !!me?.admin, domains = strs(me?.domains), platforms = strs(me?.platforms);
  const scopes = Array.isArray(me?.upload_scopes) ? me.upload_scopes : [];
  const pick = (all, key) => {
    if (admin) return all;
    let any = false; const set = new Set();
    for (const g of scopes) { const a = strs(g?.[key]); if (!a.length || a.includes('*')) any = true; else a.forEach(x => set.add(x)); }
    return any ? all : all.filter(x => set.has(x));
  };
  const depts = (Array.isArray(me?.my_departments) ? me.my_departments : []).filter(d => d && typeof d.id === 'string').map(d => ({ id: d.id.slice(0, 80), name: String(d.name || d.id).slice(0, 40) })).slice(0, 30);
  return { user: String(me?.user || '').slice(0, 80), admin, canUpload: admin || !!me?.upload, needDims: !admin, domains: pick(domains, 'domains'), platforms: pick(platforms, 'platforms'), depts };
}
export async function whoami({ base, token, fetchImpl }) { return options(await request(base + '/api/me', { token, fetchImpl, timeoutMs: 20000 })); }

const enc = v => encodeURIComponent(String(v));
/* 上传一份。opts：{ visibility, domain, platform, dept, tags }；没选的不带，交给资料库自动归类（非管理员必须选大类和平台）。 */
export function uploadHeaders(name, opts = {}) {
  const h = { 'Content-Type': 'application/octet-stream', 'X-Filename': enc(name), 'X-Visibility': opts.visibility === 'dept' ? 'dept' : 'all' };
  if (opts.domain) h['X-Domain'] = enc(opts.domain);
  if (opts.platform) h['X-Platform'] = enc(opts.platform);
  if (opts.dept) h['X-Dept'] = String(opts.dept).replace(/[^\w:.\-]/g, '').slice(0, 80);
  const tags = (Array.isArray(opts.tags) ? opts.tags : String(opts.tags || '').split(/[,，、\s]+/)).map(t => String(t).trim()).filter(Boolean).slice(0, 8);
  if (tags.length) h['X-Tags'] = enc(tags.join(','));
  return h;
}
export async function uploadOne({ base, token, name, data, opts, fetchImpl }) {
  if (!ALLOWED_EXT.has(path.extname(name).toLowerCase())) throw new Error(ERRORS.unsupported_file);
  if (!data || !data.length) throw new Error('空文件');
  if (data.length > MAX_BYTES) throw new Error(ERRORS.file_too_large);
  const j = await request(base + '/api/upload', { method: 'POST', token, headers: uploadHeaders(name, opts), body: data, fetchImpl, timeoutMs: 5 * 60e3 });
  const status = j.status === 'duplicate' ? 'duplicate' : j.status === 'queued' ? 'queued' : 'unknown';
  return { status, docId: /^pl_[0-9a-f]{24}$/.test(String(j.doc_id || '')) ? j.doc_id : null };
}
export const STATUS = { queued: '已交给资料库，等 AI 预审', duplicate: '资料库里已经有这一份', unknown: '已提交', failed: '没传上去' };

/* 一批：一份一份传，前一份失败不影响后面的；onStep(i, item) 每份开始和结束各回调一次 */
export async function uploadAll({ base, token, files, opts, read, fetchImpl, onStep = () => {}, stopped = () => false }) {
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i], it = { name: f.name, size: f.size, status: 'uploading', note: '' };
    if (stopped()) { it.status = 'failed'; it.note = '已停止'; out.push(it); onStep(i, it); continue; }
    onStep(i, it);
    try { const r = await uploadOne({ base, token, name: f.name, data: await read(f.path), opts, fetchImpl }); it.status = r.status; it.docId = r.docId; it.note = STATUS[r.status]; }
    catch (e) { it.status = 'failed'; it.note = String(e?.message || e).slice(0, 160); }
    out.push(it); onStep(i, it);
  }
  return out;
}
