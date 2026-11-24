/* 入口统一（1.3.0）：去掉的入口在旧布局里换成新的、去重；所有转向的目标都存在；默认布局合法 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, DEFAULT_LAYOUT, MOVED, migrateLayout, validateLayout } from '../app/main/catalog.mjs';

test('旧布局迁移：待办 / 需求池 / 汇总并进工作台，问知识并进助手，收集并进线索，平台 / 接入 / 形象并进设置', () => {
  const old = { version: 1, groups: [
    { id: 'work', label: '工作', icon: 'doc', color: ['#8b7cf6', '#60a5fa'], tip: '汇总、待办、需求池、知识', items: ['app.work', 'app.agent', 'app.summary', 'app.clues', 'app.tasks', 'app.pool', 'app.peers', 'app.knowledge'] },
    { id: 'mail', label: '邮箱', icon: 'mail', color: ['#38bdf8', '#818cf8'], items: ['mail.open', 'mail.report'] },
    { id: 'more', label: '设置', icon: 'sliders', color: ['#2dd4bf', '#a78bfa'], items: ['app.reminders', 'app.character', 'app.settings', 'app.connect', 'app.integrations', 'app.collect'] },
    { id: 'gone', label: '旧的', icon: 'doc', color: ['#8b7cf6', '#60a5fa'], items: ['app.tasks'] }] };
  const { layout, changed } = migrateLayout(old);
  assert.equal(changed, true);
  assert.deepEqual(layout.groups.map(g => [g.id, g.items]), [
    ['work', ['app.work', 'app.agent', 'app.clues', 'app.peers']], ['mail', ['mail.open']], ['more', ['app.reminders', 'app.settings']]]);
  assert.equal(layout.groups[0].tip, '助手、工作台、线索、搬运');
  assert.equal(validateLayout(layout).ok, true);
  assert.equal(migrateLayout(layout).changed, false, '迁移过的不再动');
});

test('去掉的入口不在目录里；每个转向目标都存在；默认布局合法，主窗口三个页面都在', () => {
  for (const [id, [to]] of Object.entries(MOVED)) { assert.equal(CATALOG[id], undefined, id); assert.ok(CATALOG[to], `${id} → ${to}`); }
  assert.equal(validateLayout(DEFAULT_LAYOUT).ok, true);
  const all = DEFAULT_LAYOUT.groups.flatMap(g => g.items);
  for (const k of ['app.agent', 'app.work', 'app.clues', 'app.peers', 'app.settings']) assert.ok(all.includes(k), k);
  assert.equal(CATALOG['app.work'].count, 'tasks', '待办数挂在工作台上');
});
