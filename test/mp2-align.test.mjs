import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenPortfolio, bindMp2, unbindMp2, applyMp2Status, mp2RequirementDraft } from '../app/main/workmodel.mjs';

const TREE = {
  origin: 'global',
  nodes: [{ key: 'gl:L1', kind: 'line', name: 'eSIM', path: [], children: [
    { key: 'gl:L2', kind: 'line', name: '消费产品', path: ['eSIM'], children: [
      { key: 'product:117', kind: 'product', name: '商城与支付', code: 'BP-MALL', product_id: 117, path: ['eSIM', '消费产品'], children: [
        { key: 'project:1', kind: 'project', name: '云帆出行', code: 'PRJ-0001', product_id: 117, project_id: 1, path: ['eSIM', '消费产品', '商城与支付'], state: 'active', planned_start: '2026-10-26', planned_end: '2026-11-30', children: [] },
      ] },
    ] },
  ] }],
};

test('产品项目计划的树拍平成产品线 / 平台产品 / 项目', () => {
  const t = flattenPortfolio(TREE);
  assert.equal(t.source, 'mp2-portfolio');
  assert.deepEqual(t.lines.map(l => l.path), ['eSIM', 'eSIM › 消费产品']);
  assert.equal(t.products[0].id, 'mp2:p:117');
  assert.equal(t.products[0].lineId, 'mp2:gl:L2');
  assert.deepEqual({ id: t.projects[0].id, productId: t.projects[0].productId, state: t.projects[0].state }, { id: 'mp2:j:1', productId: 'mp2:p:117', state: 'active' });
});

test('项目绑定 MP2 项目时归属跟着走；人锁过的字段不动；待办不能绑定', () => {
  const taxonomy = flattenPortfolio(TREE);
  const work = [
    { id: 'p1', level: 'project', title: '云帆出行', line: '旧线', product: '', locked: ['line'] },
    { id: 't1', level: 'todo', title: '回复客户' },
  ];
  bindMp2(work, 'p1', { id: 1 }, { taxonomy, now: 'T' });
  assert.deepEqual(work[0].mp2, { kind: 'project', id: 1, code: 'PRJ-0001', title: '云帆出行', productId: 117, boundAt: 'T' });
  assert.equal(work[0].product, '商城与支付');
  assert.equal(work[0].line, '旧线');
  assert.equal(work[0].history.at(-1).note, '绑定需求管理平台 PRJ-0001');
  assert.throws(() => bindMp2(work, 't1', { id: 1 }, { taxonomy }), /只有项目和需求/);
  assert.throws(() => bindMp2(work, 'p1', { id: 99 }, { taxonomy }), /产品树里没有这个项目/);
});

test('需求绑定后回流 MP2 状态、需求计划与所属功能；解绑清掉', () => {
  const taxonomy = flattenPortfolio(TREE);
  const work = [{ id: 'r1', level: 'requirement', title: '恢复寄送信息提示' }, { id: 'p1', level: 'project', title: 'X' }];
  bindMp2(work, 'r1', { id: 2, code: 'REQ-0002', title: '1' }, { taxonomy, now: 'T' });
  bindMp2(work, 'p1', { id: 1 }, { taxonomy, now: 'T' });
  const n = applyMp2Status(work, { taxonomy, now: 'T2', links: [{ requirement_id: 2, code: 'REQ-0002', title: '寄送提示', visible_status: '待开发',
    functions: [{ id: 5, title: '首页设备列表', via: 'plan' }],
    plans: [{ plan_code: 'PLAN-1', plan_name: '一期', delivery_status: 'dev_pending', planned_start: '2026-11-23', planned_end: '2026-12-23' }] }] });
  assert.equal(n, 2);
  assert.equal(work[0].mp2.title, '寄送提示');
  assert.equal(work[0].mp2Status.label, '待开发');
  assert.deepEqual(work[0].mp2Status.plans[0], { code: 'PLAN-1', name: '一期', delivery: 'dev_pending', label: '待开发', start: '2026-11-23', end: '2026-12-23' });
  assert.equal(work[0].mp2Status.functions[0].title, '首页设备列表');
  assert.equal(work[1].mp2Status.label, '进行中');
  unbindMp2(work, 'r1', { now: 'T3' });
  assert.equal(work[0].mp2, undefined);
  assert.equal(work[0].mp2Status, undefined);
});

test('MP2 里找不到时标出，不抛错', () => {
  const taxonomy = flattenPortfolio(TREE);
  const work = [{ id: 'r1', level: 'requirement', title: 'a', mp2: { kind: 'requirement', id: 404 } }];
  applyMp2Status(work, { taxonomy, links: [] });
  assert.equal(work[0].mp2Status.found, false);
});

/* ---------- 客户端：经 AI 通道读产品项目计划的树、搜需求、读需求进度（本机假平台） ---------- */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-mp2.mjs';
import * as mp2 from '../src/mp2.mjs';

test('经 AI 通道读树、搜需求、读需求进度；未授权时报 operation_not_granted', async () => {
  const OPS = ['GET:/api/v1/plans/portfolio/tree', 'GET:/api/requirement/list', 'GET:/api/v1/plans/targets/by-requirements'];
  const mock = await startMock({ grants: OPS, portfolio: TREE,
    requirements: [{ id: 2, requirement_code: 'REQ-0002', title: '寄送提示', visible_status: '待开发' }, { id: 3, requirement_code: 'REQ-0003', title: '别的', status: 'draft' }],
    links: [{ requirement_id: 2, code: 'REQ-0002', plans: [{ plan_code: 'PLAN-1', delivery_status: 'dev_pending' }], functions: [] }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmd-align-'));
  const credentialFile = path.join(dir, 'cred.json'); fs.writeFileSync(credentialFile, JSON.stringify({ token: 'test-token' }));
  const cfg = { mp2: { baseUrl: mock.url, credentialFile } };
  try {
    const tree = await mp2.portfolioTree(cfg);
    assert.equal(flattenPortfolio(tree).projects[0].code, 'PRJ-0001');
    assert.deepEqual(await mp2.searchRequirements(cfg, '寄送'), [{ id: 2, code: 'REQ-0002', title: '寄送提示', status: '待开发' }]);
    assert.deepEqual(await mp2.searchRequirements(cfg, '  '), []);
    const links = await mp2.requirementLinks(cfg, [2, 2, 'x']);
    assert.equal(links[0].plans[0].delivery_status, 'dev_pending');
    assert.equal(mock.calls.at(-1).query.requirementIds, '2');
  } finally { mock.close(); }
  const denied = await startMock({ grants: [] });
  try {
    await assert.rejects(mp2.portfolioTree({ mp2: { baseUrl: denied.url, credentialFile } }), /operation_not_granted/);
  } finally { denied.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---------- D87：本地需求上传为 MP2 原始需求 ---------- */
test('上传草稿：只上传未绑定的需求；挂平台产品；说明带上级、提出人、交期与依据', () => {
  const taxonomy = flattenPortfolio(TREE);
  const work = [
    { id: 'p1', level: 'project', title: '云帆出行', mp2: { kind: 'project', id: 1, code: 'PRJ-0001' } },
    { id: 'r1', level: 'requirement', type: 'bug', title: '寄送信息提示丢失', summary: '下单后看不到寄送信息', parentId: 'p1', who: '王五', priority: 'high',
      deadline: '2026-12-01', deadline_quote: '12月初', product: '商城与支付', productId: 'mp2:p:117' },
    { id: 'r2', level: 'requirement', title: '已绑定', mp2: { kind: 'requirement', id: 2, code: 'REQ-0002' } },
    { id: 't1', level: 'todo', title: '回复客户' },
  ];
  const b = mp2RequirementDraft(work, 'r1', { taxonomy, sources: [{ sourceLabel: '飞书', title: '客户群反馈', at: '2026-11-20T08:00:00Z' }] });
  assert.deepEqual({ ...b, description: undefined }, { title: '寄送信息提示丢失', description: undefined, source: 'JM Desk', priority: 'P1', requirement_type: '问题修复',
    expected_date: '2026-12-01', business_project_id: 117 });
  for (const s of ['下单后看不到寄送信息', '所属项目：云帆出行（PRJ-0001）', '提出人：王五', '期望交付：2026-12-01（原话：12月初）', '飞书《客户群反馈》 2026-11-20']) assert.ok(b.description.includes(s), s);
  assert.throws(() => mp2RequirementDraft(work, 'r2', { taxonomy }), /已经绑定 REQ-0002/);
  assert.throws(() => mp2RequirementDraft(work, 't1', { taxonomy }), /只有「需求」可以上传/);
  const loose = mp2RequirementDraft([{ id: 'x', level: 'requirement', title: '没挂产品' }], 'x', { taxonomy });
  assert.equal(loose.business_project_id, undefined); assert.equal(loose.description.split('\n')[0], '没挂产品'); assert.equal(loose.priority, 'P2');
});

test('经 AI 通道新建原始需求；重名、无权限、超出负责范围给出可读原因', async () => {
  const OP = 'POST:/api/requirement';
  const mock = await startMock({ grants: [OP], requirements: [{ id: 2, requirement_code: 'REQ-0002', title: '已有的' }], scope: [117] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmd-up-'));
  const credentialFile = path.join(dir, 'cred.json'); fs.writeFileSync(credentialFile, JSON.stringify({ token: 'test-token' }));
  const cfg = { mp2: { baseUrl: mock.url, credentialFile } };
  try {
    const r = await mp2.createRequirement(cfg, { title: '新需求', description: 'd', source: 'JM Desk', priority: 'P2', business_project_id: 117 });
    assert.deepEqual({ id: r.id, code: r.code, title: r.title }, { id: 101, code: 'REQ-0101', title: '新需求' });
    assert.equal(mock.created.length, 1);
    await assert.rejects(mp2.createRequirement(cfg, { title: '已有的', description: 'd', source: 'JM Desk', priority: 'P2', business_project_id: 117 }), e => e.code === 'title_duplicated');
    await assert.rejects(mp2.createRequirement(cfg, { title: '别的产品', description: 'd', source: 'JM Desk', priority: 'P2', business_project_id: 5 }), /负责范围/);
    const ids = mock.calls.filter(c => c.operationId === OP).map(c => c.requestId);
    assert.equal(new Set(ids).size, ids.length, '每次写入的 requestId 都不同');
  } finally { mock.close(); }
  const denied = await startMock({ grants: [] });
  try { await assert.rejects(mp2.createRequirement({ mp2: { baseUrl: denied.url, credentialFile } }, { title: 'a', description: 'd', source: 'JM Desk', priority: 'P2' }), /新建权限/); }
  finally { denied.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('读关联的负责范围（经关联得到的 MCP 端点 mp2_context）', async () => {
  const mock = await startMock({ scope: [117, 5] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmd-scope-'));
  const credentialFile = path.join(dir, 'cred.json');
  try {
    fs.writeFileSync(credentialFile, JSON.stringify({ mcpServers: { mp2: { url: mock.url + '/api/ai-access/mcp', headers: { Authorization: 'Bearer test-token' } } } }));
    assert.deepEqual(await mp2.responsibility({ mp2: { baseUrl: mock.url, credentialFile } }), [{ id: 117, name: 'P117' }, { id: 5, name: 'P5' }]);
    fs.writeFileSync(credentialFile, JSON.stringify({ token: 'test-token' }));
    assert.equal(await mp2.responsibility({ mp2: { baseUrl: mock.url, credentialFile } }), null, '旧的手工令牌没有 MCP 地址：范围未知');
  } finally { mock.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
