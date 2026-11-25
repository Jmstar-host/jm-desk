/* 系统占用和精灵的动作快慢（1.7.0，参考 RunCat）：占用越高动作越快；第一层加「占用」气泡一次 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuBusy, parseVmStat, tempoFor, loadFor } from '../app/main/sysload.mjs';
import { migrateLayout, validateLayout, DEFAULT_LAYOUT } from '../app/main/catalog.mjs';

test('CPU：两次采样之间非空闲时间的占比；内存按 vm_stat 的活动 + 联动 + 压缩页算', () => {
  assert.equal(cpuBusy({ idle: 100, total: 200 }, { idle: 130, total: 300 }), 0.7);
  assert.equal(cpuBusy({ idle: 1, total: 1 }, { idle: 1, total: 1 }), 0);
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      1000.\nPages active:    200000.\nPages wired down:  100000.\nPages occupied by compressor:  100000.\n';
  assert.equal(parseVmStat(vm, 16384 * 800000), 0.5);
  assert.equal(parseVmStat('乱七八糟', 1000), null);
});

test('动作快慢：三成以下正常速度，九成以上 3.5 倍，中间平滑；CPU + 内存取平均，关掉恒为正常', () => {
  assert.equal(tempoFor(0.1), 1); assert.equal(tempoFor(0.3), 1); assert.equal(tempoFor(0.95), 3.5);
  assert.ok(tempoFor(0.6) > 1.5 && tempoFor(0.6) < 3);
  assert.equal(loadFor('cpu', 0.8, 0.6), 0.8); assert.equal(loadFor('cpu+mem', 0.8, 0.6), 0.7); assert.equal(loadFor('off', 0.9, 0.9), 0);
  assert.equal(tempoFor(loadFor('off', 0.9, 0.9)), 1);
});

test('第一层「占用」气泡：默认有；旧布局迁移时加一次，删掉后不再加回来', () => {
  const v = validateLayout(DEFAULT_LAYOUT); assert.ok(v.ok, v.errors.join()); assert.equal(v.layout.groups.find(g => g.id === 'load').action, 'sys.load');
  const old = { version: 1, groups: [{ id: 'play', label: '互动', icon: 'magic', color: ['#ec4899', '#3b82f6'], items: ['skill.loop'] }, { id: 'more', label: '设置', icon: 'sliders', color: ['#17141f', '#3b82f6'], items: ['app.settings'] }] };
  const m = migrateLayout(old); assert.equal(m.changed, true); assert.deepEqual(m.layout.groups.map(g => g.id), ['play', 'load', 'more']); assert.ok(validateLayout(m.layout).ok);
  const removed = { ...validateLayout(m.layout).layout, groups: m.layout.groups.filter(g => g.id !== 'load') };
  const again = migrateLayout(removed); assert.equal(again.changed, false); assert.deepEqual(again.layout.groups.map(g => g.id), ['play', 'more']);
});

test('平滑：一次尖峰只抬一点，持续忙几次后才接近真实值', async () => {
  const { smooth } = await import('../app/main/sysload.mjs');
  let v = smooth(null, 0.2); assert.equal(v, 0.2);
  v = smooth(v, 1); assert.ok(v < 0.6, '一次尖峰');
  for (let i = 0; i < 6; i++) v = smooth(v, 1); assert.ok(v > 0.95, '持续忙');
});

test('1.8.0「互动」里加「连招」一次：放得下才加，删掉后不再加回来；新技能都在目录里', async () => {
  const { CATALOG } = await import('../app/main/catalog.mjs');
  for (const id of ['skill.combo', 'skill.psywave', 'skill.orb', 'skill.meteor', 'skill.spark', 'skill.swirl']) assert.equal(CATALOG[id]?.kind, 'skill', id);
  assert.ok(DEFAULT_LAYOUT.groups.find(g => g.id === 'play').items.includes('skill.combo'));
  const old = { version: 1, groups: [{ id: 'play', label: '互动', icon: 'magic', color: ['#ec4899', '#3b82f6'], items: ['skill.loop'] }, { id: 'more', label: '设置', icon: 'sliders', color: ['#17141f', '#3b82f6'], items: ['app.settings'] }] };
  const m = migrateLayout(old); assert.deepEqual(m.layout.groups.find(g => g.id === 'play').items, ['skill.loop', 'skill.combo']); assert.ok(validateLayout(m.layout).ok);
  const removed = { ...m.layout, groups: m.layout.groups.map(g => g.id === 'play' ? { ...g, items: ['skill.loop'] } : g) };
  assert.deepEqual(migrateLayout(removed).layout.groups.find(g => g.id === 'play').items, ['skill.loop']);
  const full = { version: 1, groups: [{ id: 'play', label: '互动', icon: 'magic', color: ['#ec4899', '#3b82f6'], items: ['skill.teleport', 'skill.burst', 'skill.orbit', 'skill.zoom', 'skill.sparkle', 'skill.loop', 'skill.wave', 'app.settings'] }] };
  assert.equal(migrateLayout(full).layout.groups[0].items.length, 8, '满 8 个不再加');
});
