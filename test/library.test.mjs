/* 资料上传：全部用本机假服务，不连真实资料库；样例都是虚构的 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as L from '../app/main/library.mjs';

function fakeLibrary() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks), send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      seen.push({ method: req.method, url: req.url, headers: req.headers, bytes: body.length });
      if (req.headers.authorization !== 'Bearer sk-test-0000000000000000') return send(401, { error: 'portal_login_required' });
      if (req.url === '/console/api/me') return send(200, { user: 'someone@example.test', admin: false, upload: true, domains: ['产品', '研发', '销售'], platforms: ['alpha', 'beta', 'gamma'],
        upload_scopes: [{ subject: 'dept:a', actions: ['upload'], domains: ['产品'], platforms: ['alpha', 'beta'] }], my_departments: [{ id: 'dept:a', name: '甲组', role: 'member' }] });
      if (req.url === '/console/api/upload') {
        const name = decodeURIComponent(req.headers['x-filename'] || '');
        if (name === '重复.md') return send(200, { doc_id: 'pl_' + 'a'.repeat(24), status: 'duplicate' });
        if (name === '越权.md') return send(403, { error: '所选大类/平台/区域不在你的上传授权内' });
        return send(200, { doc_id: 'pl_' + 'b'.repeat(24), status: 'queued', review: 'gating', dept: 'dept:a' });
      }
      send(404, { error: 'not_found' });
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${srv.address().port}/console`, seen, close: () => new Promise(d => srv.close(d)) })));
}
const TOKEN = 'sk-test-0000000000000000';

test('资料库地址：只认 https 和本机，不带账号、参数', () => {
  assert.equal(L.libraryBase({ library: { base: 'https://kb.example.test/console/' } }), 'https://kb.example.test/console');
  assert.equal(L.libraryBase({ library: { base: 'http://127.0.0.1:9/console' } }), 'http://127.0.0.1:9/console');
  for (const bad of ['http://kb.example.test/console', 'https://u:p@kb.example.test/x', 'https://kb.example.test/x?k=1', 'file:///etc', '', null]) assert.equal(L.libraryBase({ library: { base: bad } }), null);
  assert.equal(L.libraryBase({}), null);
});

test('能收资料的接入：启用、知识库、写了资料库地址', () => {
  const t = L.targets([
    { id: 'a', name: '公司知识库', knowledge: true, library: { base: 'https://kb.example.test/console' } },
    { id: 'b', name: '没写地址', knowledge: true },
    { id: 'c', name: '停用的', knowledge: true, enabled: false, library: { base: 'https://kb.example.test/console' } },
    { id: 'd', name: '不是知识库', library: { base: 'https://kb.example.test/console' } },
  ]);
  assert.deepEqual(t, [{ id: 'a', name: '公司知识库', base: 'https://kb.example.test/console' }]);
});

test('检查拖进来的文件：文件夹、类型、大小、重复、数量', () => {
  const stats = { '/t/说明.md': { isFile: true, size: 10 }, '/t/目录': { isDirectory: true, size: 0 }, '/t/程序.exe': { isFile: true, size: 10 }, '/t/空.txt': { isFile: true, size: 0 },
    '/t/大.pdf': { isFile: true, size: L.MAX_BYTES + 1 }, '/t/.env': { isFile: true, size: 5 }, '/t/图.PNG': { isFile: true, size: 2048 } };
  const stat = p => { if (!stats[p]) throw new Error('ENOENT'); return stats[p]; };
  const r = L.checkFiles(['/t/说明.md', '/t/说明.md', '/t/目录', '/t/程序.exe', '/t/空.txt', '/t/大.pdf', '/t/.env', '/t/图.PNG', '/t/没有.md', 42], stat);
  assert.equal(r.length, 8);
  assert.deepEqual(r.filter(x => x.ok).map(x => x.name), ['说明.md', '图.PNG']);
  const why = Object.fromEntries(r.filter(x => !x.ok).map(x => [x.name, x.reason]));
  assert.match(why['目录'], /文件夹/); assert.match(why['程序.exe'], /不收 \.exe/); assert.match(why['空.txt'], /空文件/); assert.match(why['大.pdf'], /超过/); assert.match(why['.env'], /隐藏/); assert.match(why['没有.md'], /读不到/);
  const many = Array.from({ length: L.MAX_FILES + 2 }, (_, i) => `/t/${i}.md`);
  const rr = L.checkFiles(many, () => ({ isFile: true, size: 1 }));
  assert.equal(rr.filter(x => x.ok).length, L.MAX_FILES); assert.match(rr.at(-1).reason, /最多/);
});

test('我能往哪里传：非管理员只列授权里的大类和平台，管理员全部', () => {
  const me = { user: 'someone@example.test', upload: true, domains: ['产品', '研发'], platforms: ['alpha', 'beta', 'gamma'], upload_scopes: [{ domains: ['产品'], platforms: ['alpha'] }, { domains: ['产品'], platforms: ['beta'] }], my_departments: [{ id: 'dept:a', name: '甲组' }] };
  const o = L.options(me);
  assert.deepEqual([o.canUpload, o.needDims, o.domains, o.platforms, o.depts], [true, true, ['产品'], ['alpha', 'beta'], [{ id: 'dept:a', name: '甲组' }]]);
  assert.deepEqual(L.options({ ...me, upload_scopes: [{ domains: ['*'], platforms: [] }] }).platforms, ['alpha', 'beta', 'gamma']);
  const a = L.options({ ...me, admin: true, upload_scopes: [] });
  assert.deepEqual([a.needDims, a.domains.length, a.platforms.length], [false, 2, 3]);
  assert.equal(L.options({ upload: false }).canUpload, false);
  assert.deepEqual(L.options(null).domains, []);
});

test('上传的请求头：文件名和中文都编码，没选的不带', () => {
  const h = L.uploadHeaders('需求 说明.md', { visibility: 'dept', domain: '产品', platform: 'alpha', dept: 'dept:a\r\nX-Evil: 1', tags: '规格，接口  排查' });
  assert.equal(h['X-Filename'], encodeURIComponent('需求 说明.md')); assert.equal(h['X-Visibility'], 'dept'); assert.equal(h['X-Domain'], encodeURIComponent('产品'));
  assert.equal(h['X-Dept'], 'dept:aX-Evil:1'); assert.equal(decodeURIComponent(h['X-Tags']), '规格,接口,排查');
  for (const v of Object.values(h)) assert.ok(!/[\r\n]/.test(v));
  const p = L.uploadHeaders('a.md'); assert.equal(p['X-Visibility'], 'all'); assert.ok(!('X-Domain' in p) && !('X-Dept' in p) && !('X-Tags' in p));
});

test('对着假资料库走一遍：取范围、上传、重复、越权、Key 不对', async () => {
  const s = await fakeLibrary();
  try {
    const o = await L.whoami({ base: s.base, token: TOKEN });
    assert.deepEqual([o.user, o.domains, o.platforms], ['someone@example.test', ['产品'], ['alpha', 'beta']]);
    const files = [{ path: '/t/新.md', name: '新.md', size: 3 }, { path: '/t/重复.md', name: '重复.md', size: 3 }, { path: '/t/越权.md', name: '越权.md', size: 3 }];
    const steps = [];
    const r = await L.uploadAll({ base: s.base, token: TOKEN, files, opts: { domain: '产品', platform: 'alpha' }, read: async () => Buffer.from('abc'), onStep: (i, it) => steps.push(`${i}:${it.status}`) });
    assert.deepEqual(r.map(x => x.status), ['queued', 'duplicate', 'failed']);
    assert.equal(r[0].docId, 'pl_' + 'b'.repeat(24)); assert.match(r[2].note, /不在你的上传授权内/);
    assert.deepEqual(steps, ['0:uploading', '0:queued', '1:uploading', '1:duplicate', '2:uploading', '2:failed']);
    const up = s.seen.filter(x => x.url === '/console/api/upload');
    assert.equal(up.length, 3); assert.equal(up[0].bytes, 3); assert.equal(decodeURIComponent(up[0].headers['x-domain']), '产品');
    await assert.rejects(L.whoami({ base: s.base, token: 'sk-wrong-000000000000000' }), /个人 Key 没有通过验证/);
    await assert.rejects(L.whoami({ base: s.base, token: '' }), /还没有填个人 Key/);
    let n = 0; const stopped = await L.uploadAll({ base: s.base, token: TOKEN, files: files.slice(0, 2), opts: {}, read: async () => Buffer.from('abc'), stopped: () => n++ > 0 });
    assert.deepEqual(stopped.map(x => x.status), ['queued', 'failed']); assert.equal(stopped[1].note, '已停止');
  } finally { await s.close(); }
});

test('不合规的文件不发请求', async () => {
  let called = 0; const fetchImpl = async () => { called++; throw new Error('不该到这里'); };
  await assert.rejects(L.uploadOne({ base: 'http://127.0.0.1:1/c', token: TOKEN, name: 'a.exe', data: Buffer.from('x'), fetchImpl }), /不收/);
  await assert.rejects(L.uploadOne({ base: 'http://127.0.0.1:1/c', token: TOKEN, name: 'a.md', data: Buffer.alloc(0), fetchImpl }), /空文件/);
  assert.equal(called, 0);
});
