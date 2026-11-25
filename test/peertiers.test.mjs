/* 好友分级、给好友开放的文件夹（1.4.2）；第一层直接动作的分组 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shareFor, tierOf, cleanCatalog } from '../app/main/peers.mjs';
import { searchFolder, listFiles, folderEntry, badDir } from '../app/main/peerfiles.mjs';
import { migrateLayout, validateLayout, DEFAULT_LAYOUT, MOVED } from '../app/main/catalog.mjs';

test('好友分级：普通好友拿不到知识库；1.4.2 之前加的好友按知识好友算', () => {
  const share = { knowledge: true, requirements: true, todos: false };
  assert.deepEqual(shareFor(share, { tier: 'basic' }), { knowledge: false, requirements: true, todos: false });
  assert.equal(shareFor(share, { tier: 'knowledge' }).knowledge, true);
  assert.equal(tierOf({}), 'knowledge');
  assert.equal(shareFor({ knowledge: false }, { tier: 'knowledge' }).knowledge, false, '我没开放知识库时，知识好友也拿不到');
  assert.equal(cleanCatalog([{ id: 'f:abc', kind: 'files', name: '文件夹 · 资料', items: [] }])[0].kind, 'files');
});

test('开放的文件夹：只搜文本文件，回文件名和片段；跳过隐藏文件、node_modules、指向外面的链接', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jmpf-')), dir = path.join(root, 'share'), out = path.join(root, 'secret');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true }); fs.mkdirSync(path.join(dir, 'node_modules')); fs.mkdirSync(out);
  fs.writeFileSync(path.join(dir, 'docs', '充值接口.md'), '# 充值\n充值接口按卡号批量下单，单次最多 500 张卡。');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.md'), '充值接口');
  fs.writeFileSync(path.join(dir, '.hidden.md'), '充值接口');
  fs.writeFileSync(path.join(dir, 'photo.png'), '充值接口');
  fs.writeFileSync(path.join(out, 'pw.txt'), '充值接口 密码');
  fs.symlinkSync(out, path.join(dir, 'link'));
  assert.deepEqual(listFiles(dir), [path.join('docs', '充值接口.md')]);
  const hits = searchFolder(dir, '批量充值');
  assert.equal(hits.length, 1); assert.match(hits[0].snippet, /按卡号批量下单/); assert.doesNotMatch(JSON.stringify(hits), /密码/);
  assert.equal(searchFolder(dir, '完全不相干').length, 0);
  assert.equal(folderEntry(dir).label, 'share');
  assert.ok(badDir(os.homedir())); assert.ok(badDir('/')); assert.ok(badDir('/System/Library')); assert.ok(!badDir(dir));
});

test('1.5.2 去掉本机会议纪要：旧布局第一层的「会议」分组删掉；旧入口 app.meeting 转到线索；第一层直接动作只能是命令', () => {
  const v = validateLayout(DEFAULT_LAYOUT); assert.ok(v.ok, v.errors.join()); assert.ok(!v.layout.groups.some(g => g.action === 'app.meeting'));
  const old = { version: 1, seen: ['meet'], groups: [{ id: 'work', label: '工作', icon: 'doc', color: ['#ec4899', '#3b82f6'], items: ['app.work', 'app.settings'] }, { id: 'meet', label: '会议', icon: 'quill', color: ['#e11d48', '#ec4899'], action: 'app.meeting', items: [] }] };
  const m = migrateLayout(old); assert.equal(m.changed, true); assert.deepEqual(m.layout.groups.map(g => g.id), ['work', 'load'], '「会议」删掉；1.7.0 的「占用」加一次'); assert.ok(validateLayout(m.layout).ok);
  assert.equal(migrateLayout(m.layout).changed, false);
  assert.deepEqual(MOVED['app.meeting'], ['app.clues']);
  assert.equal(validateLayout({ version: 1, groups: [{ id: 'x', label: '设置', icon: 'doc', items: ['app.settings'] }, { id: 'y', label: '坏', icon: 'doc', action: 'skill.burst', items: [] }] }).ok, false);
});
