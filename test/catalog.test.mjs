/* 入口统一（1.3.0）：去掉的入口在旧布局里换成新的、去重；所有转向的目标都存在；默认布局合法 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, DEFAULT_LAYOUT, MOVED, migrateLayout, validateLayout } from '../app/main/catalog.mjs';
import { elementSkillNames } from '../app/renderer/element-fx.mjs';

test('元素技能并在「互动」里（1.10.4）：旧布局迁移时补进去；已经放在别处的不重复；用户自定义分组不动', () => {
  const skillIds = elementSkillNames.map(name => 'skill.' + name);
  assert.ok(skillIds.every(id => CATALOG[id].kind === 'skill'));
  assert.equal(DEFAULT_LAYOUT.groups.some(g => g.id === 'elements'), false);
  assert.ok(skillIds.every(id => DEFAULT_LAYOUT.groups.find(g => g.id === 'play').items.includes(id)));
  // 很旧的布局：还没有元素技能，其中一个被用户放在了「工作」里
  const old = { version: 1, seen: ['load', 'combo'], groups: [
    { id: 'play', label: '互动', icon: 'magic', color: ['#ec4899', '#8b5cf6'], tip: '放技能、翻跟头、撒爱心', items: ['skill.teleport', 'skill.wave'] },
    { id: 'work', label: '工作', icon: 'doc', color: ['#ec4899', '#3b82f6'], tip: '助手、工作台、线索、串门', items: ['app.work', 'app.settings', skillIds[0]] },
    { id: 'custom', label: '我的', icon: 'burst', color: ['#8b5cf6', '#3b82f6'], items: ['skill.orb'] }] };
  const { layout } = migrateLayout(structuredClone(old));
  assert.deepEqual(layout.groups.map(g => g.id), ['play', 'chat', 'work', 'custom']);
  assert.deepEqual(layout.groups[0].items, ['skill.teleport', 'skill.wave', ...skillIds.slice(1)]);
  assert.deepEqual(layout.groups[2], old.groups[1]); assert.deepEqual(layout.groups[3], old.groups[2]);
  assert.equal(validateLayout(layout).ok, true); assert.equal(migrateLayout(layout).changed, false, '迁移过的不再动');
});

test('1.10.3 的默认布局：「元素」并进「互动」，第一层多一个「聊天」；删掉后不再加回来', () => {
  const skillIds = elementSkillNames.map(name => 'skill.' + name), base = DEFAULT_LAYOUT.groups;
  const old = { version: 1, seen: ['meet', 'load', 'combo', 'elements'], groups: [
    { id: 'play', label: '互动', icon: 'magic', color: ['#ec4899', '#8b5cf6'], tip: '放技能、翻跟头、撒爱心', items: ['skill.teleport', 'skill.burst', 'skill.orbit', 'skill.zoom', 'skill.sparkle', 'skill.loop', 'skill.wave', 'skill.combo'] },
    { id: 'elements', label: '元素', icon: 'burst', color: ['#8b5cf6', '#3b82f6'], tip: '火、水、电、叶、冰五种特效', items: skillIds },
    ...structuredClone(base.filter(g => !['play', 'chat'].includes(g.id)))] };
  const { layout, changed } = migrateLayout(structuredClone(old));
  assert.equal(changed, true);
  assert.deepEqual(layout.groups.map(g => g.id), ['play', 'chat', 'load', 'work', 'mail', 'more']);
  assert.equal(layout.groups[0].items.length, 13); assert.equal(layout.groups[0].tip, '放技能、翻跟头、元素特效'); assert.equal(layout.groups[1].action, 'app.chat');
  assert.equal(validateLayout(layout).ok, true); assert.equal(migrateLayout(layout).changed, false);
  // 用户把「元素」改了名字：是他自己的分组，不并；第一层已经 6 个，聊天也加不进去
  const mine = structuredClone(old); mine.groups[1].label = '我的元素';
  assert.deepEqual(migrateLayout(mine).layout.groups.map(g => g.id), ['play', 'elements', 'load', 'work', 'mail', 'more']);
  // 删掉「聊天」后不再加回来
  layout.groups = layout.groups.filter(g => g.id !== 'chat'); assert.equal(migrateLayout(layout).changed, false);
  // 一组最多 14 个
  const many = structuredClone(DEFAULT_LAYOUT); many.groups[0].items.push('skill.psywave'); assert.equal(validateLayout(many).ok, true);
  many.groups[0].items.push('skill.orb'); assert.match(validateLayout(many).errors.join(), /最多 14 个/);
});

test('旧布局迁移：待办 / 需求池 / 汇总并进工作台，问知识并进助手，收集并进线索，平台 / 接入 / 形象并进设置', () => {
  const old = { version: 1, groups: [
    { id: 'work', label: '工作', icon: 'doc', color: ['#8b7cf6', '#60a5fa'], tip: '汇总、待办、需求池、知识', items: ['app.work', 'app.agent', 'app.summary', 'app.clues', 'app.tasks', 'app.pool', 'app.peers', 'app.knowledge'] },
    { id: 'mail', label: '邮箱', icon: 'mail', color: ['#38bdf8', '#818cf8'], items: ['mail.open', 'mail.report'] },
    { id: 'more', label: '设置', icon: 'sliders', color: ['#2dd4bf', '#a78bfa'], items: ['app.reminders', 'app.character', 'app.settings', 'app.connect', 'app.integrations', 'app.collect'] },
    { id: 'gone', label: '旧的', icon: 'doc', color: ['#8b7cf6', '#60a5fa'], items: ['app.tasks'] }] };
  const { layout, changed } = migrateLayout(old);
  assert.equal(changed, true);
  assert.deepEqual(layout.groups.map(g => [g.id, g.items]), [
    ['work', ['app.work', 'app.agent', 'app.clues', 'app.peers']], ['load', []], ['mail', ['mail.open']], ['more', ['app.reminders', 'app.settings']], ['chat', []]]); // 1.7.0 第一层加了「占用」，1.10.4 加了「聊天」（没有「互动」分组时排在最后）
  assert.equal(layout.groups[0].tip, '助手、工作台、线索、串门');
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
