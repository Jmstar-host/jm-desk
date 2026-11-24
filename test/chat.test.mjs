/* 对话工作台：多轮对话的 Agent 运行时、模型层的工具调用（原生 / JSON 约定）、会话存储。全部用假的模型和工具，不连真实服务。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as agent from '../app/main/agent.mjs';
import * as P from '../app/main/providers.mjs';
import { createThreads, titleOf } from '../app/main/threads.mjs';

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const tool = (id, { write = false, title = '', description = '', confirm = write } = {}) => {
  const [integ, name] = id.split('__');
  return { id, integ: { id: integ, name: integ + ' 平台' }, tool: { name, title, description, inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, write }, mode: confirm ? 'confirm' : 'auto', needsConfirm: () => confirm };
};
/* 假模型：按脚本一步步回，记下每次收到的请求 */
function scripted(plan) { const seen = []; const model = async req => { seen.push(structuredClone(req)); const next = plan.shift(); return typeof next === 'function' ? next(req) : next; }; return { model, seen }; }

test('一轮里连续调用多个工具，工具结果按调用 id 回给模型，最后给出回答', async () => {
  const tools = [tool('shop__get_order'), tool('shop__list_orders')];
  const { model, seen } = scripted([
    { text: '先查订单', toolCalls: [{ id: 'c1', name: 'shop__get_order', args: { id: 'A1' } }, { id: 'c2', name: 'shop__list_orders', args: {} }] },
    { text: 'A1 已发货，一共 2 单。', toolCalls: [] },
  ]);
  const calls = [], steps = [];
  const r = await agent.converse({ question: 'A1 到哪了', tools, model, call: async (t, a) => { calls.push([t.id, a]); return { text: t.id === 'shop__get_order' ? '{"status":"shipped"}' : '[1,2]' }; }, confirm: async () => true, onStep: s => steps.push(s.kind) });
  assert.equal(r.answer, 'A1 已发货，一共 2 单。');
  assert.deepEqual(calls, [['shop__get_order', { id: 'A1' }], ['shop__list_orders', {}]]);
  assert.deepEqual(r.used, ['shop__get_order', 'shop__list_orders']); assert.deepEqual(steps, ['call', 'call']);
  const second = seen[1].messages;
  assert.deepEqual(second.map(m => m.role), ['user', 'assistant', 'tool', 'tool']);
  assert.equal(second[2].id, 'c1'); assert.match(second[2].content, /shipped/); assert.equal(second[3].id, 'c2');
  assert.deepEqual(seen[0].tools.map(t => t.name), ['shop__get_order', 'shop__list_orders']);
});

test('带上之前几轮：模型看得到上一轮的问答；没完成的轮次也说明', async () => {
  const turns = [{ q: '我有哪些待办', a: '有 3 条。', steps: [{ kind: 'call', tool: 'jmdesk__list_todos' }] }, { q: '把第二条完成', error: '模型返回 500' }];
  const { model, seen } = scripted([{ text: '好的', toolCalls: [] }]);
  await agent.converse({ turns, question: '再试一次', tools: [], model, call: async () => ({ text: '' }), confirm: async () => true });
  const m = seen[0].messages;
  assert.deepEqual(m.map(x => x.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.match(m[1].content, /有 3 条。[\s\S]*jmdesk__list_todos/); assert.match(m[3].content, /没有完成：模型返回 500/); assert.equal(m[4].content, '再试一次');
});

test('历史太长时丢掉最早的轮次，并在系统提示里说明', () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({ q: `问题${i}` + 'x'.repeat(1500), a: `回答${i}` + 'y'.repeat(1500) }));
  const h = agent.historyMessages(turns, 9000);
  assert.ok(h.dropped > 0); assert.equal(h.messages.length, (12 - h.dropped) * 2);
  assert.match(h.messages.at(-1).content, /^回答11/);
  assert.match(agent.chatSystem({ dropped: h.dropped }), new RegExp(`更早的 ${h.dropped} 轮对话已省略`));
});

test('会改数据的工具先问人：拒绝后告诉模型不要再试，不调用', async () => {
  const tools = [tool('shop__cancel_order', { write: true })];
  const { model, seen } = scripted([{ text: '取消它', toolCalls: [{ id: 'c1', name: 'shop__cancel_order', args: { id: 'A1' } }] }, { text: '没有取消。', toolCalls: [] }]);
  let called = 0; const asked = [];
  const r = await agent.converse({ question: '取消 A1', tools, model, call: async () => { called++; return { text: 'ok' }; }, confirm: async req => { asked.push(req.tool); return false; } });
  assert.equal(called, 0); assert.deepEqual(asked, ['shop__cancel_order']); assert.equal(r.steps[0].kind, 'denied');
  assert.match(seen[1].messages.at(-1).content, /用户拒绝/);
});

test('不存在的工具、坏参数、重复调用都回给模型一句说明；步数用完时最后一步不给工具', async () => {
  const tools = [tool('x__get')];
  const same = { text: '', toolCalls: [{ id: 'c', name: 'x__get', args: { id: '1' } }] };
  const { model, seen } = scripted([{ text: '', toolCalls: [{ id: 'a', name: 'nope', args: {} }, { id: 'b', name: 'x__get', args: {}, badArgs: true }] }, same, same, same, { text: '结论', toolCalls: [] }]);
  let n = 0;
  const r = await agent.converse({ question: 'q', tools, model, maxSteps: 5, call: async () => { n++; return { text: 'same' }; }, confirm: async () => true });
  assert.equal(n, 2, '同样的调用最多两次'); assert.equal(r.answer, '结论');
  assert.deepEqual(r.steps.map(s => s.kind), ['error', 'error', 'call', 'call', 'error']);
  assert.deepEqual(seen[4].tools, []); assert.match(seen[4].system, /最后一步/);
});

test('工具很多时只列最相关的一部分；find_tools 找到的下一步可以调用', async () => {
  const tools = [...Array.from({ length: 50 }, (_, i) => tool(`erp__op_${i}`, { description: '杂项操作' })), tool('erp__refund_invoice', { title: '发票退款', description: '给一张发票退款' }), tool('crm__search_customer', { title: '搜索客户' })];
  const pick = agent.pickTools(tools, '搜索客户 张三', { max: 10, pinned: ['erp__op_49'] });
  assert.equal(pick.active.length, 10); assert.ok(pick.active.some(t => t.id === 'crm__search_customer')); assert.equal(pick.active[0].id, 'erp__op_49', '之前用过的保留');
  const { model, seen } = scripted([
    req => { assert.ok(req.tools.some(t => t.name === 'find_tools')); assert.ok(!req.tools.some(t => t.name === 'erp__refund_invoice')); assert.match(req.system, /只列出了[\s\S]*10 个工具（一共 52 个）/); return { text: '', toolCalls: [{ id: 'f', name: 'find_tools', args: { query: '发票 退款' } }] }; },
    req => { assert.ok(req.tools.some(t => t.name === 'erp__refund_invoice')); return { text: '', toolCalls: [{ id: 'g', name: 'erp__refund_invoice', args: { id: 'I9' } }] }; },
    { text: '已退款', toolCalls: [] },
  ]);
  const r = await agent.converse({ question: '搜索客户 张三', tools, model, maxTools: 10, call: async t => ({ text: 'done ' + t.id }), confirm: async () => true });
  assert.equal(r.answer, '已退款'); assert.deepEqual(r.steps.map(s => s.kind), ['find', 'call']); assert.match(seen[1].messages.at(-1).content, /erp__refund_invoice/);
});

test('停止：正在进行的一轮在下一步之前结束，标记为已停止', async () => {
  const ac = new AbortController();
  const { model } = scripted([{ text: '', toolCalls: [{ id: 'c', name: 'x__get', args: {} }] }, { text: '不该到这里', toolCalls: [] }]);
  const r = await agent.converse({ question: 'q', tools: [tool('x__get')], model, signal: ac.signal, call: async () => { ac.abort(); return { text: 'r' }; }, confirm: async () => true });
  assert.equal(r.stopped, true); assert.equal(r.steps.length, 1);
});

test('工具 id 转成模型接口能接受的函数名：只含字母数字下划线和连字符，不重名', () => {
  const names = [...agent.fnNames([{ id: 'kb__knowledge.search' }, { id: 'kb__knowledge/search' }, { id: 'a__' + 'x'.repeat(90) }]).keys()];
  assert.equal(new Set(names).size, 3); for (const n of names) assert.match(n, /^[A-Za-z0-9_-]{1,64}$/);
});

/* ---------- 模型层 ---------- */
function fakeOpenAI(handler) {
  const reqs = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { const j = JSON.parse(b); reqs.push(j); const [status, body] = handler(j, reqs.length); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }); });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/v1`, reqs, close: () => srv.close() })));
}
const routerFor = (settings, extra = {}) => P.createRouter({ getSettings: () => settings, getKey: () => 'k', usage: P.makeUsage(path.join(tmp('jmdesk-chat-'), 'usage.jsonl')), ...extra });
const TOOLS = [{ name: 'shop__get_order', description: '查订单', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }];

test('OpenAI 兼容接口：原生工具调用，往返消息格式正确，记下真实用量', async () => {
  const srv = await fakeOpenAI(() => [200, { choices: [{ message: { content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'shop__get_order', arguments: '{"id":"A1"}' } }] } }], usage: { prompt_tokens: 120, completion_tokens: 15 } }]);
  try {
    const router = routerFor({ providers: [{ id: 'm', name: 'M', kind: 'api', baseUrl: srv.url, model: 'x' }] });
    const r = await router.converse({ system: 'S', tools: TOOLS, messages: [{ role: 'user', content: 'A1?' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'shop__get_order', args: { id: 'A0' } }] }, { role: 'tool', id: 'c0', name: 'shop__get_order', content: '{}' }] });
    assert.equal(r.native, true); assert.deepEqual(r.toolCalls, [{ id: 'call_9', name: 'shop__get_order', args: { id: 'A1' } }]); assert.equal(r.usage.in, 120);
    const sent = srv.reqs[0];
    assert.equal(sent.tools[0].function.name, 'shop__get_order'); assert.equal(sent.response_format, undefined);
    assert.deepEqual(sent.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool']);
    assert.equal(sent.messages[2].tool_calls[0].function.arguments, '{"id":"A0"}'); assert.equal(sent.messages[3].tool_call_id, 'c0');
  } finally { srv.close(); }
});

test('接口不支持 tools：这一次改走 JSON 约定，并记住以后不再带 tools', async () => {
  const srv = await fakeOpenAI(j => j.tools ? [400, { error: { message: 'tools is not supported by this model' } }] : [200, { choices: [{ message: { content: '{"tool":"shop__get_order","args":{"id":"A1"},"why":"查订单"}' } }] }]);
  try {
    const router = routerFor({ providers: [{ id: 'm', name: 'M', kind: 'api', baseUrl: srv.url, model: 'x' }] });
    const r = await router.converse({ system: 'S', tools: TOOLS, messages: [{ role: 'user', content: 'A1?' }] });
    assert.equal(r.native, false); assert.equal(r.toolCalls[0].name, 'shop__get_order'); assert.deepEqual(r.toolCalls[0].args, { id: 'A1' });
    assert.match(srv.reqs[1].messages[0].content, /可用工具：[\s\S]*shop__get_order[\s\S]*必填：id/); assert.match(srv.reqs[1].messages[1].content, /用户：A1\?/);
    await router.converse({ system: 'S', tools: TOOLS, messages: [{ role: 'user', content: '再来' }] });
    assert.equal(srv.reqs.length, 3, '第二次直接走 JSON 约定'); assert.equal(srv.reqs[2].tools, undefined);
  } finally { srv.close(); }
});

test('本机 Claude Code / Codex 走 JSON 约定；没按约定输出时整段当回答；前一个出错换下一个', async () => {
  const callers = { claude: async () => { throw new Error('还没登录'); }, codex: async (_p, sys, user) => ({ text: /工具 shop__get_order 返回/.test(user) ? '订单已发货。' : '{"tool":"shop__get_order","args":{"id":"A1"}}' }) };
  const router = routerFor({ providers: [{ id: 'cl', name: 'Claude', kind: 'claude' }, { id: 'cx', name: 'Codex', kind: 'codex' }] }, { callers });
  const a = await router.converse({ system: 'S', tools: TOOLS, messages: [{ role: 'user', content: 'A1?' }] });
  assert.equal(a.provider, 'cx'); assert.equal(a.toolCalls[0].name, 'shop__get_order'); assert.equal(a.usage.est, true);
  const b = await router.converse({ system: 'S', tools: TOOLS, messages: [{ role: 'user', content: 'A1?' }, { role: 'assistant', content: '', toolCalls: a.toolCalls }, { role: 'tool', id: a.toolCalls[0].id, name: 'shop__get_order', content: 'shipped' }] });
  assert.equal(b.text, '订单已发货。'); assert.deepEqual(b.toolCalls, []);
  await assert.rejects(routerFor({ providers: [{ id: 'cl', name: 'Claude', kind: 'claude' }] }, { callers }).converse({ system: 'S', messages: [] }), /Claude：还没登录/);
});

/* ---------- 会话存储 ---------- */
test('会话：新建、追加轮次（首轮自动起标题）、改名、改工具范围、列表按最近排序、删除', () => {
  const th = createThreads(path.join(tmp('jmdesk-threads-'), 'threads'));
  const a = th.create(), b = th.create({ scope: { integrations: ['mp2', 'bad id!', 'mp2'] } });
  assert.deepEqual(b.scope, { integrations: ['mp2'] }); assert.deepEqual(a.scope, { integrations: null });
  const r = th.appendTurn(a.id, { q: '我还有哪些需求跟进的待办？请按截止时间排一下', a: '有 3 条。', steps: [{ kind: 'call', tool: 'jmdesk__list_todos', args: {}, ok: true, result: 'x'.repeat(5000), ms: 12 }], used: ['jmdesk__list_todos'], provider: 'ds', ms: 900 });
  assert.equal(r.thread.title, titleOf('我还有哪些需求跟进的待办？请按截止时间排一下')); assert.ok([...r.thread.title].length <= 25);
  assert.ok(th.get(a.id).turns[0].steps[0].result.length <= 2001, '工具返回只存片段');
  th.appendTurn(a.id, { q: '第二个', error: '模型返回 500' });
  assert.equal(th.get(a.id).turns.length, 2); assert.equal(th.list()[0].id, a.id); assert.equal(th.list()[0].turns, 2);
  assert.equal(th.rename(b.id, '  对账  ').title, '对账'); assert.deepEqual(th.setScope(b.id, { integrations: null }).scope, { integrations: null });
  th.remove(b.id); assert.equal(th.list().length, 1);
  assert.throws(() => th.get('../../etc/passwd'), /没有这个对话/); assert.throws(() => th.get(b.id), /没有这个对话/);
});

test('会话文件只有本人可读写（0600）', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp('jmdesk-threads-'), 'threads'), th = createThreads(dir), t = th.create();
  assert.equal(fs.statSync(path.join(dir, t.id + '.json')).mode & 0o777, 0o600);
});
