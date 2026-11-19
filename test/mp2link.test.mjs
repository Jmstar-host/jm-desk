/* 本地助手关联 MP2 账号（设备授权）。只用 test/mock-mp2.mjs，不连真实 MP2。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { startMock } from './mock-mp2.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'jmdesk-link-'));
process.env.JM_DESK_HOME = HOME; // store.mjs 在导入时读取
const link = await import('../src/mp2link.mjs');
const store = await import('../src/store.mjs');
const { credential } = await import('../src/mp2.mjs');
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const cli = (...a) => new Promise((res, rej) => execFile(process.execPath, [CLI, ...a, '--json'], { env: { ...process.env, JM_DESK_HOME: HOME }, timeout: 30000 }, (e, out) => { try { res(JSON.parse(String(out).trim().split('\n').pop())); } catch (x) { rej(e || x); } }));
const fast = { slowDownMs: 30 };
const allFiles = () => fs.readdirSync(HOME, { recursive: true }).map(f => path.join(HOME, f)).filter(f => fs.statSync(f).isFile());

test('未填 MP2 地址：不发任何请求', async () => {
  const m = await startMock();
  for (const bad of ['', '   ', null, 'ftp://x', 'not a url']) await assert.rejects(link.begin(bad), e => ['no_base_url', 'invalid_base_url'].includes(e.code));
  assert.equal(m.links.requests, 0);
  m.close();
});

test('发起 → 显示 8 位代码 → 允许 → 只领取一次凭据，文件 0600，搬运改用这条连接', async () => {
  const m = await startMock({ linkInterval: 0.05, linkMinGapMs: 0 }); test.after?.(() => m.close());
  const l = await link.begin(m.url + '/', { minIntervalSec: 0 });
  assert.match(l.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(l.verification_url, /\/ai-access\/link\?code=/);
  assert.match(l.secret, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(l.base, m.url);
  assert.deepEqual(await link.poll(l), { status: 'pending' });
  m.links.approve(l.user_code, 'conn-1');
  const seen = [];
  const r = await link.waitFor(l, { ...fast, onStatus: s => seen.push(s.status) });
  assert.equal(r.status, 'connected'); assert.equal(r.connectionId, 'conn-1');
  assert.deepEqual(seen.at(-1), 'connected');
  const file = link.credentialPath();
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.mcpServers.mp2.headers.Authorization.startsWith('Bearer '), 'config 原样写入');
  assert.equal(credential(file), 'test-token');
  // MP2 不会再给一次 config：直接再领取只拿到 connected
  const again = await fetch(`${m.url}/api/ai-access/device-links/${l.id}/token`, { method: 'POST', headers: { 'X-MP2-Link-Secret': l.secret } }).then(x => x.json());
  assert.deepEqual(again, { status: 'connected' });
  // 本机已存好同一条连接时，再查也算成功，不覆盖凭据
  assert.equal((await link.poll(l)).status, 'connected');
  const st = link.linkStatus();
  assert.deepEqual([st.linked, st.baseUrl, st.connectionId, st.fileMode], [true, m.url, 'conn-1', '600']);
  // secret 和 token 不出现在本机任何其他文件里（配置、搬运记录、状态）
  for (const f of allFiles()) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!t.includes(l.secret), `secret 出现在 ${path.basename(f)}`);
    if (f !== file) assert.ok(!t.includes('test-token'), `凭据出现在 ${path.basename(f)}`);
  }
  // 搬运：送一条来源，用的就是这条连接
  fs.writeFileSync(path.join(HOME, 'outbox', 's1.json'), JSON.stringify({ id: 's1', source_type: 'mail', source_ref: '<a@x>', title: '邮件 · 测试', content: '请在 11 月 20 日前回复', status: 'queued' }));
  const sub = await cli('submit');
  assert.deepEqual([sub.sent, sub.failed], [1, 0]);
  assert.equal(m.batches.size, 1);
  m.close();
});

test('被拒绝 / 过期 / 链接已不存在：停止并可重新发起；不写凭据', async () => {
  link.unlink();
  const m = await startMock({ linkInterval: 0.05, linkMinGapMs: 0 });
  for (const [act, want] of [['deny', 'denied'], ['expire', 'expired'], ['remove', 'expired']]) {
    const l = await link.begin(m.url, { minIntervalSec: 0 });
    m.links[act](l.user_code);
    const r = await link.waitFor(l, fast);
    assert.equal(r.status, want, act);
    assert.equal(fs.existsSync(link.credentialPath()), false);
  }
  const re = await link.begin(m.url, { minIntervalSec: 0 }); // 可以重新发起
  assert.ok(re.user_code);
  m.close();
});

test('slow_down：每次把间隔加长；secret 不符时报错而不是一直等', async () => {
  const m = await startMock({ linkInterval: 0.02, linkMinGapMs: 60 });
  const l = await link.begin(m.url, { minIntervalSec: 0 });
  const seen = [];
  setTimeout(() => m.links.deny(l.user_code), 300);
  await link.waitFor(l, { slowDownMs: 40, onStatus: s => seen.push([s.status, s.interval]) });
  const slow = seen.filter(s => s[0] === 'slow_down');
  assert.ok(slow.length >= 1, '至少出现一次 slow_down');
  assert.ok(slow[0][1] > 0.02, '出现 slow_down 后间隔变大');
  await assert.rejects(link.poll({ ...l, secret: 'x'.repeat(64) }), e => e.code === 'device_link_secret_required');
  m.close();
});

test('取消等待', async () => {
  const m = await startMock({ linkInterval: 0.05, linkMinGapMs: 0 });
  const l = await link.begin(m.url, { minIntervalSec: 0 }), ac = new AbortController();
  setTimeout(() => ac.abort(), 120);
  await assert.rejects(link.waitFor(l, { signal: ac.signal }), e => e.code === 'cancelled');
  m.close();
});

test('断开：删除本机凭据，搬运不再发送', async () => {
  const m = await startMock({ linkInterval: 0.05, linkMinGapMs: 0 });
  const l = await link.begin(m.url, { minIntervalSec: 0 }); m.links.approve(l.user_code);
  await link.waitFor(l, fast);
  assert.ok(fs.existsSync(link.credentialPath()));
  const r = link.unlink();
  assert.equal(r.removed, true);
  assert.equal(fs.existsSync(link.credentialPath()), false);
  assert.equal(link.linkStatus().linked, false);
  assert.equal(store.config().mp2.baseUrl, m.url, '保留地址，方便重新关联');
  fs.writeFileSync(path.join(HOME, 'outbox', 's2.json'), JSON.stringify({ id: 's2', source_type: 'mail', source_ref: '<b@x>', title: 't', content: 'c', status: 'queued' }));
  const sub = await cli('submit');
  assert.equal(sub.skipped, 'mp2_not_configured');
  m.close();
});

test('MP2 不支持 device-links 时给出明确提示', async () => {
  const http = await import('node:http');
  const srv = http.createServer((q, s) => { s.writeHead(404); s.end('{}'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  await assert.rejects(link.begin(`http://127.0.0.1:${srv.address().port}`), e => e.code === 'not_supported');
  srv.close();
});
