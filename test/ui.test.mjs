/* 下拉框的模糊筛选（renderer/ui.js，1.4.4）：在不带浏览器的环境里取出匹配函数来测 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../app/renderer/ui.js', import.meta.url), 'utf8');
const ctx = { window: {}, document: { addEventListener() {} }, addEventListener() {} };
vm.runInNewContext(code, ctx);
const fuzzy = ctx.window.jmFuzzy;
const names = ['IOT 充值　eSIM › FMS 消费产品', 'IoT 卡资产运营', 'Marketplace ToB 营销平台', 'FMS 流量商城与支付', 'Device Manager 设备管理'];
const run = q => names.map(n => [n, fuzzy(n, q)]).filter(([, m]) => m).sort((a, b) => b[1].score - a[1].score).map(([n]) => n.split(/[　 ]/)[0]);

test('下拉框模糊筛选：不分大小写、多个词都要命中、按顺序出现的字也算、连续命中排前', () => {
  assert.deepEqual(run('iot'), ['IOT', 'IoT']);
  assert.deepEqual(run('营销 tob'), ['Marketplace']);
  assert.deepEqual(run('fms流量'), ['FMS'], '不打空格也行：字按顺序出现就算');
  assert.deepEqual(run('fms 流量'), ['FMS']);
  assert.deepEqual(run('设管'), ['Device'], '不连续的字按顺序也能命中');
  assert.equal(fuzzy('任何', '').score, 0);
  assert.deepEqual([...fuzzy('IoT 卡', 'iot').pos], [0, 1, 2]); // vm 里的数组，先拷成本地数组再比
});
