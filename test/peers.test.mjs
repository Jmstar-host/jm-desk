/* 串门：中转（结伴码、信箱、长轮询）与端到端加密。全部在本机跑。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../relay/server.mjs';
import * as P from '../app/main/peers.mjs';

const start = () => new Promise(r => { const s = createRelay(); s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}`, close: () => { s.closeAllConnections(); s.close(); } })); });

test('结伴：A 申请结伴码，B 认领；双方拿到对方公钥，暗号一致；码只能用一次', async () => {
  const srv = await start();
  try {
    const A = P.newIdentity(), B = P.newIdentity(), c = P.createClient({ relay: srv.url });
    const { code } = await c.offer(A, '小 A'); assert.match(code, /^\d{6}$/);
    const got = await c.claim(B, '小 B', code.slice(0, 3) + '-' + code.slice(3));
    assert.equal(got.pub, A.pub); assert.equal(got.name, '小 A');
    await assert.rejects(c.claim(P.newIdentity(), 'C', code), /好友码不对/);
    const inbox = await c.poll(A, 0); const u = P.unpack(A, inbox.messages, [], [{ box: '?' }]);
    assert.equal(u[0].kind, 'pair-claimed'); assert.equal(u[0].pub, B.pub); assert.equal(u[0].name, '小 B');
    assert.deepEqual(P.fingerprint(A.pub, B.pub), P.fingerprint(B.pub, A.pub));
  } finally { srv.close(); }
});

test('收发：密文经中转送达，只有伙伴能解开；长轮询有信即返回；别人取不走信', async () => {
  const srv = await start();
  try {
    const A = P.newIdentity(), B = P.newIdentity(), E = P.newIdentity(), c = P.createClient({ relay: srv.url });
    const pa = { box: A.box, pub: A.pub, name: 'A' }, pb = { box: B.box, pub: B.pub, name: 'B' };
    const t0 = Date.now(), waiting = c.poll(B, 5);
    await new Promise(r => setTimeout(r, 200));
    await c.send(A, pb, { type: 'visit', id: 'v1', ask: '找一下 eIM 绑定的资料' });
    const r = await waiting; assert.ok(Date.now() - t0 < 3000, '有信立即返回');
    assert.equal((await c.poll(E, 0)).messages.length, 0, '别人的钥匙取不到 B 的信');
    const u = P.unpack(B, r.messages, [pa]);
    assert.deepEqual(u.map(x => [x.kind, x.peer.name, x.msg.ask]), [['msg', 'A', '找一下 eIM 绑定的资料']]);
    assert.equal(P.unpack(B, r.messages, []).length, 0, '不是伙伴的信直接丢弃');
    const tampered = r.messages.map(m => ({ ...m, data: m.data.slice(0, -4) + (m.data.endsWith('AAAA') ? 'BBBB' : 'AAAA') }));
    assert.equal(P.unpack(B, tampered, [pa]).length, 0, '被篡改的信解不开');
    assert.equal(P.unpack(E, r.messages, [pa]).length, 0, '第三方即使知道 A 的公钥也解不开');
  } finally { srv.close(); }
});

test('中转地址只接受 https 或本机；访客范围只给只读工具，邮件聊天永不开放', () => {
  assert.equal(P.relayUrl('https://k.example.com/relay/'), 'https://k.example.com/relay');
  assert.equal(P.relayUrl('http://example.com'), null); assert.equal(P.relayUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  const kb = { integ: { id: 'kb', knowledge: true }, tool: { name: 'knowledge_search', write: false } }, kbw = { integ: { id: 'kb', knowledge: true }, tool: { name: 'knowledge_submit', write: true } };
  const req = { integ: { id: 'jmdesk' }, tool: { name: 'list_requirements' } }, clue = { integ: { id: 'jmdesk' }, tool: { name: 'get_clue' } }, todo = { integ: { id: 'jmdesk' }, tool: { name: 'add_todo' } }, other = { integ: { id: 'gitlab' }, tool: { name: 'list', write: false } };
  const all = [kb, kbw, req, clue, todo, other];
  assert.deepEqual(P.scopeTools(all, { knowledge: true }).map(t => t.tool.name), ['knowledge_search']);
  assert.deepEqual(P.scopeTools(all, { knowledge: true, requirements: true, todos: true }).map(t => t.tool.name), ['knowledge_search', 'list_requirements']);
  assert.deepEqual(P.scopeTools(all, {}), []);
});
