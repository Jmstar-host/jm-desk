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
    ['work', ['app.work', 'app.agent', 'app.clues', 'app.peers']], ['meet', []], ['mail', ['mail.open']], ['more', ['app.reminders', 'app.settings']]]); // 1.4.2 第一层加了「会议」
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

test('色板（1.3.1）：分组颜色对齐到粉 / 蓝 / 黑 + 紫绿橙红；默认布局只用色板里的颜色；和 tokens.css 一致', async () => {
  const { PALETTE, snapColor } = await import('../app/main/catalog.mjs');
  const fs = await import('node:fs');
  assert.equal(snapColor('#f472b6'), PALETTE.pink); assert.equal(snapColor('#60a5fa'), PALETTE.blue); assert.equal(snapColor('#2e1f40'), PALETTE.black);
  assert.equal(snapColor('#a78bfa'), PALETTE.violet); assert.equal(snapColor('not-a-color'), PALETTE.pink);
  const all = Object.values(PALETTE);
  for (const g of DEFAULT_LAYOUT.groups) for (const c of g.color) assert.ok(all.includes(c), `${g.id} ${c}`);
  const v = validateLayout({ version: 1, groups: [{ id: 'x', label: '设置', icon: 'magic', color: ['#2dd4bf', '#ff00aa'], items: ['app.settings'] }] });
  assert.ok(v.layout.groups[0].color.every(c => all.includes(c)), '旧颜色、AI 乱选的颜色都被对齐');
  const tokens = fs.readFileSync(new URL('../app/renderer/tokens.css', import.meta.url), 'utf8');
  for (const [k, c] of Object.entries(PALETTE)) assert.match(tokens, new RegExp(`--${k}:${c}`), `tokens.css 的 --${k}`);
});

test('旧默认分组颜色迁移成新色板的默认颜色', () => {
  const { layout, changed } = migrateLayout({ version: 1, groups: [{ id: 'work', label: '工作', icon: 'doc', color: ['#8b7cf6', '#60a5fa'], items: ['app.work', 'app.settings'] }, { id: 'x', label: '自定', icon: 'doc', color: ['#2dd4bf', '#a78bfa'], items: ['app.agent'] }] });
  assert.equal(changed, true); const g = id => layout.groups.find(x => x.id === id); assert.deepEqual(g('work').color, ['#ec4899', '#3b82f6']); assert.deepEqual(g('x').color, ['#17141f', '#3b82f6']);
});
