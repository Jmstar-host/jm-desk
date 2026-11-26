/* 窗口坐标（1.8.2）：精灵贴左 / 上边时 Math.round 得到 -0，Electron 的 setPosition 不认 -0、也不认超出 32 位的数，1.8.1 在这里崩过 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../app/main/main.mjs', import.meta.url), 'utf8');
const px = new Function(src.match(/function px\(v\) \{[^\n]+\}/)[0] + '; return px;')();
test('坐标规整：-0 变 0，越界截到范围内，不是数的丢掉', () => {
  assert.ok(Object.is(px(-0.3), 0)); assert.ok(Object.is(px(-0), 0));
  assert.equal(px(12.6), 13); assert.equal(px(-12.6), -13);
  assert.equal(px(2 ** 31), 1e6); assert.equal(px(-1e12), -1e6);
  assert.equal(px(NaN), null); assert.equal(px(Infinity), null); assert.equal(px('x'), null);
  assert.ok(!/setPosition\(Math\.round/.test(src), '主进程不再直接用 Math.round 的结果挪窗口');
});
