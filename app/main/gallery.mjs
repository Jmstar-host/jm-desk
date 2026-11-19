/* 形象库：列出可下载的形象，下载 / 导入 3D 模型做成本机形象包，删除形象包。
 *
 * 形象来源列表有两层，安装包里不带任何第三方角色：
 *   1. 内置：builtin/characters.json（只放原创、可分发的形象）
 *   2. 本机 / 企业：<数据目录>/character-sources.json（用户或企业自己维护，可以放任意模型链接）
 *      [{ "id": "my-sprite", "name": "名字", "url": "https://…/model.glb", "page": "https://…", "license": "…", "note": "…" }]
 * 下载的模型只存在本机 <数据目录>/extensions/character/<id>/，不会上传、不进安装包。 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 60 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const clip = (v, n) => String(v ?? '').slice(0, n);
const httpsUrl = u => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };

export function slug(s, fallback = 'sprite') {
  const t = String(s || '').toLowerCase().replace(/\.(glb|gltf)$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return ID.test(t) ? t : `${fallback}-${Date.now().toString(36).slice(-5)}`;
}

/* 合并内置与本机来源；同 id 以先出现的为准 */
export function listSources(builtinFile, userFile) {
  const out = [], seen = new Set();
  for (const [file, origin] of [[builtinFile, 'builtin'], [userFile, 'local']]) {
    let arr = [];
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); arr = Array.isArray(j) ? j : Array.isArray(j?.sources) ? j.sources : []; } catch {}
    for (const s of arr) {
      const id = String(s?.id || ''), url = httpsUrl(s?.url);
      if (!ID.test(id) || !url || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: clip(s.name || id, 30), url, page: httpsUrl(s.page), license: clip(s.license, 160), note: clip(s.note, 160), size: Number(s.size) || null, origin });
    }
  }
  return out;
}

/* 校验是 glTF 二进制（.glb）：前 4 字节 "glTF"，版本 2 */
export function checkGlb(buf) {
  if (!buf || buf.length < 20) throw new Error('文件太小，不是有效的 3D 模型');
  if (buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('不是 .glb 模型文件（目前只支持 .glb）');
  if (buf.readUInt32LE(4) !== 2) throw new Error('只支持 glTF 2.0 模型');
  return true;
}

/* 写成形象包：独立目录 + manifest.json + model.glb */
export function installPack(charDir, { id, name, buf, source = null, page = null, license = '', size = 1.5 }) {
  if (!ID.test(id)) throw new Error('形象 id 不合法');
  checkGlb(buf);
  const dir = path.join(charDir, id);
  if (!path.resolve(dir).startsWith(path.resolve(charDir) + path.sep)) throw new Error('路径不合法');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model.glb'), buf);
  const manifest = { id, name: clip(name || id, 30), author: '', license: clip(license, 160), kind: 'gltf', entry: 'model.glb', size, source, page, installedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/* 下载：只接受 https，限制大小，用 Electron 的网络栈（遵循系统代理） */
export async function download(fetchImpl, url, { maxBytes = MAX_BYTES, timeoutMs = 120000 } = {}) {
  const u = httpsUrl(url); if (!u) throw new Error('只支持 https:// 开头的模型链接');
  let res;
  try { res = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { throw new Error(`下载失败：${e.name === 'TimeoutError' ? '超时' : e.message}`); }
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error(`模型太大（${Math.round(len / 1048576)} MB），上限 ${maxBytes / 1048576} MB`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`模型太大，上限 ${maxBytes / 1048576} MB`);
  return buf;
}

export function removePack(charDir, id) {
  if (!ID.test(id) || id === 'lumi') throw new Error('不能删除内置形象');
  const dir = path.join(charDir, id);
  if (!path.resolve(dir).startsWith(path.resolve(charDir) + path.sep)) throw new Error('路径不合法');
  fs.rmSync(dir, { recursive: true, force: true });
}
