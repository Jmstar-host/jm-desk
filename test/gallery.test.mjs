/* 形象库：来源列表合并、glb 校验、安装 / 删除不越出形象包目录、下载限制 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as g from '../app/main/gallery.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jmdesk-gal-'));
const glb = (n = 64) => { const b = Buffer.alloc(n); b.write('glTF', 0, 'latin1'); b.writeUInt32LE(2, 4); b.writeUInt32LE(n, 8); return b; };

test('来源列表：内置在前，本机列表补充；只收 https 和合法 id', () => {
  const d = tmp(), bi = path.join(d, 'b.json'), us = path.join(d, 'u.json');
  fs.writeFileSync(bi, JSON.stringify({ sources: [{ id: 'star', name: '星', url: 'https://x/a.glb' }] }));
  fs.writeFileSync(us, JSON.stringify([{ id: 'star', name: '重复', url: 'https://x/b.glb' }, { id: 'star-sprite', url: 'https://x/sprite.glb', page: 'http://not-https' }, { id: 'Bad Id', url: 'https://x/c.glb' }, { id: 'ftp', url: 'ftp://x/d.glb' }]));
  const l = g.listSources(bi, us);
  assert.deepEqual(l.map(x => [x.id, x.origin]), [['star', 'builtin'], ['star-sprite', 'local']]);
  assert.equal(l[1].page, null);
  assert.deepEqual(g.listSources(path.join(d, 'none.json'), path.join(d, 'none2.json')), []);
});

test('只接受 glTF 2.0 二进制', () => {
  assert.ok(g.checkGlb(glb()));
  assert.throws(() => g.checkGlb(Buffer.from('<html>not found</html>                ')), /不是 \.glb/);
  const v1 = glb(); v1.writeUInt32LE(1, 4); assert.throws(() => g.checkGlb(v1), /2\.0/);
  assert.throws(() => g.checkGlb(Buffer.alloc(4)), /太小/);
});

test('安装 / 删除：写 manifest + model.glb，不能越出目录，不能删内置', () => {
  const dir = tmp();
  const m = g.installPack(dir, { id: 'star-sprite', name: '星星', buf: glb(), source: 'https://x/sprite.glb', license: 'L' });
  assert.equal(m.kind, 'gltf'); assert.equal(m.entry, 'model.glb');
  assert.ok(fs.existsSync(path.join(dir, 'star-sprite', 'model.glb')));
  assert.throws(() => g.installPack(dir, { id: '../evil', buf: glb() }), /不合法/);
  assert.throws(() => g.installPack(dir, { id: 'bad', buf: Buffer.from('nope nope nope nope nope') }));
  assert.equal(fs.existsSync(path.join(dir, 'bad')), false, '无效模型不留目录');
  assert.throws(() => g.removePack(dir, 'lumi'), /内置/);
  assert.throws(() => g.removePack(dir, '../x'), /内置|不合法/);
  g.removePack(dir, 'star-sprite'); assert.equal(fs.existsSync(path.join(dir, 'star-sprite')), false);
});

test('下载：只允许 https，超过上限拒绝，非 200 报错', async () => {
  await assert.rejects(g.download(fetch, 'http://x/a.glb'), /https/);
  const big = async () => new Response(Buffer.alloc(10), { headers: { 'content-length': String(100 * 1048576) } });
  await assert.rejects(g.download(big, 'https://x/a.glb'), /太大/);
  await assert.rejects(g.download(async () => new Response('', { status: 404 }), 'https://x/a.glb'), /404/);
  const ok = await g.download(async () => new Response(glb()), 'https://x/a.glb');
  assert.ok(g.checkGlb(ok));
});

test('slug：从文件名生成 id', () => {
  assert.equal(g.slug('42.glb'), '42');
  assert.equal(g.slug('My Sprite.glb'), 'my-sprite');
  assert.match(g.slug('星星'), /^sprite-/);
});
