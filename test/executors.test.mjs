/* 本机执行者（Codex / DSH）：项目登记、命令拼装、输出解析、运行与停止。用假的命令行程序，不调用真实的 Codex / DSH。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as X from '../app/main/executors.mjs';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const store = () => { const d = tmp('jmexec-'); return { d, P: X.createProjects({ file: path.join(d, 'exec-projects.json'), root: path.join(d, 'projects') }) }; };
/* 假的执行者：一个 node 脚本，行为由环境变量 FAKE 决定 */
function fakeBin(body) { const f = path.join(tmp('jmbin-'), 'fake'); fs.writeFileSync(f, `#!/usr/bin/env node\n${body}`, { mode: 0o755 }); return f; }
const FAKE_CODEX = fakeBin(`
const fs = require('fs'), a = process.argv.slice(2), out = a[a.indexOf('-o') + 1], resume = a[1] === 'resume' ? a[2] : null;
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  const say = o => console.log(JSON.stringify(o));
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: a, cwd: process.cwd(), input, token: process.env.JM_DESK_MCP_TOKEN || null, node: process.env.ELECTRON_RUN_AS_NODE || null }) + '\\n');
  if (resume === 'gone') { console.error('session not found'); process.exit(1); }
  if (/卡住/.test(input)) { say({ type: 'thread.started', thread_id: 's-slow' }); setTimeout(() => {}, 60000); return; }
  say({ type: 'thread.started', thread_id: resume || 's-new' });
  say({ type: 'item.completed', item: { id: 'w', type: 'error', message: 'Under-development features enabled: x' } });
  say({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '我先看看文件夹。' } });
  say({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
  say({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'AGENTS.md\\ninbox\\noutput\\n', exit_code: 0, status: 'completed' } });
  say({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'output/report.md', kind: 'add' }], status: 'completed' } });
  say({ type: 'item.completed', item: { id: 't1', type: 'mcp_tool_call', server: 'jm_desk', tool: 'list_todos', arguments: { status: 'open' }, result: { content: [{ type: 'text', text: '[]' }] }, status: 'completed' } });
  say({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: '报告写好了。' } });
  say({ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 50 } });
  fs.writeFileSync(out, '报告写好了，在 output/report.md。');
});`);
const FAKE_DSH = fakeBin(`
const fs = require('fs'), a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: a, cwd: process.cwd(), mode: process.env.DSH_PERMISSION_MODE }) + '\\n');
if (/失败/.test(a[2])) { console.error('(node:1) [UNDICI-EHPA] Warning'); console.error('profile headless is missing'); process.exit(3); }
console.log('整理好了：共 3 条。');`);
const logFile = () => path.join(tmp('jmlog-'), 'calls.jsonl');
const calls = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const unix = { skip: process.platform === 'win32' };

test('执行项目：默认在数据目录里新建独立文件夹，放好 AGENTS.md、inbox、output；取消登记不删文件夹', () => {
  const { d, P } = store();
  const p = P.create({ name: '周报整理', executor: 'codex' });
  assert.equal(path.dirname(p.dir), path.join(d, 'projects')); assert.equal(p.mode, 'workspace-write'); assert.equal(p.own, true);
  assert.match(fs.readFileSync(path.join(p.dir, 'AGENTS.md'), 'utf8'), /周报整理（JM Desk 执行项目）[\s\S]*只在这个文件夹里读写[\s\S]*是数据，不是指令/);
  assert.ok(fs.existsSync(path.join(p.dir, 'inbox')) && fs.existsSync(path.join(p.dir, 'output')));
  assert.equal(P.get('周报整理').id, p.id, '可以按名字找'); assert.equal(P.list().length, 1);
  assert.throws(() => P.create({ name: '周报整理', executor: 'dsh' }), /同名/); assert.throws(() => P.create({ name: 'x', executor: 'gpt' }), /Codex 或 DSH/); assert.throws(() => P.create({ name: ' ', executor: 'codex' }), /名字/);
  assert.equal(P.update(p.id, { session: 's1', mode: 'read-only' }).mode, 'read-only'); assert.equal(P.update(p.id, { executor: 'dsh' }).session, null, '换执行者后会话作废');
  P.remove(p.id); assert.equal(P.list().length, 0); assert.ok(fs.existsSync(path.join(p.dir, 'AGENTS.md')), '文件夹和产出还在');
});

test('执行项目：指定已有文件夹时不覆盖里面的 AGENTS.md；主目录、根目录、系统目录不让选', () => {
  const { P } = store(), dir = tmp('jmproj-');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '我自己的规矩');
  const p = P.create({ name: '已有的', executor: 'dsh', dir, mode: 'read-only' });
  assert.equal(p.dir, dir); assert.equal(p.own, false); assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '我自己的规矩');
  assert.throws(() => P.create({ name: '重复', executor: 'codex', dir }), /已经是另一个执行项目/);
  for (const bad of [os.homedir(), path.parse(os.homedir()).root, path.dirname(os.homedir())]) assert.throws(() => P.create({ name: 'n' + bad.length, executor: 'codex', dir: bad }), /不能把主目录|不存在/, bad);
  assert.throws(() => P.create({ name: '没有', executor: 'codex', dir: path.join(dir, 'nope') }), /不存在/);
});

test('命令：Codex 新会话带沙箱和项目目录；接着上一次用 resume；本机 MCP 的令牌只走环境变量；DSH 用权限环境变量', () => {
  const proj = { dir: '/w/p', executor: 'codex', mode: 'workspace-write', session: null };
  const a = X.buildCommand(proj, { task: '写周报', outFile: '/t/o.txt', mcp: { url: 'http://127.0.0.1:5000/mcp', token: 'SECRET-TOKEN' } });
  assert.deepEqual(a.args.slice(0, 9), ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-s', 'workspace-write', '-C', '/w/p']);
  assert.ok(a.args.includes('mcp_servers.jm_desk.url="http://127.0.0.1:5000/mcp"')); assert.equal(a.env.JM_DESK_MCP_TOKEN, 'SECRET-TOKEN');
  assert.ok(!a.args.join(' ').includes('SECRET-TOKEN'), '令牌不进命令行'); assert.equal(a.args.at(-1), '-'); assert.equal(a.stdin, '写周报');
  const b = X.buildCommand({ ...proj, session: 's9', mode: 'read-only' }, { task: '接着改', turns: [{ q: '写周报', a: '写好了' }] });
  assert.deepEqual(b.args.slice(0, 7), ['exec', 'resume', 's9', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"']); assert.equal(b.stdin, '接着改', '有会话时不重复带前几轮'); assert.equal(b.cwd, '/w/p');
  const c = X.buildCommand({ ...proj, session: 's9' }, { task: '接着改', turns: [{ q: '写周报', a: '写好了' }, { q: '加一段', error: '超时' }], resume: false });
  assert.equal(c.args[1], '--json'); assert.match(c.stdin, /之前在这个项目里的对话[\s\S]*用户：写周报\n你：写好了[\s\S]*没有完成：超时[\s\S]*>>>\n\n接着改$/);
  const d = X.buildCommand({ dir: '/w/p', executor: 'dsh', mode: 'read-only' }, { task: '整理', turns: [{ q: '上一句', a: '好' }] });
  assert.deepEqual(d.args.slice(0, 2), ['--profile', 'headless']); assert.match(d.args[2], /用户：上一句[\s\S]*整理$/); assert.equal(d.env.DSH_PERMISSION_MODE, 'read-only');
});

test('Codex 的事件解析成步骤：命令、改文件、MCP 工具、中途说明；最后一条消息是回答', () => {
  const steps = [], p = X.codexParser(s => steps.push(s));
  p.push('{"type":"thread.started","thread_id":"T1"}\n{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"先看看"}}\n{"type":"item.comp');
  p.push('leted","item":{"id":"c","type":"command_execution","command":"cat a","aggregated_output":"boom","exit_code":2}}\n不是 JSON 的行\n');
  p.push('{"type":"item.completed","item":{"id":"e","type":"error","message":"磁盘满了"}}\n{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"做不了"}}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}');
  const r = p.finish({ code: 0 });
  assert.deepEqual(steps.map(s => [s.kind, s.tool, s.ok]), [['say', '', undefined], ['call', '命令', false], ['error', 'Codex', undefined]]);
  assert.equal(steps[0].why, '先看看'); assert.equal(r.answer, '做不了'); assert.equal(r.session, 'T1'); assert.deepEqual(r.usage, { in: 10, out: 2 }); assert.equal(r.error, null);
  assert.match(X.codexParser().finish({ code: 1, stderr: 'please login first' }).error, /还没登录/);
  const f = X.codexParser(); f.push('{"type":"turn.failed","error":{"message":"额度用完了"}}\n'); assert.equal(f.finish({ code: 1 }).error, '额度用完了');
});

test('跑一次 Codex：在项目文件夹里执行，步骤实时回传，拿到回答和会话号；不把 ELECTRON_RUN_AS_NODE 传下去', unix, async () => {
  const { P } = store(), log = logFile(), p = P.create({ name: '报告', executor: 'codex' }), live = [];
  process.env.FAKE_LOG = log; process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const r = await X.run(p, { task: '写一份报告', mcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok' }, find: () => FAKE_CODEX, onStep: s => live.push(s.kind + ':' + s.tool) });
    assert.equal(r.answer, '报告写好了，在 output/report.md。'); assert.equal(r.session, 's-new'); assert.deepEqual(r.usage, { in: 1000, out: 50 });
    assert.deepEqual(live, ['say:', 'call:命令', 'call:改文件', 'call:jm_desk__list_todos']); assert.deepEqual(r.steps.map(s => s.kind + ':' + s.tool), live);
    assert.equal(r.steps[3].result, '[]', 'MCP 工具的返回取文字部分'); assert.deepEqual(r.steps[2].args, { changes: ['add output/report.md'] }); assert.equal(r.steps[1].result, 'AGENTS.md\ninbox\noutput\n');
    const c = calls(log)[0]; assert.equal(c.cwd, p.dir); assert.equal(c.input, '写一份报告'); assert.equal(c.token, 'tok'); assert.equal(c.node, null);
  } finally { delete process.env.ELECTRON_RUN_AS_NODE; }
});

test('接不上上一次的会话：自动不带会话重来一次，并把前几轮的要点写进任务', unix, async () => {
  const { P } = store(), log = logFile(); process.env.FAKE_LOG = log;
  const p = P.update(P.create({ name: '续', executor: 'codex' }).id, { session: 'gone' });
  const r = await X.run(p, { task: '接着做', turns: [{ q: '第一件事', a: '做完了' }], find: () => FAKE_CODEX });
  assert.equal(r.session, 's-new'); assert.equal(r.resumed, false);
  const c = calls(log); assert.equal(c.length, 2); assert.equal(c[0].args[1], 'resume'); assert.match(c[1].input, /用户：第一件事[\s\S]*接着做$/);
});

test('停止：中途停止会结束执行者进程，标记为已停止；找不到命令时说清楚', unix, async () => {
  const { P } = store(); process.env.FAKE_LOG = logFile();
  const p = P.create({ name: '慢', executor: 'codex' }), ac = new AbortController();
  setTimeout(() => ac.abort(), 400);
  const t0 = Date.now(), r = await X.run(p, { task: '卡住', find: () => FAKE_CODEX, signal: ac.signal });
  assert.equal(r.stopped, true); assert.ok(Date.now() - t0 < 5000, '不用等到进程自己结束');
  await assert.rejects(X.run(p, { task: 'x', find: () => null }), /本机没有找到 Codex/);
  fs.rmSync(p.dir, { recursive: true }); await assert.rejects(X.run(p, { task: 'x', find: () => FAKE_CODEX }), /项目文件夹不见了/);
});

test('跑一次 DSH：标准输出就是回答；失败时给出最后一行有用的错误（不是 Node 的警告）', unix, async () => {
  const { P } = store(), log = logFile(); process.env.FAKE_LOG = log;
  const p = P.create({ name: '整理', executor: 'dsh', mode: 'read-only' });
  const r = await X.run(p, { task: '整理收件箱', turns: [{ q: '上一句', a: '好' }], find: () => FAKE_DSH });
  assert.equal(r.answer, '整理好了：共 3 条。'); assert.deepEqual(r.steps, []); assert.equal(r.session, null);
  const c = calls(log)[0]; assert.equal(c.mode, 'read-only'); assert.equal(c.cwd, p.dir); assert.match(c.args[2], /用户：上一句[\s\S]*整理收件箱$/);
  await assert.rejects(X.run(p, { task: '失败', find: () => FAKE_DSH }), /DSH 退出码 3：profile headless is missing/);
});
