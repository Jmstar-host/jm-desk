// jmdesk:// 唤起链接（纯函数，无 Electron 依赖，便于测试）。
//
// 目前只有一种：jmdesk://connect?base=<需求管理平台地址>
//   打开「关联需求管理平台账号」面板并预填地址。**不会自动发起关联**：任何网页都能触发 URL scheme，
//   如果自动发起，恶意地址可以借设备授权把一个假的 MCP 接入塞进 JM Desk。必须由用户核对地址后自己点「申请关联代码」。
//
// 返回 { action: 'connect', base } 或 null（格式不对一律忽略，不报错、不弹窗）。

const MAX_URL = 2048;
const MAX_BASE = 300;

export function parseDeepLink(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'jmdesk:') return null;
  // jmdesk://connect?…：URL 解析后 connect 落在 host；jmdesk:connect?… 时落在 pathname
  const action = (u.host || u.pathname.replace(/^\/+/, '')).replace(/\/+$/, '').toLowerCase();
  if (action !== 'connect') return null;
  const base = normalizeBase(u.searchParams.get('base'));
  return base ? { action: 'connect', base } : null;
}

/** 只接受 http / https，不带账号密码、查询串和片段；去掉末尾斜杠。 */
export function normalizeBase(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > MAX_BASE) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** 本机地址（http 在本机也是安全的）；非本机的 http 在面板上提示一下。 */
export function isLoopback(base) {
  try {
    const h = new URL(base).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
  } catch { return false; }
}
