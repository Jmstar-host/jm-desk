/* 员工提醒：到点、每天一次、错过 30 分钟内补、只在设定的星期、配置纠错 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../app/main/reminders.mjs';

const at = (d, hm) => { const [h, m] = hm.split(':').map(Number); const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
const WED = new Date(2026, 10, 18), SAT = new Date(2026, 10, 21); // 2026-11-18 周三，11-21 周六
const cfg = R.normalize({ mealUrl: 'https://order.example.com', items: R.DEFAULTS.items });

test('默认三条：工作日 10:30 订饭、12:00 吃饭、18:00 下班', () => {
  assert.deepEqual(cfg.items.map(i => [i.label, i.time, R.daysText(i.days)]), [['订饭', '10:30', '工作日'], ['吃饭', '12:00', '工作日'], ['下班', '18:00', '工作日']]);
  assert.equal(R.urlFor(cfg, cfg.items[0]), 'https://order.example.com'); assert.equal(R.urlFor(cfg, cfg.items[1]), '');
});

test('到点才提醒；每天只提醒一次；错过 30 分钟内补，再晚不补', () => {
  assert.deepEqual(R.due(cfg, at(WED, '10:29'), {}).map(i => i.id), []);
  assert.deepEqual(R.due(cfg, at(WED, '10:30'), {}).map(i => i.id), ['meal-order']);
  assert.deepEqual(R.due(cfg, at(WED, '10:45'), { fired: { 'meal-order': '2026-11-18' } }), []);
  assert.deepEqual(R.due(cfg, at(WED, '11:00'), { fired: { 'meal-order': '2026-11-17' } }).map(i => i.id), ['meal-order'], '昨天提醒过不影响今天');
  assert.deepEqual(R.due(cfg, at(WED, '11:01'), {}), [], '超过 30 分钟不补');
});

test('只在设定的星期；关掉的不提醒；总开关关掉全部不提醒', () => {
  assert.deepEqual(R.due(cfg, at(SAT, '12:00'), {}), []);
  const c2 = R.normalize({ ...cfg, items: cfg.items.map(i => ({ ...i, enabled: i.id !== 'lunch' })) });
  assert.deepEqual(R.due(c2, at(WED, '12:00'), {}), []);
  assert.deepEqual(R.due(R.normalize({ ...cfg, enabled: false }), at(WED, '18:00'), {}), []);
});

test('今天的安排：按时间排序，标出已过和已提醒；周末为空', () => {
  const t = R.today(cfg, at(WED, '12:30'), { fired: { lunch: '2026-11-18' } });
  assert.deepEqual(t.map(x => [x.label, x.passed, x.fired]), [['订饭', true, false], ['吃饭', true, true], ['下班', false, false]]);
  assert.deepEqual(R.today(cfg, at(SAT, '12:00'), {}), []);
});

test('配置纠错：非法时间、星期、网址、id 都会被修正', () => {
  const c = R.normalize({ mealUrl: 'javascript:alert(1)', items: [{ id: 'Bad Id', label: '喝水提醒很长很长很长很长', time: '25:99', days: [0, 9, 3, 3], url: 'ftp://x' }, { time: '9:05' }] });
  assert.equal(c.mealUrl, ''); assert.equal(c.items[0].id, 'r1'); assert.equal(c.items[0].time, '09:00'); assert.deepEqual(c.items[0].days, [3]); assert.equal(c.items[0].url, '');
  assert.equal(c.items[0].label.length, 12); assert.equal(c.items[1].time, '09:05');
  assert.equal(R.daysText([6, 7]), '周末'); assert.equal(R.daysText([1, 3, 5]), '周一三五');
});
