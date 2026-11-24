/* 应用内升级：版本比较、版本文件校验、下载校验 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as u from '../app/main/updater.mjs';

const feedUrl = 'https://cdn.example.com/jm-desk/latest.json';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const feed = (o = {}) => ({ version: '2.0.0', notes: ['新增 A'], files: { 'darwin-arm64': { url: 'JM%20Desk-2.0.0-arm64.dmg', sha256: 'a'.repeat(64), size: 10 } }, ...o });
const ctx = { feedUrl, current: '0.1.0', platform: 'darwin', arch: 'arm64' };

test('版本比较', () => {
  assert.equal(u.cmpVersion('2.0.0', '0.9.9'), 1);
  assert.equal(u.cmpVersion('1.10.0', '1.9.0'), 1);
  assert.equal(u.cmpVersion('v1.2', '1.2.0'), 0);
  assert.equal(u.cmpVersion('1.2.3', '1.2.4'), -1);
});

test('版本文件：有新版本时给出完整地址；同版本或旧版本不提示', () => {
  const r = u.parseFeed(feed(), ctx);
  assert.equal(r.version, '2.0.0'); assert.equal(r.url, 'https://cdn.example.com/jm-desk/JM%20Desk-2.0.0-arm64.dmg'); assert.equal(r.name, 'JM Desk-2.0.0-arm64.dmg');
  assert.equal(u.parseFeed(feed({ version: '0.1.0' }), ctx), null);
  assert.equal(u.parseFeed(feed({ version: '0.0.9' }), ctx), null);
});

test('版本文件：没有本平台安装包、地址不安全、缺 sha256、强制升级', () => {
  assert.deepEqual(u.parseFeed(feed(), { ...ctx, platform: 'win32', arch: 'x64' }), { version: '2.0.0', unsupported: true });
  assert.throws(() => u.parseFeed(feed({ files: { 'darwin-arm64': { url: 'http://evil.example.com/x.dmg', sha256: 'a'.repeat(64) } } }), ctx), /https/);
  assert.throws(() => u.parseFeed(feed({ files: { 'darwin-arm64': { url: 'x.dmg' } } }), ctx), /sha256/);
  assert.equal(u.parseFeed(feed({ minVersion: '1.0.0' }), ctx).mandatory, true);
  assert.equal(u.parseFeed(feed({ minVersion: '0.1.0' }), ctx).mandatory, false);
  assert.throws(() => u.parseFeed({}, ctx), /格式/);
  assert.equal(u.allowedUrl('http://127.0.0.1:9/latest.json'), 'http://127.0.0.1:9/latest.json');
  assert.equal(u.allowedUrl('http://example.com/latest.json'), null);
});

test('下载：sha256 一致才保留；不一致删除并报错；已下载过的直接复用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmdesk-upd-')), body = Buffer.from('fake installer bytes '.repeat(1000));
  const fetchOk = async () => new Response(body, { headers: { 'content-length': String(body.length) } });
  const info = { url: 'https://x/a.dmg', name: 'a.dmg', sha256: sha(body), size: body.length };
  const seen = [];
  const f = await u.download(fetchOk, info, dir, p => seen.push(p));
  assert.equal(fs.readFileSync(f).length, body.length); assert.equal(seen.at(-1), 1);
  let called = 0; await u.download(async () => { called++; return fetchOk(); }, info, dir); assert.equal(called, 0, '同一文件不重复下载');
  fs.rmSync(f);
  await assert.rejects(u.download(fetchOk, { ...info, sha256: 'b'.repeat(64) }, dir), /校验不通过/);
  assert.deepEqual(fs.readdirSync(dir), [], '校验失败不留文件');
});

/* ---------- 版本更新触达：中转的下载目录就是升级地址；企业升级地址只在打包时注入 ---------- */
test('中转提供 latest.json：应用按它发现新版本，安装包地址落在同一个带口令的目录下并能下载、校验', async () => {
  const { createRelay } = await import('../relay/server.mjs');
  const { default: crypto } = await import('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmdl-feed-')), dmg = 'JM Desk-9.9.9-arm64.dmg', bytes = Buffer.from('new-version-bytes');
  fs.writeFileSync(path.join(dir, dmg), bytes);
  const srv = createRelay({ dlDir: dir, dlKey: 'k1' }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/dl/k1/`;
  try {
    assert.equal((await fetch(base + 'latest.json')).status, 404, '还没放版本文件');
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ version: '9.9.9', date: '2026-12-01', notes: ['对话工作台'], files: { 'darwin-arm64': { url: encodeURIComponent(dmg), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length } } }));
    assert.equal((await fetch(base.replace('/k1/', '/') + 'latest.json')).status, 404, '没带口令读不到');
    const res = await fetch(base + 'latest.json'); assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /json/); assert.equal(res.headers.get('cache-control'), 'no-store');
    const info = await u.check(fetch, { feedUrl: base + 'latest.json', current: '1.2.0', platform: 'darwin', arch: 'arm64' });
    assert.equal(info.version, '9.9.9'); assert.equal(info.url, base + encodeURIComponent(dmg)); assert.deepEqual(info.notes, ['对话工作台']);
    const got = await u.download(fetch, info, fs.mkdtempSync(path.join(os.tmpdir(), 'jmdl-got-')));
    assert.equal(fs.readFileSync(got, 'utf8'), 'new-version-bytes');
    assert.equal(await u.check(fetch, { feedUrl: base + 'latest.json', current: '9.9.9', platform: 'darwin', arch: 'arm64' }), null, '已经是最新');
    assert.match(await (await fetch(base)).text(), /当前版本 9\.9\.9[\s\S]*对话工作台/, '下载页显示当前版本和更新点');
    fs.writeFileSync(path.join(dir, 'latest.json'), '{ 坏的'); assert.equal((await fetch(base + 'latest.json')).status, 404, '坏的版本文件不外发');
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('企业升级地址由预置文件在打包时写入，打完清空；手工设置的公开地址不受影响', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jmpreset-')); fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'builtin'));
  fs.copyFileSync(new URL('../app/scripts/apply-preset.mjs', import.meta.url), path.join(root, 'scripts/apply-preset.mjs'));
  const upd = path.join(root, 'builtin/update.json'), preset = path.join(root, 'p.json'), read = () => JSON.parse(fs.readFileSync(upd, 'utf8'));
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/apply-preset.mjs'), ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  fs.writeFileSync(upd, JSON.stringify({ feed: '' }));
  fs.writeFileSync(preset, JSON.stringify({ relay: 'https://relay.example.com/r', update: 'https://relay.example.com/r/dl/key/latest.json', integrations: [] }));
  assert.equal(run([], { JM_DESK_PRESET: preset }).status, 0); assert.equal(read().feed, 'https://relay.example.com/r/dl/key/latest.json');
  assert.doesNotMatch(run([], { JM_DESK_PRESET: preset }).stdout, /dl\/key/, '打包日志里不打印带口令的地址');
  assert.equal(run(['--reset']).status, 0); assert.equal(read().feed, ''); assert.equal(read().fromPreset, undefined);
  fs.writeFileSync(upd, JSON.stringify({ feed: 'https://public.example.com/latest.json' })); run(['--reset']);
  assert.equal(read().feed, 'https://public.example.com/latest.json', '手工设置的地址保留');
  fs.writeFileSync(preset, JSON.stringify({ update: 'http://insecure.example.com/latest.json', integrations: [] }));
  assert.notEqual(run([], { JM_DESK_PRESET: preset }).status, 0, '非 https 拒绝');
});
