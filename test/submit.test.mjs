import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { startMock } from './mock-mp2.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'jmdesk-'));
  fs.mkdirSync(path.join(h, 'outbox'), { recursive: true });
  return h;
}
// 必须异步：假 MP2 跑在本进程里，同步调用会把它卡死
const cli = (h, ...a) => new Promise((res, rej) => execFile(process.execPath, [CLI, ...a, '--json'], { env: { ...process.env, JM_DESK_HOME: h }, timeout: 30000 }, (e, out) => { try { res(JSON.parse(String(out).trim().split('\n').pop())); } catch (x) { rej(e || x); } }));
function seed(h, n) {
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(h, 'outbox', `s${i}.json`), JSON.stringify({ id: `s${i}`, source_type: 'mail', source_ref: `<m${i}@x>`, source_url: null, title: `邮件 · 测试 ${i}`, occurred_at: new Date().toISOString(), participants: ['张三'], content: `请在 11 月 20 日前完成第 ${i} 项`, status: 'queued' }));
}

test('MP2 未配置时只留在本地，不发送', async () => {
  const h = home(); seed(h, 2);
  const r = await cli(h, 'submit');
  assert.equal(r.skipped, 'mp2_not_configured'); assert.equal(r.queued, 2);
});

test('送入 MP2：成功、幂等、凭据错误', async () => {
  const m = await startMock();
  const h = home(); seed(h, 3);
  const cred = path.join(h, 'cred'); fs.writeFileSync(cred, 'test-token', { mode: 0o600 });
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ mp2: { baseUrl: m.url, credentialFile: cred } }));
  let r = await cli(h, 'submit');
  assert.deepEqual([r.sent, r.failed, r.remaining], [3, 0, 0]);
  assert.equal(m.batches.size, 3);
  // 再标回 queued 重发：每次尝试换新 requestId（jmdesk-<id>-<n>），MP2 按 source_type+source_ref 去重返回原批次，不会多建批次
  for (const f of fs.readdirSync(path.join(h, 'outbox'))) { const p = path.join(h, 'outbox', f); const s = JSON.parse(fs.readFileSync(p)); s.status = 'queued'; fs.writeFileSync(p, JSON.stringify(s)); }
  r = await cli(h, 'submit');
  assert.equal(r.duplicate, 3); assert.equal(m.batches.size, 3);
  const tick = await cli(h, 'ticker');
  assert.ok(tick.some(t => t.kind === 'moved' && t.text.includes('MP2 个人需求池')));
  assert.ok(tick.every(t => !JSON.stringify(t).includes('11 月 20 日')), '搬运记录里不能有正文');
  // 凭据错误：保持 queued，等下次
  fs.writeFileSync(cred, 'wrong');
  seed(h, 4); fs.writeFileSync(path.join(h, 'outbox', 's3.json'), JSON.stringify({ id: 's3', source_type: 'mail', source_ref: '<new@x>', title: 'x', content: 'y', status: 'queued' }));
  r = await cli(h, 'submit');
  assert.equal(r.failed, 1); assert.ok(r.remaining >= 1);
  m.close();
});

test('信息源开关：默认全部关闭，打开一个不影响其他，可以再关掉', async () => {
  const h = home();
  const on = await cli(h, 'sources', 'mail', 'on');
  assert.equal(on.mail.enabled, true); assert.equal(on.feishu_im.enabled, false); assert.equal(on.feishu_meeting.enabled, false);
  const off = await cli(h, 'sources', 'mail', 'off');
  assert.equal(off.mail.enabled, false);
});
