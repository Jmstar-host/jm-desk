/* 模型来源与 token 政策：按任务顺序回退、每日额度、隐私只用本机、旧配置迁移。全部用假的调用，不连真实模型。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as P from '../app/main/providers.mjs';

const usageFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jmdesk-usage-')), 'usage.jsonl');
function setup(settings, behave) {
  const calls = [], usage = P.makeUsage(usageFile());
  const fake = kind => async p => { calls.push(p.id); const b = behave[p.id]; if (b instanceof Error) throw b; return { text: JSON.stringify({ from: p.id }), in: b?.in, out: b?.out }; };
  const router = P.createRouter({ getSettings: () => settings, getKey: () => '', usage, callers: { api: fake('api'), claude: fake('claude'), codex: fake('codex'), cmd: fake('cmd') } });
  return { router, calls, usage };
}
const S = (o = {}) => ({ providers: [
  { id: 'ds', name: 'DeepSeek', kind: 'api', baseUrl: 'https://api.deepseek.com' },
  { id: 'cl', name: 'Claude', kind: 'claude' },
  { id: 'ol', name: 'Ollama', kind: 'api', baseUrl: 'http://127.0.0.1:11434/v1' },
], modelRouting: {}, modelPolicy: {}, ...o });

test('按顺序尝试：前一个出错就换下一个，记下真实用量', async () => {
  const { router, calls, usage } = setup(S(), { ds: new Error('Key 不对'), cl: { in: 1200, out: 80 } });
  const r = await router.chat('sys', 'user', { task: 'summary' });
  assert.deepEqual(r.data, { from: 'cl' }); assert.deepEqual(calls, ['ds', 'cl']);
  assert.equal(usage.usedToday('cl'), 1280); assert.equal(usage.summary().cl.calls, 1);
});

test('按任务指定顺序；全部失败时把每个原因都告诉用户', async () => {
  const { router, calls } = setup(S({ modelRouting: { knowledge: ['ol', 'cl'] } }), { ol: new Error('没开'), cl: new Error('还没登录') });
  await assert.rejects(router.chat('s', 'u', { task: 'knowledge' }), /Ollama：没开；Claude：还没登录/);
  assert.deepEqual(calls, ['ol', 'cl']);
});

test('每日额度：今天用满的来源跳过，换下一个', async () => {
  const s = S(); s.providers[0].dailyTokens = 1000;
  const { router, calls, usage } = setup(s, {});
  usage.add({ provider: 'ds', task: 'summary', in: 990, out: 0 });
  const r = await router.chat('s'.repeat(100), 'u', { task: 'summary' });
  assert.equal(r.provider, 'cl'); assert.deepEqual(calls, ['cl']);
});

test('隐私：开启后汇总只用本机模型；其他任务不受影响', async () => {
  const { router, calls } = setup(S({ modelPolicy: { privateLocalOnly: true } }), {});
  assert.equal((await router.chat('s', 'u', { task: 'summary' })).provider, 'ol');
  assert.equal((await router.chat('s', 'u', { task: 'customize' })).provider, 'ds');
  const only = setup(S({ providers: [{ id: 'ds', kind: 'api', baseUrl: 'https://x' }], modelPolicy: { privateLocalOnly: true } }), {});
  await assert.rejects(only.router.chat('s', 'u', { task: 'summary' }), /只用本机模型/);
  assert.deepEqual(calls, ['ol', 'ds']);
});

test('停用的来源不参与；没拿到真实用量时按字数估算并标记', async () => {
  const s = S(); s.providers[0].enabled = false;
  const { router, usage } = setup(s, {});
  const r = await router.chat('abcd', 'efgh', { task: 'customize' });
  assert.equal(r.provider, 'cl'); assert.equal(r.usage.est, true); assert.ok(usage.usedToday('cl') > 0);
});

test('旧版单个 DeepSeek 配置迁移成来源列表；解析回答里的 JSON', () => {
  const s = { model: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', keyEnvFile: '~/k.env', keyEnvName: 'K' } };
  assert.equal(P.migrate(s), true); assert.equal(s.providers[0].id, 'deepseek'); assert.equal(s.providers[0].keyEnvName, 'K');
  assert.equal(P.migrate(s), false, '只迁移一次');
  assert.deepEqual(P.parseJSON('好的：\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => P.parseJSON('没有'), /JSON/);
  assert.equal(P.isLocal({ kind: 'api', baseUrl: 'http://localhost:11434/v1' }), true);
  assert.equal(P.isLocal({ kind: 'claude' }), false);
});
