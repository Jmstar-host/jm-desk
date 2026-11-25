/* Star 私有聊天（1.6.0）：好友以 Star 为准。接口客户端沿用聊天页登录的 Cookie；两边 JM Desk 经 Star 消息交换搬运用的公钥后，照旧走加密中转；勾选的会话按天聚合成线索。
 * 全部用本机的假 Star 和假中转，不连真实服务。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as S from '../app/main/star.mjs';
import * as P from '../app/main/peers.mjs';
import { createRelay } from '../relay/server.mjs';
import { createPeerHub } from '../app/main/peerhub.mjs';

test('Star 地址：https 都行；http 只认本机、局域网和 Tailnet；结尾补 /', () => {
  assert.equal(S.normBase('https://chat.example.com/star'), 'https://chat.example.com/star/');
  assert.equal(S.normBase('http://192.168.1.10:13401'), 'http://192.168.1.10:13401/');
  assert.equal(S.normBase('http://100.82.1.2:8080/star/'), 'http://100.82.1.2:8080/star/');
  assert.equal(S.normBase('http://evil.example.com/'), null);
  assert.equal(S.normBase('ftp://x/'), null);
});

test('接口客户端：带上聊天页登录的 Cookie 和 x-star 头；没登录、登录过期给出明确提示', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, xs: req.headers['x-star'] });
    if (req.headers.cookie !== 'star_sid=good') { res.writeHead(401); return res.end('{"error":"请先登录"}'); }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/star/api/friends') return res.end(JSON.stringify({ friends: [{ id: 2, nickname: '同事乙', remark: '' }] }));
    res.end('{}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/star`;
  try {
    let sid = null; const c = S.createStarClient({ base, cookie: async () => sid });
    await assert.rejects(c.friends(), e => e.code === 'login' && /还没有登录 Star/.test(e.message));
    sid = 'good'; assert.deepEqual((await c.friends()).map(f => f.nickname), ['同事乙']);
    assert.deepEqual(seen.at(-1), { url: '/star/api/friends', cookie: 'star_sid=good', xs: '1' });
    sid = 'old'; await assert.rejects(c.friends(), e => e.code === 'login' && /过期/.test(e.message));
  } finally { srv.close(); }
});

test('配对消息：带公钥和信箱号，能解析回来；格式不对的不认', () => {
  const id = P.newIdentity(), t = S.pairText({ pub: id.pub, box: id.box, name: '同事甲' });
  assert.match(t, /^🔗 JM Desk 已连接/); assert.deepEqual(S.parsePair(t), { pub: id.pub, box: id.box, name: '同事甲' });
  assert.equal(S.parsePair('jmdesk-pair:v1:' + Buffer.from('{"pub":"x","box":"y"}').toString('base64url')), null);
  assert.equal(S.parsePair('随便聊聊'), null);
});

test('线索：按天聚合、跳过配对消息和系统消息、图片文件写成标记；同一天的新消息接在后面', () => {
  const conv = { id: 7, type: 'group', name: '充值项目群' }, at = (d, h) => new Date(2026, 10, d, h, 5).getTime();
  const msgs = [
    { id: 1, type: 'text', content: '批量充值接口下周三上线', sender: { nickname: '同事甲' }, created_at: at(24, 10) },
    { id: 2, type: 'text', content: S.pairText({ pub: P.newIdentity().pub, box: P.newIdentity().box }), sender: { nickname: '同事乙' }, created_at: at(24, 11) },
    { id: 3, type: 'system', content: '同事丙加入了群聊', sender: null, created_at: at(24, 12) },
    { id: 4, type: 'file', content: '接口文档.pdf', sender: { nickname: '同事乙' }, created_at: at(25, 9) },
  ];
  const sigs = S.clueSignals(conv, msgs);
  assert.equal(sigs.length, 2); assert.equal(sigs[0].source_type, 'star_im'); assert.equal(sigs[0].title, 'Star · 充值项目群 · 11-24');
  assert.equal(sigs[0].content, '[10:05] 同事甲：批量充值接口下周三上线'); assert.equal(sigs[1].content, '[09:05] 同事乙：[文件] 接口文档.pdf');
  assert.equal(S.clueSignals(conv, msgs)[0].id, sigs[0].id, '同一会话同一天的 id 稳定');
  assert.equal(S.mergeContent('a\nb', 'b\nc'), 'a\nb\nc'); assert.equal(S.mergeContent('a', 'a'), 'a');
});

test('经 Star 交换名片后两边自动连上（默认普通好友），目录照常交换，搬运走加密中转', async () => {
  const srv = createRelay(); await new Promise(r => srv.listen(0, '127.0.0.1', r)); const relay = `http://127.0.0.1:${srv.address().port}`;
  const mk = (name, catalog) => { const files = {}; let id = null; return createPeerHub({
    store: { read: (n, d) => structuredClone(files[n] ?? d), write: (n, v) => { files[n] = structuredClone(v); } },
    settings: () => ({ peers: { share: { requirements: true } } }), relay: () => relay, fetchImpl: fetch,
    getIdentity: () => id, setIdentity: v => { id = v; }, myName: () => name, myLook: () => ({}), onUpdate() {}, sprite() {}, say() {},
    visitor: { open() {}, send() {} }, catalog, search: async () => ({ answer: '', used: [] }) }); };
  const a = mk('同事甲', async () => []), b = mk('同事乙', async () => [{ id: 'requirements', kind: 'requirements', name: '需求池', items: [] }]);
  try {
    // A 在 Star 单聊里发了名片 → B 的 JM Desk 收到；B 回一条 → A 收到（这里直接调 adoptStar，消息收发由 main.mjs 的 starSync 负责）
    const ca = S.parsePair(S.pairText(a.myCard())), cb = S.parsePair(S.pairText(b.myCard()));
    await b.adoptStar({ starId: 1, name: '同事甲', ...ca }); await a.adoptStar({ starId: 2, name: '同事乙', ...cb });
    const pa = a.state().peers[0], pb = b.state().peers[0];
    assert.deepEqual([pa.starId, pa.tier, pb.starId], [2, 'basic', 1]);
    const t0 = Date.now(); while (!a.state().peers[0].catalog && Date.now() - t0 < 4000) await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(a.state().peers[0].catalog.sections.map(s => s.id), ['requirements'], '连上后自动拿到对方的目录');
    await a.adoptStar({ starId: 2, name: '同事乙', ...cb }); assert.equal(a.state().peers.length, 1, '同一个 Star 好友再收到名片不会重复');
  } finally { a.stop(); b.stop(); srv.close(); }
});
