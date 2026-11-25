/* 串门：两台 JM Desk 结成好友，A 的精灵飞到 B 的桌面，在 B 开放的范围里找资料，再搬回来。
 *
 * 身份：每台桌面一对 X25519 密钥 + 一把信箱钥匙 boxKey（信箱号 box = sha256(boxKey)），由主进程加密保存。
 * 加好友：A 向中转申请 6 位好友码 → B 输入 → 双方拿到对方公钥和信箱号 → 各自算出共同密钥；
 *       两边显示同样的 4 个「暗号」，人工核对一致后才算加好友成功（防中转偷换公钥）。
 * 消息：AES-256-GCM 端到端加密，附带发信方信箱号作为附加数据；中转只看到密文。
 * 消息类型（加密后的 JSON）：hello / visit / visit-ack / visit-result / visit-denied / bye */
import crypto from 'node:crypto';

const b64 = b => Buffer.from(b).toString('base64url');
const unb64 = s => Buffer.from(String(s), 'base64url');
export const sha = s => crypto.createHash('sha256').update(s).digest('hex');
export const isLocalUrl = u => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(u || ''));
export function relayUrl(u) { try { const x = new URL(String(u).trim()); return x.protocol === 'https:' || isLocalUrl(x.href) ? x.href.replace(/\/+$/, '') : null; } catch { return null; } }

/* ---------- 身份与密钥 ---------- */
export function newIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const boxKey = b64(crypto.randomBytes(32));
  return { pub: b64(publicKey.export({ type: 'spki', format: 'der' })), priv: b64(privateKey.export({ type: 'pkcs8', format: 'der' })), boxKey, box: sha(boxKey) };
}
export function sharedKey(me, peerPub) {
  const priv = crypto.createPrivateKey({ key: unb64(me.priv), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: unb64(peerPub), format: 'der', type: 'spki' });
  const secret = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  const salt = [me.pub, peerPub].sort().join('|');
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, 'jm-desk peer v1', 32));
}
const WORDS = ['星星', '月亮', '云朵', '彩虹', '海浪', '松果', '樱桃', '蜜桃', '柠檬', '风铃', '灯塔', '纸鹤', '贝壳', '雪花', '蒲公英', '萤火虫', '棉花糖', '小船', '口琴', '书签', '橡皮', '铃铛', '火车', '气球', '竹蜻蜓', '向日葵', '薄荷', '琥珀', '雨伞', '风筝', '积木', '茶壶'];
/* 两边看到的暗号相同才说明公钥没被偷换 */
export function fingerprint(pubA, pubB) { const h = crypto.createHash('sha256').update([pubA, pubB].sort().join('|')).digest(); return [0, 1, 2, 3].map(i => WORDS[h[i] % WORDS.length]); }

export function seal(key, fromBox, obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(fromBox));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return b64(Buffer.concat([iv, c.getAuthTag(), ct]));
}
export function open(key, fromBox, data) {
  const raw = unb64(data), d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(fromBox)); d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

/* ---------- 中转客户端 ---------- */
export function createClient({ relay, fetchImpl = fetch }) {
  const base = relayUrl(relay); if (!base) throw Object.assign(new Error('中转地址必须是 https（本机测试可以用 http://127.0.0.1）'), { code: 'relay_invalid' });
  async function post(path, body, timeoutMs = 20000) {
    let r;
    try { r = await fetchImpl(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw Object.assign(new Error(`连不上中转：${e.name === 'TimeoutError' ? '超时' : e.message}`), { code: 'relay_unreachable' }); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error({ code_not_found: '好友码不对或已过期', rate_limited: '操作太频繁，稍后再试', too_large: '内容太大' }[j.error] || `中转返回 ${r.status}`), { code: j.error || 'relay_error', status: r.status });
    return j;
  }
  return {
    base,
    offer: (me, name) => post('/v1/pair/offer', { pub: me.pub, box: me.box, name }),
    claim: (me, name, code) => post('/v1/pair/claim', { pub: me.pub, box: me.box, name, code: String(code).replace(/\D/g, '') }),
    send: (me, peer, obj) => post('/v1/send', { to: peer.box, from: me.box, data: seal(sharedKey(me, peer.pub), me.box, obj) }),
    poll: (me, wait = 25) => post('/v1/poll', { key: me.boxKey, wait }, (wait + 10) * 1000),
  };
}

/* 解开收到的一批信：pair-claimed 是中转投来的明文（只有公钥和名字），其余都要用对应好友的共同密钥解密；
 * 解不开的（不是好友、被篡改）直接丢弃 */
export function unpack(me, messages, peers, pending = []) {
  const out = [];
  for (const m of messages || []) {
    if (m.type === 'pair-claimed') { if (pending.length) out.push({ kind: 'pair-claimed', from: m.from, pub: m.pub, name: String(m.name || '').slice(0, 30) }); continue; }
    if (m.type !== 'sealed') continue;
    const p = peers.find(x => x.box === m.from) || pending.find(x => x.box === m.from); if (!p) continue;
    try { out.push({ kind: 'msg', peer: p, msg: open(sharedKey(me, p.pub), m.from, m.data) }); } catch { /* 解不开就丢掉 */ }
  }
  return out;
}

/* 访客能看的范围 → 允许调用的工具：只读，邮件和聊天原文永远不开放 */
/* 好友分级：basic 普通好友（只能搬需求池、待办里你开放的部分）；knowledge 知识好友（另外还能问你接入的知识库）。
 * 1.4.2 之前加的好友没有分级，按 knowledge 算（保持原来能做的事）；之后新加的默认 basic */
export const TIERS = { basic: '普通好友', knowledge: '知识好友（可问我的知识库）' };
export const tierOf = peer => (peer?.tier === 'basic' ? 'basic' : 'knowledge');
/** 对某个好友实际开放的范围 = 我的开放范围 ∩ 好友的等级 */
export function shareFor(share = {}, peer) { return { ...share, knowledge: !!share.knowledge && tierOf(peer) === 'knowledge' }; }
export const SCOPES = { knowledge: '知识问答（我接入的知识库）', requirements: '需求池（项目和需求标题）', todos: '待办（只看标题和状态）' };
export function scopeTools(tools, share = {}) {
  return tools.filter(t => {
    if (t.integ.knowledge) return !!share.knowledge && t.tool.write === false;
    if (t.integ.id === 'jmdesk') return (share.requirements && t.tool.name === 'list_requirements') || (share.todos && t.tool.name === 'list_todos');
    return false;
  });
}

/* ---------- 可搬运目录（1.2.0）----------
 * 搬运前先说清楚搬哪一块：好友之间由程序自动交换一份「我能提供什么」的目录，出门时带上选好的范围，对方只在这个范围里找。
 * 目录：[{ id, kind: knowledge | requirements | todos, name, items: [{ id, label, note? }] }]
 *   knowledge    一个标了 knowledge 的接入，id = 'k:' + 接入 id；items 是它里面的平台 / 业务域（来自 business_catalog），没有就整库
 *   requirements 需求池；items 是项目
 *   todos        待办（只有标题和状态）
 * 目录里只有名字，没有内容；只发给已经加了好友的桌面。范围 scope = { section, item?, label }。 */
const clipS = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export function cleanCatalog(sections) {
  return (Array.isArray(sections) ? sections : []).slice(0, 12).map(s => ({
    id: clipS(s?.id, 60), kind: ['knowledge', 'requirements', 'todos', 'files'].includes(s?.kind) ? s.kind : 'knowledge', name: clipS(s?.name, 30) || '知识库',
    items: (Array.isArray(s?.items) ? s.items : []).slice(0, 120).map(i => ({ id: clipS(i?.id, 80), label: clipS(i?.label, 40) || clipS(i?.id, 40), ...(i?.note ? { note: clipS(i.note, 40) } : {}) })).filter(i => i.id),
  })).filter(s => /^[A-Za-z0-9:_.-]{1,60}$/.test(s.id));
}
/* 知识库的 business_catalog 返回 → 平台列表。认 { platforms: [{ platform | name | id, … }] }，也认直接的数组；认不出就返回空（整库作为一个范围） */
export function catalogItems(text) {
  let j; try { if (typeof text === 'string') { const t = text.trim(), a = t.search(/[[{]/); j = JSON.parse(a >= 0 ? t.slice(a) : t); } else j = text; } catch { return []; }
  const rows = Array.isArray(j) ? j : Array.isArray(j?.platforms) ? j.platforms : Array.isArray(j?.items) ? j.items : [];
  return rows.map(r => typeof r === 'string' ? { id: r, label: r } : { id: clipS(r?.platform ?? r?.id ?? r?.name, 80), label: clipS(r?.display ?? r?.title ?? r?.name ?? r?.platform ?? r?.id, 40) }).filter(r => r.id).slice(0, 120);
}
export function findScope(sections, scope) {
  const sec = (sections || []).find(s => s.id === scope?.section); if (!sec) return null;
  if (scope.item == null || scope.item === '') return { section: sec, item: null };
  const item = sec.items.find(i => i.id === String(scope.item)); return item ? { section: sec, item } : null;
}
export const scopeLabel = hit => hit ? `${hit.section.name}${hit.item ? ' › ' + hit.item.label : ''}` : '';
export const cleanScope = sc => sc && typeof sc === 'object' && sc.section ? { section: clipS(sc.section, 60), item: sc.item == null || sc.item === '' ? null : clipS(sc.item, 80), label: clipS(sc.label, 80) } : null;
/* 不用模型的检索：按「要搬的内容」里的词给每行打分（英文单词、中文相邻两字），返回命中的行；一个都没命中时返回空 */
export function matchRows(rows, ask, text = r => r.title) {
  const s = String(ask || '').toLowerCase(), terms = new Set([...(s.match(/[a-z0-9]{2,}/g) || [])]);
  for (const run of s.match(/[\u4e00-\u9fff]{2,}/g) || []) for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
  return rows.map((r, i) => { const t = String(text(r) || '').toLowerCase(); let n = 0; for (const w of terms) if (t.includes(w)) n++; return { r, n, i }; }).filter(x => x.n > 0).sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.r);
}
