import test from 'node:test';
import assert from 'node:assert/strict';
import { startLocalMcp, makeToken, clientConfig } from '../app/main/localmcp.mjs';

async function withServer(opts, fn) {
  const token = makeToken();
  const calls = [];
  const srv = await startLocalMcp({ token, getTools: () => opts.tools, confirm: opts.confirm || (async () => true), onCall: c => calls.push(c) });
  try { await fn({ srv, token, calls }); } finally { await srv.close(); }
}
const rpc = (srv, token, body, headers = {}) => fetch(srv.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });

const TOOLS = [
  { name: 'list_work', title: '查看工作台', write: false, inputSchema: { type: 'object', properties: {} }, handler: () => [{ id: 'w1', title: 'A' }] },
  { name: 'bind_work_mp2', title: '绑定平台记录', write: true, inputSchema: { type: 'object', properties: { work_id: { type: 'string' } }, required: ['work_id'] }, handler: a => ({ ok: true, id: a.work_id }) },
];

test('初始化、列工具、调只读工具', async () => {
  await withServer({ tools: TOOLS }, async ({ srv, token, calls }) => {
    const init = await (await rpc(srv, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json();
    assert.equal(init.result.serverInfo.name, 'JM Desk');
    assert.equal((await rpc(srv, token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const list = await (await rpc(srv, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    assert.deepEqual(list.result.tools.map(t => [t.name, t.annotations.readOnlyHint]), [['list_work', true], ['bind_work_mp2', false]]);
    const r = await (await rpc(srv, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_work', arguments: {} } })).json();
    assert.deepEqual(JSON.parse(r.result.content[0].text), [{ id: 'w1', title: 'A' }]);
    assert.deepEqual(calls, [{ tool: 'list_work', write: false, ok: true }]);
  });
});

test('写工具要确认；拒绝时返回错误、不执行', async () => {
  let asked = 0;
  await withServer({ tools: TOOLS, confirm: async () => { asked++; return false; } }, async ({ srv, token }) => {
    const r = await (await rpc(srv, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bind_work_mp2', arguments: { work_id: 'w1' } } })).json();
    assert.equal(r.result.isError, true);
    assert.equal(asked, 1);
    const missing = await (await rpc(srv, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bind_work_mp2', arguments: {} } })).json();
    assert.match(missing.result.content[0].text, /缺少参数：work_id/);
    assert.equal(asked, 1);
  });
});

test('令牌、Host、Origin 不对一律拒绝', async () => {
  await withServer({ tools: TOOLS }, async ({ srv, token }) => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    assert.equal((await rpc(srv, 'wrong', body)).status, 401);
    assert.equal((await rpc(srv, token, body, { Origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await rpc(srv, token, body, { Origin: 'http://127.0.0.1:5231' })).status, 200);
    const res = await new Promise(resolve => {
      import('node:http').then(({ request }) => {
        const u = new URL(srv.url);
        const req = request({ host: '127.0.0.1', port: u.port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example.com', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, resolve);
        req.end(JSON.stringify(body));
      });
    });
    assert.equal(res.statusCode, 403);
  });
});

test('客户端配置', () => {
  assert.deepEqual(clientConfig('http://127.0.0.1:1/mcp', 't'), { mcpServers: { 'jm-desk': { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } } } });
});
