/* D87：工作台以 MP2 为准——拉取合并、保存回写、只读字段、绑定去重、待归入建议、按平台产品分组 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wm from '../app/main/workmodel.mjs';

const TREE = { origin: 'global', nodes: [{ key: 'gl:L1', kind: 'line', name: 'eSIM', path: [], children: [
  { key: 'product:117', kind: 'product', name: '商城与支付', code: 'BP-MALL', product_id: 117, path: ['eSIM'], children: [
    { key: 'project:1', kind: 'project', name: '云帆出行', code: 'PRJ-0001', product_id: 117, project_id: 1, path: ['eSIM', '商城与支付'], state: 'active',
      planned_start: '2026-10-26', planned_end: '2026-11-30', revision: 3, requirement_ids: [11], children: [] }] },
  { key: 'product:119', kind: 'product', name: '设备平台', product_id: 119, path: ['eSIM'], children: [] }] }] };
const REQS = [
  { id: 11, code: 'REQ-0011', title: '优惠券试算接口', description: '提供可通过试算的优惠券查询接口', priority: 'P1', status: 'clarified', product_id: 117, expected_date: '2026-12-01', requirement_type: '优化' },
  { id: 12, code: 'REQ-0012', title: 'eIM 批量下载', description: 'd', priority: 'P3', status: 'draft', product_id: 119 },
];

test('拉取：项目与需求落成工作；需求按 requirement_ids 挂到项目，其余挂在平台产品下；MP2 字段以平台为准', () => {
  const taxonomy = wm.flattenPortfolio(TREE), work = [];
  const r = wm.mergeMp2(work, { taxonomy, requirements: REQS, now: 'T' });
  assert.deepEqual(r, { added: 3, updated: 0, missing: 0 });
  const p = work.find(w => w.id === 'm2j_1'), a = work.find(w => w.id === 'm2r_11'), b = work.find(w => w.id === 'm2r_12');
  assert.deepEqual([p.level, p.title, p.product, p.deadline, p.mp2.revision], ['project', '云帆出行', '商城与支付', '2026-11-30', 3]);
  assert.deepEqual([a.parentId, a.priority, a.type, a.deadline, a.summary, a.mp2Status.label], ['m2j_1', 'high', 'change', '2026-12-01', '提供可通过试算的优惠券查询接口', '已澄清待排期']);
  assert.deepEqual([b.parentId, b.product, b.priority], [null, '设备平台', 'low']);
  // 平台改了标题：再拉一次就更新，记入 history
  wm.mergeMp2(work, { taxonomy, requirements: [{ ...REQS[0], title: '优惠券试算接口 v2' }, REQS[1]], now: 'T2' });
  assert.equal(a.title, '优惠券试算接口 v2'); assert.equal(a.history.at(-1).by, 'mp2');
  // 平台删了：标「找不到」，不删本地
  const m = wm.mergeMp2(work, { taxonomy, requirements: [REQS[0]], now: 'T3' });
  assert.equal(m.missing, 1); assert.equal(b.mp2Status.found, false);
});

test('回写：只送改动字段；层级 / 上级 / 状态只读；项目带 revision、平台产品固定；失败标待回写、拉取不覆盖', () => {
  const taxonomy = wm.flattenPortfolio(TREE), work = [];
  wm.mergeMp2(work, { taxonomy, requirements: REQS, now: 'T' });
  const a = work.find(w => w.id === 'm2r_11'), p = work.find(w => w.id === 'm2j_1');
  assert.equal(wm.mp2Patch(a, { taxonomy }), null, '没改就不回写');
  wm.editItem(work, a.id, { summary: '补充：需要支持多币种', priority: 'low', level: 'requirement', status: 'open' });
  const patch = wm.mp2Patch(a, { taxonomy });
  assert.deepEqual(patch, { kind: 'requirement', id: 11, fields: ['summary', 'priority'], body: { description: '补充：需要支持多币种', priority: 'P3' } });
  assert.throws(() => wm.editItem(work, a.id, { status: 'done' }), /以平台为准/);
  assert.throws(() => wm.editItem(work, a.id, { parentId: null }), /以平台为准/);
  // 改平台产品：送 scope 与 business_project_id
  wm.editItem(work, a.id, { product: '设备平台', productId: 'mp2:p:119' });
  assert.deepEqual(wm.mp2Patch(a, { taxonomy }).body.business_project_id, 119);
  // 失败：标待回写；再拉取时保留本地值
  const pt = wm.mp2Patch(a, { taxonomy }); wm.markMp2Failed(a, pt, 'MP2 拒绝');
  wm.mergeMp2(work, { taxonomy, requirements: REQS, now: 'T2' });
  assert.equal(a.summary, '补充：需要支持多币种'); assert.equal(a.productId, 'mp2:p:119');
  wm.markMp2Pushed(a, pt, {}); assert.equal(a.mp2Dirty, undefined); assert.equal(wm.mp2Patch(a, { taxonomy }), null);
  // 项目：名称 + revision；平台产品不能改
  wm.editItem(work, p.id, { title: '云帆出行 二期', deadline: '2026-12-31' });
  assert.deepEqual(wm.mp2Patch(p, { taxonomy }).body, { name: '云帆出行 二期', revision: 3, planned_end: '2026-12-31' });
  wm.markMp2Pushed(p, wm.mp2Patch(p, { taxonomy }), { revision: 4 }); assert.equal(p.mp2.revision, 4);
  assert.throws(() => wm.editItem(work, p.id, { productId: 'mp2:p:119', product: '设备平台' }), /以平台为准/);
  // AI 整理不能改平台记录的标题
  wm.applyReorg(work, { changes: [{ id: a.id, level: 'todo', reason: 'x' }] }, { taxonomy });
  assert.equal(a.level, 'requirement');
});

test('本地工作绑定到已拉取的记录：拉取副本并进来（下级、线索转过去），只留一条', () => {
  const taxonomy = wm.flattenPortfolio(TREE), work = [{ id: 'w_local', level: 'requirement', title: '试算优惠券', sids: ['s1'], status: 'open' }];
  wm.mergeMp2(work, { taxonomy, requirements: REQS, now: 'T' });
  work.push({ id: 't1', level: 'todo', title: '回复客户', parentId: 'm2r_11', status: 'open' });
  wm.bindMp2(work, 'w_local', { id: 11, code: 'REQ-0011', title: '优惠券试算接口' }, { taxonomy, now: 'T2' });
  assert.equal(wm.foldMp2Duplicates(work), 1);
  assert.equal(work.find(w => w.id === 'm2r_11'), undefined);
  const keep = work.find(w => w.id === 'w_local');
  assert.equal(keep.title, '优惠券试算接口'); assert.ok(keep.mp2Base); assert.equal(work.find(w => w.id === 't1').parentId, 'w_local');
  wm.mergeMp2(work, { taxonomy, requirements: REQS, now: 'T3' });
  assert.equal(work.filter(w => w.mp2?.id === 11).length, 1, '再拉取也不会多出副本');
});

test('待归入：AI 建议只接受列出的平台产品 / 项目 / 需求；分组按平台产品，认不出的进待归入', () => {
  const taxonomy = wm.flattenPortfolio(TREE), work = [
    { id: 'lp', level: 'project', title: '云帆出行优惠券试算', status: 'open', line: '云帆出行' },
    { id: 'lr', level: 'requirement', title: '修复合作方 H5首轮核查问题', status: 'open', line: '本地充值' },
    { id: 'lt', level: 'todo', title: '确认SGP.22功能限制', status: 'open', line: 'eSIM' },
    { id: 'lx', level: 'todo', title: '编造的', status: 'open' }];
  wm.mergeMp2(work, { taxonomy, requirements: REQS, now: 'T' });
  assert.match(wm.packUnaligned(work), /lp｜项目/);
  const n = wm.applySuggest(work, { items: [
    { id: 'lp', action: 'bind', mp2_id: 1, reason: '同一个项目' }, { id: 'lr', action: 'create', product: '商城与支付' },
    { id: 'lt', action: 'anchor', product: '设备平台' }, { id: 'lx', action: 'anchor', product: '不存在的产品' }, { id: 'm2r_11', action: 'bind', mp2_id: 11 }] }, { taxonomy, now: 'T' });
  assert.equal(n, 3);
  assert.deepEqual(work.find(w => w.id === 'lp').mp2Suggest.code, 'PRJ-0001');
  assert.equal(work.find(w => w.id === 'lr').mp2Suggest.productMp2Id, 117);
  assert.equal(work.find(w => w.id === 'lx').mp2Suggest, undefined);
  const g = wm.tree(work, { taxonomy });
  assert.deepEqual(g.groups.map(x => x.label), ['eSIM › 商城与支付', 'eSIM › 设备平台', '待归入需求管理平台']);
  assert.deepEqual(g.groups.at(-1).items.map(x => x.id).sort(), ['lp', 'lr', 'lt', 'lx']);
});

/* ---------- 客户端：分页拉全部需求、回写需求、新建 / 改项目（本机假平台，调用体 snake_case） ---------- */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-mp2.mjs';
import * as mp2 from '../src/mp2.mjs';

test('客户端：拉全部需求（分页）、回写需求、新建项目、改项目（revision 冲突给出可读原因）', async () => {
  const ops = ['GET:/api/requirement/list', 'PUT:/api/requirement/{id}', 'POST:/api/v1/plans/projects', 'PUT:/api/v1/plans/projects/{id}', 'GET:/api/v1/plans/projects'];
  const requirements = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, requirement_code: `REQ-000${i + 1}`, title: 't' + i, business_project_id: 117, priority: 'P2', status: 'draft' }));
  const mock = await startMock({ grants: ops, requirements, scope: [117] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmd-truth-')), credentialFile = path.join(dir, 'c.json');
  fs.writeFileSync(credentialFile, JSON.stringify({ token: 'test-token' }));
  const cfg = { mp2: { baseUrl: mock.url, credentialFile } };
  try {
    const all = await mp2.listRequirements(cfg, { pageSize: 2 });
    assert.equal(all.length, 5); assert.deepEqual(Object.keys(all[0]).slice(0, 3), ['id', 'code', 'title']); assert.equal(all[0].product_id, 117);
    await mp2.updateRequirement(cfg, 2, { description: '补充', priority: 'P1' });
    assert.deepEqual(mock.updates[0], { id: 2, body: { description: '补充', priority: 'P1' } });
    await assert.rejects(mp2.updateRequirement(cfg, 2, { business_project_id: 5, scope_type: 'product', scope_id: 5 }), /负责范围/);
    const pr = await mp2.createProject(cfg, { business_project_id: 117, name: '合作方 H5', source: 'product' });
    assert.equal(pr.project_code, 'PRJ-0500');
    await assert.rejects(mp2.createProject(cfg, { business_project_id: 117, name: '合作方 H5', source: 'product' }), /同名项目/);
    // 改项目是整体提交：只改名称时，平台上已有的说明和起止要原样带回去，不能被清空
    Object.assign(mock.projects.find(x => x.id === pr.id), { description: '面向合作方的 H5 入口', planned_start: '2026-11-01', planned_end: '2026-12-15' });
    const up = await mp2.updateProject(cfg, pr.id, { name: '合作方 H5 二期', revision: 0 }, { productId: 117 }); assert.equal(up.revision, 1);
    assert.deepEqual([up.name, up.description, up.planned_start, up.planned_end, up.startFilled], ['合作方 H5 二期', '面向合作方的 H5 入口', '2026-11-01', '2026-12-15', false]);
    const up2 = await mp2.updateProject(cfg, pr.id, { name: '合作方 H5 二期', planned_end: '2026-12-31', revision: 1 }, { productId: 117 });
    assert.deepEqual([up2.description, up2.planned_start, up2.planned_end], ['面向合作方的 H5 入口', '2026-11-01', '2026-12-31'], '只改结束日期，说明和开始不动');
    await assert.rejects(mp2.updateProject(cfg, pr.id, { name: 'x', revision: 0 }, { productId: 117 }), /刚被别人改过/);
    await assert.rejects(mp2.updateProject(cfg, pr.id, { name: 'x', revision: 2 }), /不知道这个项目在哪个平台产品下/, '读不到当前值就不提交，宁可不改也不清空');
    await assert.rejects(mp2.updateProject(cfg, 9999, { name: 'x', revision: 0 }, { productId: 117 }), /找不到这个项目/);
    // 起止成对：平台上没有起止的项目，本地只定了结束时，开始按今天补（今天晚于结束就同一天）
    const bare = await mp2.createProject(cfg, { business_project_id: 117, name: '没有排期的项目', source: 'product' }); assert.equal(bare.startFilled, false);
    const up3 = await mp2.updateProject(cfg, bare.id, { name: '没有排期的项目', planned_end: '2099-01-31', revision: 0 }, { productId: 117 });
    assert.equal(up3.startFilled, true); assert.equal(up3.planned_start, new Date().toISOString().slice(0, 10)); assert.equal(up3.planned_end, '2099-01-31');
    const past = await mp2.createProject(cfg, { business_project_id: 117, name: '补录的老项目', planned_end: '2020-01-31', source: 'product' });
    assert.deepEqual([past.planned_start, past.planned_end, past.startFilled], ['2020-01-31', '2020-01-31', true]);
    const d = {}; assert.equal(mp2.pairDates(d), false); assert.throws(() => mp2.pairDates({ planned_start: '2026-01-01' }), /同时填写/);
  } finally { mock.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('连接所有者没有写权限（403 forbidden）：说清楚是账号权限的问题，不是连接没勾', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmd-owner-')), credentialFile = path.join(dir, 'c.json');
  fs.writeFileSync(credentialFile, JSON.stringify({ token: 'test-token' }));
  const ops = ['PUT:/api/requirement/{id}', 'POST:/api/v1/plans/projects', 'POST:/api/requirement'];
  const mock = await startMock({ grants: ops, requirements: [{ id: 1, title: 't', business_project_id: 117 }], ownerForbidden: ops });
  const cfg = { mp2: { baseUrl: mock.url, credentialFile } };
  try {
    for (const run of [() => mp2.updateRequirement(cfg, 1, { priority: 'P1' }), () => mp2.createProject(cfg, { business_project_id: 117, name: 'x', source: 'product' }), () => mp2.createRequirement(cfg, { title: 'x' })])
      await assert.rejects(run(), e => /账号没有这项写权限/.test(e.message) && e.status === 403 && e.final === true);
    await assert.rejects(mp2.updateProject(cfg, 1, { name: 'x', revision: 0 }, { productId: 117 }), /没有这项操作的权限/, '连接没勾读取项目时仍按「连接没勾」提示');
  } finally { mock.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
