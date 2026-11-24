/* 工作模型：分层、挂靠、合并、人工锁定、AI 整理、产品树。样例内容为虚构。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wm from '../app/main/workmodel.mjs';

const sigs = [
  { id: 's1', source_type: 'mail', title: '邮件 · 接口需求', content: '客户要求增加批量开卡接口，请在 12 月 5 日前给出排期。' },
  { id: 's2', source_type: 'feishu_im', title: '飞书单聊 · 小明', content: '[2026-11-18 10:00] 小明：短信网关告警了，帮忙看下' },
];
const tax = wm.flattenTree({ lines: [{ nodeKind: 'LINE', id: 1, name: 'eSIM 与终端', children: [{ nodeKind: 'CATEGORY', id: 2, name: '消费级', children: [{ nodeKind: 'PRODUCT', id: 9, name: 'eSIM 管理平台', productLineId: 1 }] }] }], unclassified: [{ nodeKind: 'PRODUCT', id: 10, name: '短信网关' }] });

test('产品树拍平：产品线 / 类目多级、未分产品线的产品', () => {
  assert.deepEqual(tax.lines.map(l => l.path), ['eSIM 与终端', 'eSIM 与终端 › 消费级']);
  assert.deepEqual(tax.products.map(p => [p.name, p.path]), [['eSIM 管理平台', 'eSIM 与终端 › 消费级'], ['短信网关', '未分产品线']]);
});

test('一条线索同时产生需求和待办；待办挂到需求下；归属匹配产品树；交期按原文核对', () => {
  const v = wm.verify({ items: [
    { ref: 'n1', level: 'requirement', type: 'feature', title: '支持批量开卡接口', sids: ['s1'], product: 'eSIM管理平台', deadline: '2026-12-05', deadline_quote: '12 月 5 日前给出排期' },
    { ref: 'n2', level: 'todo', title: '回复客户排期', sids: ['s1'], parent: 'n1' },
    { ref: 'n3', level: 'requirement', type: 'bug', title: '排查短信网关告警', sids: ['s2'], product: '短信网关' },
    { ref: 'x', level: 'epic', title: '不存在的层级', sids: ['s1'] },
    { ref: 'y', level: 'todo', title: '编造的线索', sids: ['nope'] },
  ] }, sigs, { work: [], taxonomy: tax });
  assert.equal(v.items.length, 3);
  const [req, todo, bug] = v.items;
  assert.equal(req.productId, 'mp2:p:9'); assert.equal(req.line, 'eSIM 与终端 › 消费级'); assert.equal(req.deadline_verified, true);
  assert.equal(todo.parentId, req.id); assert.equal(todo.owner, 'me');
  assert.equal(bug.type, 'bug'); assert.equal(bug.line, null); assert.equal(bug.product, '短信网关');
});

test('上级只能是更高层级：待办不能当需求的上级；同层不能互挂', () => {
  const v = wm.verify({ items: [{ ref: 'a', level: 'todo', title: '回复', sids: ['s1'] }, { ref: 'b', level: 'requirement', title: '做接口', sids: ['s1'], parent: 'a' }] }, sigs, { taxonomy: tax });
  assert.equal(v.items[1].parentId, null);
});

test('同一件事合并到已有工作：补线索、不改名不改层级；认不出的平台产品不写，只留线索给「待归入」', () => {
  const work = [];
  wm.mergeWork(work, wm.verify({ items: [{ ref: 'n1', level: 'requirement', title: '支持批量开卡接口', sids: ['s1'], product: '某平台' }] }, sigs, { work, taxonomy: null }));
  assert.equal(work[0].product, null); assert.equal(work[0].anchorHint, '某平台');
  const v2 = wm.verify({ items: [{ level: 'requirement', title: '批量开卡 API', sids: ['s2'], same_as: work[0].id }] }, sigs, { work });
  const r = wm.mergeWork(work, v2);
  assert.equal(work.length, 1); assert.deepEqual(work[0].sids, ['s1', 's2']); assert.equal(work[0].title, '支持批量开卡接口'); assert.equal(r.added, 0);
});

test('人改过的字段锁定，AI 整理不再覆盖；改成完成会记完成时间', () => {
  const work = wm.migrateTasks([{ id: 't1', sid: 's1', title: '确认接口方案', status: 'open' }]);
  assert.equal(work[0].level, 'todo'); assert.equal(work[0].needsReview, true);
  wm.editItem(work, work[0].id, { level: 'requirement', type: 'change' });
  assert.deepEqual(work[0].locked.sort(), ['level', 'type']); assert.equal(work[0].needsReview, false);
  wm.applyReorg(work, { changes: [{ id: work[0].id, level: 'todo', reason: '应为待办' }] }, {});
  assert.equal(work[0].level, 'requirement', 'AI 不能改人确认过的层级');
  wm.editItem(work, work[0].id, { status: 'done' }); assert.ok(work[0].doneAt); assert.ok(!work[0].locked.includes('status'));
  assert.throws(() => wm.editItem(work, work[0].id, { level: 'epic' }), /层级/);
});

test('AI 整理：新建项目要有至少两条挂上去；合并重复会把下级转过去', () => {
  const work = [
    { id: 'r1', level: 'requirement', title: '充值页适配', status: 'open', sids: ['s1'] },
    { id: 'r2', level: 'requirement', title: '支付回调', status: 'open', sids: ['s2'] },
    { id: 'r3', level: 'requirement', title: '支付回调处理', status: 'open', sids: ['s2'] },
    { id: 't1', level: 'todo', title: '跟进回调', status: 'open', parentId: 'r3' },
  ];
  const r = wm.applyReorg(work, {
    create: [{ ref: 'c1', level: 'project', title: '钱包 H5 对接' }, { ref: 'c2', level: 'project', title: '只挂一条的项目' }],
    changes: [{ id: 'r1', parent: 'c1' }, { id: 'r2', parent: 'c1' }, { id: 'r3', same_as: 'r2' }, { id: 't1', parent: 'c2' }],
  }, {});
  const proj = work.find(w => w.level === 'project');
  assert.equal(work.filter(w => w.level === 'project').length, 1); assert.equal(proj.title, '钱包 H5 对接');
  assert.equal(work.find(w => w.id === 'r1').parentId, proj.id);
  assert.equal(work.find(w => w.id === 'r3').status, 'dropped'); assert.equal(work.find(w => w.id === 't1').parentId, 'r2');
  assert.ok(r.log.length >= 3);
});

test('树：按 产品线 › 平台产品 分组，组内按上下级展开', () => {
  const work = [
    { id: 'p', level: 'project', title: 'P', status: 'open', line: 'L', product: 'X' },
    { id: 'r', level: 'requirement', title: 'R', status: 'open', parentId: 'p' },
    { id: 't', level: 'todo', title: 'T', status: 'open', parentId: 'r' },
    { id: 'u', level: 'todo', title: 'U', status: 'open' },
  ];
  const t = wm.tree(work);
  assert.deepEqual(t.groups.map(g => g.label), ['L › X', '未归属产品线']);
  assert.equal(t.groups[0].items[0].children[0].children[0].id, 't');
  assert.deepEqual(t.counts, { program: 0, project: 1, requirement: 1, todo: 2 });
  assert.deepEqual(wm.breadcrumb(work, work[2]).map(c => c.id), ['p', 'r']);
});

test('需求必须归入项目：按名字找已有项目，找不到自动建一个（标为待确认）；日常待办不挂上级', () => {
  const work = [{ id: 'P1', level: 'project', title: '钱包 H5 对接', status: 'open' }];
  const v = wm.verify({ items: [
    { ref: 'a', level: 'requirement', type: 'feature', title: '充值页适配', sids: ['s1'], project: '钱包H5对接' },
    { ref: 'b', level: 'requirement', type: 'bug', title: '网关告警修复', sids: ['s2'], project: '短信网关稳定性' },
    { ref: 'c', level: 'requirement', type: 'change', title: '同项目第二条', sids: ['s2'], project: '短信网关稳定性' },
    { ref: 'd', level: 'todo', title: '回复同事配置位置', sids: ['s2'] },
  ] }, sigs, { work, taxonomy: tax });
  const [a, b, c, d] = v.items.filter(x => x.level !== 'project'), auto = v.items.filter(x => x.level === 'project');
  assert.equal(a.parentId, 'P1');
  assert.equal(auto.length, 1); assert.equal(auto[0].title, '短信网关稳定性'); assert.equal(auto[0].autoCreated, true);
  assert.equal(b.parentId, auto[0].id); assert.equal(c.parentId, auto[0].id);
  assert.equal(d.parentId, null); assert.equal('projectName' in a, false);
});

test('AI 整理新建项目时用 children 直接挂需求；人锁定过上级的不动', () => {
  const work = [{ id: 'r1', level: 'requirement', title: 'A', status: 'open' }, { id: 'r2', level: 'requirement', title: 'B', status: 'open', locked: ['parentId'] }, { id: 't1', level: 'todo', title: 'T', status: 'open' }];
  wm.applyReorg(work, { create: [{ ref: 'c1', level: 'project', title: 'P', children: ['r1', 'r2', 't1', 'nope'] }, { ref: 'c2', level: 'project', title: 'Empty', children: ['t1'] }] }, {});
  const p = work.filter(w => w.level === 'project');
  assert.deepEqual(p.map(x => x.title), ['P']); assert.equal(work[0].parentId, p[0].id); assert.equal(work[1].parentId, undefined); assert.equal(work[2].parentId, undefined);
});
