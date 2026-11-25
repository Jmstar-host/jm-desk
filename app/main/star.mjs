/* Star 私有聊天（1.6.0）。JM Desk 的好友以 Star 为准：
 *   - 聊天页内嵌 Star 网页（独立的会话分区 persist:star）；用户在里面登录一次，主进程沿用这次登录的 Cookie（star_sid）调 Star 的接口；
 *   - 好友列表读 Star；两边的 JM Desk 通过一条 Star 消息交换串门用的公钥和信箱号（jmdesk-pair），之后串门照旧走 JM Desk 的端到端加密中转，Star 服务器看不到内容；
 *   - 用户勾选的会话作为线索（star_im）收进线索池，按会话、按天聚合。
 * 这里只放和 Electron 无关的部分（接口客户端、配对消息、线索聚合），方便测试。 */
import crypto from 'node:crypto';

/** Star 地址 → 规范化（带结尾的 /）。https 都可以；http 只允许本机、局域网和 Tailnet 地址 */
export function normBase(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return null;
  if (u.protocol === 'http:' && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|\.ts\.net$/.test(u.hostname)) return null;
  u.search = ''; u.hash = ''; if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
}

/** 接口客户端。cookie() 返回当前登录的 star_sid（没有登录返回 null） */
export function createStarClient({ base, cookie, fetchImpl = fetch }) {
  const b = normBase(base); if (!b) throw new Error('Star 地址不对：要 https，或者局域网 / Tailnet 的 http 地址');
  async function api(p, { method = 'GET', body } = {}) {
    const sid = await cookie(); if (!sid) throw Object.assign(new Error('还没有登录 Star：在主窗口「聊天」页登录一次'), { code: 'login' });
    const res = await fetchImpl(new URL('api/' + p, b).href, { method, headers: { Cookie: `star_sid=${sid}`, 'x-star': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch {}
    if (res.status === 401) throw Object.assign(new Error('Star 登录已过期：在「聊天」页重新登录'), { code: 'login' });
    if (!res.ok) throw Object.assign(new Error(`Star：${j?.error || j?.message || 'HTTP ' + res.status}`), { status: res.status });
    return j;
  }
  return {
    base: b, api,
    me: async () => (await api('me')).user,
    friends: async () => (await api('friends')).friends || [],
    conversations: async () => (await api('conversations')).conversations || [],
    messages: async (convId, { after, limit = 100 } = {}) => (await api(`conversations/${Number(convId)}/messages?limit=${limit}${after ? '&after=' + Number(after) : ''}`)).messages || [],
    direct: async uid => (await api('conversations/direct', { method: 'POST', body: { user_id: Number(uid) } })).conversation,
    send: async (convId, content) => (await api(`conversations/${Number(convId)}/messages`, { method: 'POST', body: { type: 'text', content, client_id: 'jmdesk-' + crypto.randomBytes(6).toString('hex') } })).message,
  };
}

/* ---------- 配对：两边 JM Desk 经 Star 消息交换串门用的公钥和信箱号 ---------- */
const B64 = /^[A-Za-z0-9+/=_-]{20,600}$/, HEX = /^[0-9a-f]{64}$/;
export const PAIR_TAG = 'jmdesk-pair:v1:';
export function pairText({ pub, box, name }) {
  const payload = Buffer.from(JSON.stringify({ pub, box, name: String(name || '').slice(0, 30) })).toString('base64url');
  return `🔗 JM Desk 已连接（自动发送，用于串门时端到端加密，可以忽略）\n${PAIR_TAG}${payload}`;
}
export function parsePair(text) {
  const m = String(text || '').match(/jmdesk-pair:v1:([A-Za-z0-9_-]{20,2000})/); if (!m) return null;
  let j; try { j = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!j || !B64.test(String(j.pub || '')) || !HEX.test(String(j.box || ''))) return null;
  return { pub: String(j.pub), box: String(j.box), name: String(j.name || '').slice(0, 30) };
}
export const isPairMessage = m => typeof m?.content === 'string' && m.content.includes(PAIR_TAG);

/* ---------- 线索：勾选的会话按天聚合成 star_im 线索（同一天的新消息追加到同一条） ---------- */
const pad = n => String(n).padStart(2, '0');
const dayOf = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hm = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const convName = (c, meId) => c.type === 'direct' ? (c.peer?.nickname || c.peer?.username || '单聊') : (c.name || '群聊');
export function messageLine(m) {
  const who = m.sender?.nickname || m.sender?.username || '某人';
  const body = m.type === 'text' ? String(m.content || '') : m.type === 'image' ? `[图片] ${m.content || ''}` : m.type === 'file' ? `[文件] ${m.content || ''}` : '';
  return body.trim() ? `[${hm(m.created_at)}] ${who}：${body.trim()}` : '';
}
/** 一个会话的新消息 → 每天一条线索（id 稳定，同一天再来新消息时合并） */
export function clueSignals(conv, msgs, { base = '' } = {}) {
  const byDay = new Map();
  for (const m of msgs) {
    if (m.type === 'system' || isPairMessage(m)) continue;
    const line = messageLine(m); if (!line) continue;
    const d = dayOf(m.created_at); if (!byDay.has(d)) byDay.set(d, { lines: [], who: new Set(), first: m.created_at });
    const g = byDay.get(d); g.lines.push(line); g.who.add(m.sender?.nickname || m.sender?.username || '');
  }
  const name = convName(conv);
  return [...byDay].map(([d, g]) => ({
    id: crypto.createHash('sha256').update(`star_im|${conv.id}|${d}`).digest('hex').slice(0, 32),
    source_type: 'star_im', source_ref: `star:${conv.id}:${d}`, source_url: base || null,
    title: `Star · ${name} · ${d.slice(5)}`, occurred_at: new Date(g.first).toISOString(),
    participants: [...g.who].filter(Boolean).slice(0, 20), content: g.lines.join('\n'), meta: { conv: conv.id, day: d },
  }));
}
/** 同一天已有的线索：把新的几行接在后面（去掉重复行） */
export function mergeContent(old, add) {
  const have = new Set(String(old || '').split('\n'));
  const extra = String(add || '').split('\n').filter(l => l && !have.has(l));
  return extra.length ? (old ? old + '\n' : '') + extra.join('\n') : old;
}
