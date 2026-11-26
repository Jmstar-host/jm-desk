/* 搬运（串门）调度：加好友后程序自动交换「可搬运目录」；出门必须先选范围；对方只在这个范围里找；旧版本好友照旧。
 * 两个调度器经本机的假中转互通，不连真实服务。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../relay/server.mjs';
import { createPeerHub } from '../app/main/peerhub.mjs';
import * as P from '../app/main/peers.mjs';

const until = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('等不到：' + fn); await new Promise(r => setTimeout(r, 30)); } };
function desk(relay, name, { catalog, search } = {}) {
  const files = {}, log = { opened: [], searched: [], said: [] }; let id = null;
  const hub = createPeerHub({
    store: { read: (n, d) => structuredClone(files[n] ?? d), write: (n, v) => { files[n] = structuredClone(v); } },
    settings: () => ({ peers: { share: { knowledge: true, requirements: true } } }), relay: () => relay, fetchImpl: fetch,
    getIdentity: () => id, setIdentity: v => { id = v; }, myName: () => name, myLook: () => ({}), onUpdate() {}, sprite() {}, say: (t, s) => log.said.push([t, s]),
    visitor: { open: v => log.opened.push(v), send() {} },
    catalog, search: async v => { log.searched.push(v); return search ? search(v) : { answer: '', used: [] }; },
  });
  return { hub, log, files };
}
const CAT = [{ id: 'k:kb', kind: 'knowledge', name: '公司知识库', items: [{ id: 'orders', label: 'orders' }, { id: 'billing', label: 'billing' }] }, { id: 'requirements', kind: 'requirements', name: '需求池', items: [{ id: 'p1', label: '绑定流程改造', note: '3 条需求' }] }];
async function pair(a, b) {
  const { pending } = await a.hub.offer(); await b.hub.claim(pending.code);
  await until(() => a.hub.state().pending?.peer);
  await a.hub.confirm(); await b.hub.confirm();
  return [a.hub.state().peers[0].id, b.hub.state().peers[0].id];
}

test('加好友后程序自动交换目录；出门必须选范围；对方只收到这个范围，结果带回来', async () => {
  const srv = createRelay(); await new Promise(r => srv.listen(0, '127.0.0.1', r)); const relay = `http://127.0.0.1:${srv.address().port}`;
  const a = desk(relay, '小王', { catalog: async () => [] }), b = desk(relay, '小李', { catalog: async () => CAT, search: async v => ({ answer: `在 ${v.scope.label} 里找到：先查 EID 是否绑定`, used: ['kb__knowledge_search'] }) });
  try {
    const [bId] = await pair(a, b);
    const cat = await until(() => a.hub.state().peers[0].catalog);   // 没有人点任何按钮，目录自己到了
    assert.deepEqual(cat.sections.map(s => [s.id, s.items.length]), [['k:kb', 2], ['requirements', 1]]);
    assert.deepEqual((await until(() => b.hub.state().peers[0].catalog)).sections, [], 'A 没有开放内容时目录是空的');
    await assert.rejects(b.hub.visit(b.hub.state().peers[0].id, '找点东西'), /对方现在没有开放可以找的内容/);
    await assert.rejects(a.hub.visit(bId, '绑定失败怎么排查'), /先选要去哪一块找：公司知识库、需求池/);
    await assert.rejects(a.hub.visit(bId, '绑定失败怎么排查', { section: 'k:kb', item: 'not-there' }), /先选要去哪一块找/);
    await a.hub.visit(bId, '绑定失败怎么排查', { section: 'k:kb', item: 'orders' });
    const guest = await until(() => b.hub.state().guests[0]);
    assert.equal(guest.scope, '公司知识库 › orders'); assert.equal(b.log.opened[0].scope, '公司知识库 › orders', '访客窗口写明要搬哪一块'); assert.equal(b.log.opened[0].ask, '绑定失败怎么排查');
    await b.hub.decide(guest.id, true);
    assert.deepEqual(b.log.searched[0].scope, { section: 'k:kb', item: 'orders', label: '公司知识库 › orders' });
    const trip = await until(() => a.hub.state().trips.find(t => t.status === 'done'));
    assert.equal(trip.result.status, 'ok'); assert.match(trip.result.answer, /在 公司知识库 › orders 里找到/);
    assert.equal(a.hub.state().history[0].scope, '公司知识库 › orders'); assert.equal(b.hub.state().history[0].scope, '公司知识库 › orders');
  } finally { a.hub.stop(); b.hub.stop(); srv.closeAllConnections(); srv.close(); }
});

test('对方是旧版本（不认目录消息）：拿不到目录，仍然可以按老办法整体找', async () => {
  const srv = createRelay(); await new Promise(r => srv.listen(0, '127.0.0.1', r)); const relay = `http://127.0.0.1:${srv.address().port}`;
  const a = desk(relay, '小王'), old = desk(relay, '老版本', { search: async () => ({ answer: '找到了', used: [] }) }); // 没有 catalog()：等同旧版本不回目录
  try {
    const [oId] = await pair(a, old);
    await a.hub.askCatalog(oId, { force: true }); await new Promise(r => setTimeout(r, 300));
    assert.equal(a.hub.state().peers[0].catalog, null);
    await a.hub.visit(oId, '随便找找');
    const guest = await until(() => old.hub.state().guests[0]); assert.equal(guest.scope, '');
    await old.hub.decide(guest.id, true);
    assert.equal(old.log.searched[0].scope, null);
    await until(() => a.hub.state().trips.find(t => t.status === 'done' && t.result.status === 'ok'));
  } finally { a.hub.stop(); old.hub.stop(); srv.closeAllConnections(); srv.close(); }
});

test('目录与范围：知识库目录认平台列表；目录内容会被截断清洗；按词筛选不用模型', () => {
  assert.deepEqual(P.catalogItems('{"status":"ok","platforms":[{"platform":"orders","entity_count":19},{"platform":"billing"}]}'), [{ id: 'orders', label: 'orders' }, { id: 'billing', label: 'billing' }]);
  assert.deepEqual(P.catalogItems('说明文字 ["a","b"]'), [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }]); assert.deepEqual(P.catalogItems('不是 JSON'), []);
  const c = P.cleanCatalog([{ id: 'k:kb', kind: 'weird', name: 'x'.repeat(80), items: Array.from({ length: 300 }, (_, i) => ({ id: 'p' + i, label: '名'.repeat(90) })) }, { id: '../etc', name: '坏的' }, null]);
  assert.equal(c.length, 1); assert.equal(c[0].kind, 'knowledge'); assert.equal(c[0].name.length, 30); assert.equal(c[0].items.length, 120); assert.equal(c[0].items[0].label.length, 40);
  const hit = P.findScope(CAT, { section: 'requirements', item: 'p1' }); assert.equal(P.scopeLabel(hit), '需求池 › 绑定流程改造');
  assert.equal(P.scopeLabel(P.findScope(CAT, { section: 'k:kb' })), '公司知识库'); assert.equal(P.findScope(CAT, { section: 'todos' }), null);
  const rows = [{ title: '绑定失败提示优化' }, { title: '订单导出' }, { title: '绑定流程埋点' }];
  assert.deepEqual(P.matchRows(rows, '绑定 失败').map(r => r.title), ['绑定失败提示优化', '绑定流程埋点']); assert.deepEqual(P.matchRows(rows, '发票'), []);
});

/* 1.10.2：两边都能叫停 */
test('请它回去 / 对方叫回：在门口等和正在找的时候都能停，被叫停后不再发结果', async () => {
  const { createPeerHub } = await import('../app/main/peerhub.mjs');
  const PP = await import('../app/main/peers.mjs'), other = PP.newIdentity();
  const events = [], peer = { id: other.box.slice(0, 12), box: other.box, pub: other.pub, name: '乙', status: 'paired', trust: 'ask', tier: 'basic' }, files = { 'peers.json': [peer] };
  let identity = null, finish = null;
  const hub = createPeerHub({ store: { read: (f, d) => files[f] ?? d, write: (f, v) => { files[f] = v; } }, getIdentity: () => identity, setIdentity: v => { identity = v; },
    settings: () => ({ peers: { share: { requirements: true } } }), relay: () => 'https://relay.example.test', fetchImpl: async () => { throw new Error('测试里不联网'); }, myName: () => '甲', myLook: () => ({}), onUpdate() {}, sprite() {}, say() {},
    visitor: { open: v => events.push('open:' + v.id), send: (id, m) => events.push(`${m.type}:${m.carry ? '带着' : '空手'}`), close() {} }, search: () => new Promise(r => { finish = r; }), catalog: async () => [] });
  const come = id => hub._handle([{ peer, msg: { type: 'visit', id, ask: '找回调配置的资料', name: '乙' } }]), tick = () => new Promise(r => setTimeout(r, 5));
  // 在门口等的时候，主人请它回去
  come('v1'); await tick(); assert.deepEqual(hub.state().guests.map(g => [g.id, g.status]), [['v1', 'arrived']]);
  hub.dismiss('v1'); assert.equal(hub.state().guests.length, 0); assert.equal(events.at(-1), 'leave:空手');
  // 正在找的时候，对方把精灵叫回去：访客离开，找完的结果不再发
  come('v2'); await tick(); const p = hub.decide('v2', true); await tick(); assert.equal(hub.state().guests[0].status, 'searching');
  hub._handle([{ peer, msg: { type: 'visit-cancel', id: 'v2' } }]); assert.equal(hub.state().guests.length, 0);
  const before = events.length; finish({ answer: '找到了' }); await p; assert.equal(events.length, before, '被叫停后不再让访客「带着」离开');
  assert.deepEqual(hub.state().history.slice(0, 2).map(h => [h.status, h.note]), [['recalled', '对方把精灵叫回去了'], ['denied', '主人请它先回去了']]);
  // 别人的精灵不能被第三方叫走；不存在的编号不报错
  come('v3'); await tick(); hub._handle([{ peer: { ...peer, box: 'C'.repeat(64) }, msg: { type: 'visit-cancel', id: 'v3' } }]); assert.equal(hub.state().guests.length, 1);
  assert.doesNotThrow(() => { hub.recall('nope'); hub.dismiss('nope'); }); hub.dismiss('v3'); hub.stop();
});
