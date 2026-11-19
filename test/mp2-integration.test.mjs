/* 2026-11-17 对接修正的回归测试：只用 test/mock-mp2.mjs，不连真实 MP2 / 飞书 / 邮箱 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { startMock } from './mock-mp2.mjs';
import * as mp2 from '../src/mp2.mjs';
import { splitText, splitSignal, clip, fitRef, fitTitle, safeUrl, LIMITS } from '../src/text.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jmdesk-'));
const cli = (h, ...a) => new Promise((res, rej) => execFile(process.execPath, [CLI, ...a, '--json'], { env: { ...process.env, JM_DESK_HOME: h }, timeout: 30000 }, (e, out) => { try { res(JSON.parse(String(out).trim().split('\n').pop())); } catch (x) { rej(e || x); } }));
function setup(m) {
  const h = tmp(); fs.mkdirSync(path.join(h, 'outbox'));
  const cred = path.join(h, 'cred'); fs.writeFileSync(cred, 'test-token', { mode: 0o600 });
  const cfg = { mp2: { baseUrl: m.url, credentialFile: cred } };
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(cfg));
  return { h, cfg };
}
const sig = (i, extra = {}) => ({ id: `s${i}`, source_type: 'mail', source_ref: `<m${i}@x>`, source_url: null, title: `邮件 · 测试 ${i}`, occurred_at: `2026-11-17T0${i}:00:00.000Z`, participants: ['张三'], content: `第 ${i} 项需求`, status: 'queued', ...extra });
const put = (h, s) => fs.writeFileSync(path.join(h, 'outbox', `${s.id}.json`), JSON.stringify(s));
const get = (h, id) => JSON.parse(fs.readFileSync(path.join(h, 'outbox', `${id}.json`)));

/* ---------- 修正 1：5xx 后重试必须换 requestId，回放无 result 绝不算送达 ---------- */

test('回放只有回执没有 result：抛错且不可当成已送达；换 attempt 后拿到原批次 duplicate', async () => {
  const m = await startMock(); const { cfg } = setup(m);
  const s = sig(1);
  const r1 = await mp2.submit(cfg, s, 1);
  assert.equal(r1.batchId, 1); assert.equal(r1.duplicate, false); assert.equal(r1.requestId, 'jmdesk-s1-1');
  await assert.rejects(mp2.submit(cfg, s, 1), e => e.code === 'replayed_without_result' && !e.final);
  const r2 = await mp2.submit(cfg, s, 2);
  assert.deepEqual([r2.batchId, r2.duplicate], [1, true]);
  assert.equal(m.batches.size, 1);
  m.close();
});

test('502 失败回执被回放：旧实现会记成已送达；现在留在 queued，下一轮换 requestId 真正送达', async () => {
  const m = await startMock(); const { h } = setup(m);
  put(h, sig(1)); put(h, sig(2));
  m.failNext(1, 502);
  let r = await cli(h, 'submit');
  assert.deepEqual([r.sent, r.failed, r.retry, r.remaining], [1, 1, 1, 1]);
  const failedId = ['s1', 's2'].find(id => get(h, id).status === 'queued');
  assert.equal(get(h, failedId).attempts, 1); assert.equal(get(h, failedId).batchId, undefined);
  r = await cli(h, 'submit');
  assert.deepEqual([r.sent, r.duplicate, r.failed, r.remaining], [1, 0, 0, 0]);
  const s = get(h, failedId);
  assert.equal(s.status, 'submitted'); assert.ok(s.batchId > 0, '必须拿到真实 batch_id'); assert.equal(s.requestId, `jmdesk-${failedId}-2`);
  assert.equal(m.batches.size, 2);
  const ids = m.calls.filter(c => c.requestId.startsWith(`jmdesk-${failedId}-`)).map(c => c.requestId);
  assert.deepEqual(ids, [`jmdesk-${failedId}-1`, `jmdesk-${failedId}-2`], '每次尝试 requestId 都不同');
  m.close();
});

test('网关 502（无信封无回执）与信封 HTTP 跟随回执两种形态都只重试不误记', async () => {
  const m = await startMock({ mirrorHttp: true }); const { h, cfg } = setup(m);
  m.gatewayDown(1, 502);
  await assert.rejects(mp2.submit(cfg, sig(1), 1), e => e.code === 'http_502' && !e.final);
  m.failNext(1, 503);
  await assert.rejects(mp2.submit(cfg, sig(1), 2), e => e.status === 503 && !e.final);
  await assert.rejects(mp2.submit(cfg, sig(1), 2), e => e.code === 'replayed_without_result');
  const ok = await mp2.submit(cfg, sig(1), 3);
  assert.equal(ok.batchId, 1);
  m.close(); fs.rmSync(h, { recursive: true, force: true });
});

/* ---------- 修正 3：result.status 是批次状态，HTTP 码只看 receipt.http_status ---------- */

test('成功 result.status 是批次状态字符串，不当 HTTP 码', async () => {
  const m = await startMock(); const { cfg } = setup(m);
  const r = await mp2.submit(cfg, sig(1), 1);
  assert.equal(r.batchStatus, 'extracting'); assert.ok(r.receiptId);
  m.close();
});

/* ---------- 修正 4：错误码映射、标题上限、batch()、confirmed→pooled ---------- */

test('403 operation_not_granted 与 400 校验错误为 final，不再重试', async () => {
  const m = await startMock({ grants: [] }); const { h } = setup(m);
  put(h, sig(1));
  let r = await cli(h, 'submit');
  assert.deepEqual([r.failed, r.retry, r.remaining], [1, 0, 0]);
  assert.equal(get(h, 's1').status, 'failed'); assert.equal(get(h, 's1').lastErrorCode, 'operation_not_granted');
  r = await cli(h, 'submit');
  assert.equal(r.failed, 0, 'failed 的信号不再发送');
  m.close();
  const m2 = await startMock(); const { cfg } = setup(m2);
  await assert.rejects(mp2.submit(cfg, sig(2, { title: 'x'.repeat(201) }), 1), e => e.final && e.code === 'title_too_long' && e.status === 400);
  await assert.rejects(mp2.submit(cfg, sig(3, { content: undefined }), 1), e => e.final && e.code === 'required_field_missing:content');
  await assert.rejects(mp2.submit(cfg, sig(4, { source_url: 'ftp://x' }), 1), e => e.final && e.code === 'invalid_source_url');
  m2.close();
});

test('batch()：completed 视为完成；batch not found 返回 null', async () => {
  const m = await startMock(); const { cfg } = setup(m);
  const { batchId } = await mp2.submit(cfg, sig(1), 1);
  const b = await mp2.batch(cfg, batchId);
  assert.equal(b.status, 'completed'); assert.equal(b.done, true); assert.equal(b.phase, '已完成'); assert.equal(b.candidateCount, 1);
  assert.equal(await mp2.batch(cfg, 999), null);
  m.close();
});

test('myCandidates：confirmed 映射成 pooled，source_kind 归一', async () => {
  const m = await startMock(); const { cfg } = setup(m);
  await mp2.submit(cfg, sig(1), 1); await mp2.submit(cfg, sig(2), 1);
  m.candidates[0].status = 'pooled';
  const r = await mp2.myCandidates(cfg, { status: 'confirmed' });
  assert.equal(m.calls.at(-1).query.status, 'pooled');
  assert.equal(r.total, 1); assert.equal(r.items[0].source_type, 'mail'); assert.deepEqual(r.summary, { pending: 1, pooled: 1, rejected: 0 });
  await assert.rejects(mp2.myCandidates(cfg, { status: 'bogus' }), e => e.code === 'invalid_status');
  m.close();
});

/* ---------- 修正 2：正文 >20000 拆分，绝不超限、不截断 ---------- */

test('clip 结果含标记也不超过上限；fitTitle/fitRef/safeUrl', () => {
  assert.equal(clip('a'.repeat(30000), 20000).length, 20000);
  assert.ok(clip('a'.repeat(30000), 20000).endsWith('（已截断）'));
  assert.equal(fitTitle('题'.repeat(300)).length, 200);
  const long = 'r'.repeat(400);
  assert.ok(fitRef(long).length <= 255); assert.equal(fitRef(long), fitRef(long), '确定性');
  assert.ok(fitRef(long, '#part2').endsWith('#part2')); assert.ok(fitRef(long, '#part2').length <= 255);
  assert.equal(safeUrl('javascript:alert(1)'), null); assert.equal(safeUrl('https://x/' + 'a'.repeat(1000)), null);
});

test('splitText：按章节/段落切，每段 ≤20000，拼回原文逐字相同；不劈代理对', () => {
  const section = k => `## 议题 ${k}\n\n` + Array.from({ length: 60 }, (_, i) => `第 ${k}.${i} 段：` + '讨论内容'.repeat(60)).join('\n\n') + '\n';
  const doc = Array.from({ length: 4 }, (_, k) => section(k + 1)).join('');
  assert.ok(doc.length > 40000);
  const parts = splitText(doc);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= LIMITS.content);
  assert.equal(parts.join(''), doc);
  const emoji = '😀'.repeat(15000); // 30000 个 UTF-16 单元，无任何分隔符
  const e = splitText(emoji);
  assert.equal(e.join(''), emoji);
  for (const p of e) { assert.ok(p.length <= 20000); assert.doesNotMatch(p, /^[\udc00-\udfff]|[\ud800-\udbff]$/); }
});

test('splitSignal：多段 source_ref 带 #partK、标题（K/N）≤200、id 确定；单段保持原 id/ref', () => {
  const base = { id: 'abc', source_type: 'feishu_meeting', source_ref: 'm1:doc1', title: '飞书会议 · ' + '长'.repeat(250), content: ('一行内容\n').repeat(9000), occurred_at: 'not-a-date', source_url: 'https://applink.feishu.cn/x' };
  const parts = splitSignal(base);
  assert.equal(parts.length, 3);
  parts.forEach((p, i) => {
    assert.equal(p.source_ref, `m1:doc1#part${i + 1}`);
    assert.ok(p.title.endsWith(`（${i + 1}/3）`)); assert.ok(p.title.length <= 200);
    assert.ok(p.content.length <= 20000); assert.equal(p.occurred_at, null);
  });
  assert.equal(new Set(parts.map(p => p.id)).size, 3);
  assert.deepEqual(splitSignal(base).map(p => p.id), parts.map(p => p.id));
  const one = splitSignal({ ...base, content: '短' });
  assert.equal(one.length, 1); assert.equal(one[0].id, 'abc'); assert.equal(one[0].source_ref, 'm1:doc1'); assert.equal(one[0].title.length, 200);
});

test('旧版超长信号（20000 + 截断标记、标题 >200）在发送前被拆分并全部送达', async () => {
  const m = await startMock(); const { h } = setup(m);
  const legacy = sig(1, { source_type: 'feishu_meeting', source_ref: 'm9:doc9', title: '飞书会议 · ' + '周'.repeat(300), content: ('纪要一行\n').repeat(4000) + '\n…（已截断）', attempts: 3, lastError: 'MP2 拒绝：content_too_long' });
  assert.ok(legacy.content.length > 20000);
  put(h, legacy);
  const r = await cli(h, 'submit');
  assert.deepEqual([r.split, r.sent, r.failed, r.remaining], [1, 2, 0, 0]);
  assert.equal(get(h, 's1').status, 'split');
  for (const id of get(h, 's1').splitInto) { const p = get(h, id); assert.equal(p.status, 'submitted'); assert.equal(p.attempts, 1); }
  assert.deepEqual([...m.batches.values()].map(b => b.source_ref).sort(), ['m9:doc9#part1', 'm9:doc9#part2']);
  m.close();
});

/* 用 PATH 前置的假 lark-cli 跑真实的 feishu.mjs（不连飞书） */
test('feishu：超长会议纪要拆成多条、群名过长时标题 ≤200', async () => {
  const dir = tmp();
  const doc = path.join(dir, 'doc.md');
  fs.writeFileSync(doc, Array.from({ length: 3 }, (_, k) => `# 话题 ${k + 1}\n` + ('发言内容。'.repeat(40) + '\n').repeat(90)).join('\n'));
  fs.writeFileSync(path.join(dir, 'lark-cli'), `#!${process.execPath}
const a = process.argv.slice(2), has = x => a.includes(x), o = v => process.stdout.write(JSON.stringify(v));
if (a[0] === 'auth') o({ identities: { user: { openId: 'ou_me', available: true } } });
else if (a[0] === 'im') o({ data: { messages: has('--is-at-me') ? [{ message_id: 'om_1', chat_id: 'oc_1', chat_name: '群'.repeat(300), chat_type: 'group', create_time: '2026-11-17 10:00', sender: { id: 'ou_x', name: '李四', sender_type: 'user' }, msg_type: 'text', content: '@我 看下需求', message_app_link: 'https://applink.feishu.cn/m' }] : [] } });
else if (a[0] === 'vc' && a[1] === '+search') o({ data: { items: [{ id: 'mt_1', display_info: '产品周会\\n10:00', meta_data: { app_link: 'https://applink.feishu.cn/v' } }] } });
else if (a[0] === 'vc' && a[1] === '+notes') o({ data: { notes: [{ meeting_id: 'mt_1', verbatim_doc_token: 'dk_1' }] } });
else if (a[0] === 'docs') o({ data: { markdown: require('fs').readFileSync(${JSON.stringify(doc)}, 'utf8') } });
else o({ ok: false });
`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = dir + ':' + oldPath;
  try {
    const { collectMeetings, collectIm } = await import('../src/sources/feishu.mjs?t=' + Date.now());
    const since = new Date(Date.now() - 864e5), until = new Date();
    const { signals } = await collectMeetings({ since, until });
    const text = fs.readFileSync(doc, 'utf8');
    assert.ok(text.length > 40000 && signals.length >= 3);
    assert.equal(signals.map(s => s.content).join(''), text, '拆分不丢字、不加标记');
    signals.forEach((s, i) => { assert.ok(s.content.length <= 20000); assert.equal(s.source_ref, `mt_1:dk_1#part${i + 1}`); assert.ok(s.title.startsWith('飞书会议 · 产品周会')); });
    const im = await collectIm({ since, until });
    assert.equal(im.length, 1); assert.ok(im[0].title.length <= 200);
  } finally { process.env.PATH = oldPath; }
});

let hasSqlite = true; try { execFileSync('sqlite3', ['-version']); } catch { hasSqlite = false; }
test('mail：主题过长时标题 ≤200；长邮件拆分', { skip: !hasSqlite && '本机没有 sqlite3' }, async () => {
  const dbPath = path.join(tmp(), 'edgehill.db');
  const body = '<p>' + ('请评估采购流程。'.repeat(50) + '</p><p>').repeat(60) + '</p>';
  const now = Math.floor(Date.now() / 1000) - 60;
  const esc = s => s.replace(/'/g, "''");
  execFileSync('sqlite3', [dbPath], { input: `create table Account(data text); create table Message(id text, threadId text, subject text, date int, headerMessageId text, draft int, data text); create table MessageBody(id text, value text);
insert into Account values('{"emailAddress":"me@example.com"}');
insert into Message values('1','t1','${'采'.repeat(300)}',${now},'<long@x>',0,'{"from":[{"email":"zhang@example.com","name":"张三"}],"to":[{"name":"我"}],"snippet":"s"}');
insert into MessageBody values('1','${esc(body)}');` });
  process.env.JM_MAILSPRING_DB = dbPath;
  try {
    const { collectMail } = await import('../src/sources/mail.mjs?t=' + Date.now());
    const { signals } = await collectMail({ since: new Date(Date.now() - 864e5), until: new Date() });
    assert.ok(signals.length >= 2);
    for (const s of signals) { assert.ok(s.title.length <= 200); assert.ok(s.content.length <= 20000); assert.match(s.source_ref, /^<long@x>#part\d$/); }
  } finally { delete process.env.JM_MAILSPRING_DB; }
});
