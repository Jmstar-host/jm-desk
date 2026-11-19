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
