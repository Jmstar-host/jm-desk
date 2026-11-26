/* MOD 库（1.8.4）：团队共享的形象清单。中转的下载目录里多一个只读的 mods/；清单里的模型只能和清单同源 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseLibrary } from '../app/main/gallery.mjs';
import { createRelay } from '../relay/server.mjs';

test('清单：星灵配色只带参数；模型地址可以相对，但必须和清单同源、https；坏的条目跳过', () => {
  const lib = parseLibrary({ name: '团队形象', mods: [
    { id: 'mint', name: '薄荷星灵', kind: 'lumi', params: { body: '#a7f3d0' } },
    { id: 'robo', name: '小机器人', kind: 'gltf', url: 'robo.glb', license: 'CC0', size: 1.4 },
    { id: 'evil', name: '别处的', kind: 'gltf', url: 'https://elsewhere.example/x.glb' },
    { id: 'plain', name: '明文', kind: 'gltf', url: 'http://lib.example/dl/k/mods/p.glb' },
    { id: 'mint', name: '重复', kind: 'lumi', params: {} }, { id: '../x', kind: 'lumi', params: {} }, { id: 'nop', kind: 'lumi' },
  ] }, 'https://lib.example/dl/k/mods/index.json');
  assert.equal(lib.name, '团队形象'); assert.deepEqual(lib.mods.map(m => m.id), ['mint', 'robo']);
  assert.equal(lib.mods[1].url, 'https://lib.example/dl/k/mods/robo.glb'); assert.equal(lib.mods[0].kind, 'lumi');
  assert.deepEqual(parseLibrary({ mods: [{ id: 'a', kind: 'lumi', params: {} }] }, 'http://lib.example/index.json').mods, [], '清单地址不是 https 就不用');
});

test('中转：/dl/<口令>/mods/ 只给 index.json 和 .glb，不进更深的目录，口令不对打不开', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-mods-')); fs.mkdirSync(path.join(dir, 'mods', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mods', 'index.json'), JSON.stringify({ mods: [] })); fs.writeFileSync(path.join(dir, 'mods', 'robo.glb'), 'glTFxxxx');
  fs.writeFileSync(path.join(dir, 'mods', 'notes.txt'), 'x'); fs.writeFileSync(path.join(dir, 'mods', 'deep', 'a.glb'), 'x'); fs.writeFileSync(path.join(dir, 'secret.glb'), 'x');
  const relay = createRelay({ dlDir: dir, dlKey: 'k1' }), srv = relay.listen ? relay : http.createServer(relay);
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const get = p => fetch(base + p);
    let r = await get('/dl/k1/mods/index.json'); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { mods: [] });
    r = await get('/dl/k1/mods/robo.glb'); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'model/gltf-binary'); assert.equal(await r.text(), 'glTFxxxx');
    for (const p of ['/dl/k1/mods/notes.txt', '/dl/k1/mods/deep/a.glb', '/dl/k1/mods/..%2Fsecret.glb', '/dl/k1/mods/', '/dl/bad/mods/index.json', '/dl/k1/secret.glb']) assert.equal((await get(p)).status, 404, p);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
