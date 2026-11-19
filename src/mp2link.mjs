/* 关联需求管理平台（MP2）账号：设备授权（参照 RFC 8628）。
 *
 * 1. begin：本机生成 secret（只在内存里，不落盘、不打日志），POST {base}/api/ai-access/device-links，拿到 8 位 user_code 和确认页地址。
 * 2. 用户在 MP2 登录、核对代码、选有效期、点「允许」或「拒绝」。
 * 3. poll：每 interval 秒 POST .../device-links/{id}/token（请求头 X-MP2-Link-Secret）。
 *    pending 继续；slow_down 间隔 +5 秒；connected 时 config 只给这一次——原样写入本机凭据文件（独占创建 0600）；
 *    denied / expired（或链接已不存在）停止，让用户重新发起。
 * 4. unlink：删除本机凭据并清空配置；撤销在 MP2「AI 接入」页操作。
 *
 * 凭据和 secret 都不进日志、不进搬运记录、不读进模型上下文：这里只写文件，调用 MP2 时由 mp2.mjs 取 Authorization 头。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.mjs';

export const CLIENT_NAME = 'JM Desk';
export const SLOW_DOWN_MS = 5000;
export const credentialPath = () => path.join(store.HOME, 'mp2-connection.json');

const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const MESSAGES = {
  invalid_device_link: 'MP2 拒绝了关联请求（参数不合法）',
  device_link_limit: '同时等待确认的关联太多了，请稍后再试',
  device_link_secret_required: '关联校验失败，请重新发起',
  device_link_not_found: '这次关联已经失效，请重新发起',
};

/* 地址：只接受 http(s)，去掉末尾的 /（部署前缀保留，不做猜测） */
export function normalizeBase(u) {
  const s = String(u ?? '').trim().replace(/\/+$/, '');
  if (!s) throw fail('请先填写需求管理平台（MP2）的地址', 'no_base_url');
  let url; try { url = new URL(s); } catch { throw fail('MP2 地址格式不对，应以 http:// 或 https:// 开头', 'invalid_base_url'); }
  if (!/^https?:$/.test(url.protocol)) throw fail('MP2 地址格式不对，应以 http:// 或 https:// 开头', 'invalid_base_url');
  return s;
}
export const newSecret = () => crypto.randomBytes(48).toString('base64url'); // 64 位 [A-Za-z0-9_-]
const hostName = () => { try { return os.hostname().replace(/\.local$/, '').slice(0, 60) || null; } catch { return null; } };

async function post(url, { body, headers = {}, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw fail(`连不上 MP2：${e.name === 'TimeoutError' ? '超时' : e.message}`, 'network_error'); }
  const j = await res.json().catch(() => null);
  return { status: res.status, json: j };
}
// MP2 的错误体：{ status: 400, detail: 'invalid_device_link' }（ApiException）；兼容 code / error 写法
const errCode = j => (j && (j.detail || j.code || j.error || j.message)) || null;

/* 发起关联。返回的对象里带 secret：只交给 poll 用，调用方不要把它存盘、打印或发给界面 / 模型。 */
export async function begin(baseUrl, { deviceName = hostName(), fetchImpl, minIntervalSec = 1 } = {}) {
  const base = normalizeBase(baseUrl);
  const secret = newSecret();
  const { status, json } = await post(base + '/api/ai-access/device-links', { body: { client_name: CLIENT_NAME, device_name: deviceName, secret }, fetchImpl });
  if (status === 404 || status === 405) throw fail('这个 MP2 还不支持关联本地助手（没有 device-links 接口），请确认地址或 MP2 版本', 'not_supported');
  if (status >= 300 || !json?.id || !json?.user_code) { const c = errCode(json); throw fail(MESSAGES[c] || `MP2 返回 ${status}${c ? '：' + c : ''}`, c || `http_${status}`, { status }); }
  const verification_url = /^https?:\/\//i.test(json.verification_url || '') ? json.verification_url : null;
  return {
    base, id: String(json.id), user_code: String(json.user_code), verification_url,
    expires_at: json.expires_at || new Date(Date.now() + 10 * 60e3).toISOString(),
    interval: Math.max(minIntervalSec, Number(json.interval) || 5),
    secret,
  };
}

/* 查一次。返回 { status: 'pending'|'slow_down'|'connected'|'denied'|'expired', connectionId? }。
 * connected 时已经把凭据写好了。 */
export async function poll(link, { fetchImpl } = {}) {
  const { status, json } = await post(`${link.base}/api/ai-access/device-links/${encodeURIComponent(link.id)}/token`, { headers: { 'X-MP2-Link-Secret': link.secret }, fetchImpl });
  if (status === 404) return { status: 'expired' };
  if (status >= 300) { const c = errCode(json); throw fail(MESSAGES[c] || `MP2 返回 ${status}${c ? '：' + c : ''}`, c || `http_${status}`, { status, final: status === 403 }); }
  const st = json?.status;
  if (st === 'connected') {
    if (!json.config || typeof json.config !== 'object') {
      // 凭据只给一次（之后 MP2 只回 { status: 'connected' }）。这次关联本机已经存下就算成功，否则说明被别处领走了
      if (link.received && fs.existsSync(credentialPath())) return { status: 'connected', connectionId: link.received };
      throw fail('MP2 已经发出过这次的凭据，本机没有收到，请重新发起关联', 'config_already_taken', { final: true });
    }
    const connectionId = String(json.connection_id || '');
    saveConnection(link.base, connectionId, json.config, link.verification_url);
    Object.defineProperty(link, 'received', { value: connectionId || true, enumerable: false, configurable: true });
    return { status: 'connected', connectionId };
  }
  if (['pending', 'slow_down', 'denied', 'expired'].includes(st)) return { status: st };
  if (st === 'approved') return { status: 'pending' }; // 防御：正常不会出现
  throw fail(`MP2 返回了未知状态：${st}`, 'unknown_status');
}

/* 一直等到有结果；onStatus 每次查询后回调（不含 secret）。signal 可取消。 */
export async function waitFor(link, { onStatus = () => {}, signal, fetchImpl, slowDownMs = SLOW_DOWN_MS, sleep } = {}) {
  let gap = link.interval * 1000;
  const wait = sleep || (ms => new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(fail('已取消', 'cancelled')); }, { once: true });
  }));
  for (;;) {
    if (signal?.aborted) throw fail('已取消', 'cancelled');
    await wait(gap);
    if (signal?.aborted) throw fail('已取消', 'cancelled');
    if (Date.parse(link.expires_at) + 15000 < Date.now()) { onStatus({ status: 'expired' }); return { status: 'expired' }; }
    const r = await poll(link, { fetchImpl });
    if (r.status === 'slow_down') gap += slowDownMs;
    onStatus({ ...r, interval: gap / 1000 });
    if (r.status !== 'pending' && r.status !== 'slow_down') return r;
  }
}

/* 原样写入 config：先独占创建（0600）一个临时文件，再原子改名，避免出现权限过宽的中间状态 */
export function saveConnection(base, connectionId, cfgObj, verificationUrl = null) {
  store.ensureHome();
  const file = credentialPath(), tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, JSON.stringify(cfgObj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
  const c = store.config();
  let webBase = null; try { webBase = verificationUrl ? new URL(verificationUrl).origin : null; } catch {}
  c.mp2 = { ...c.mp2, baseUrl: base, webBase, credentialFile: file, connectionId: connectionId || null, linkedAt: new Date().toISOString(), via: 'device-link' };
  store.saveConfig(c);
  store.log('linked', '已关联需求管理平台账号');
}

export function unlink() {
  const c = store.config(), file = c.mp2?.credentialFile;
  let removed = false;
  for (const f of new Set([file, credentialPath()].filter(Boolean))) { try { fs.unlinkSync(f); removed = true; } catch {} }
  c.mp2 = { ...c.mp2, credentialFile: null, connectionId: null, linkedAt: null, via: null };
  store.saveConfig(c);
  store.log('unlinked', '已断开需求管理平台账号（本机凭据已删除）');
  return { removed, baseUrl: c.mp2.baseUrl || null };
}

/* 给界面看的状态：不含凭据和 secret */
export function linkStatus() {
  const m = store.config().mp2 || {}, file = m.credentialFile;
  let mode = null; try { if (file) mode = (fs.statSync(file).mode & 0o777).toString(8); } catch {}
  return { linked: !!(m.baseUrl && file && mode), baseUrl: m.baseUrl || null, webBase: m.webBase || null, connectionId: m.connectionId || null, linkedAt: m.linkedAt || null, via: m.via || null, fileMode: mode };
}
