/* 协同录入（1.10.0）：用假的平台接口走全流程；样例都是虚构的 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as flow from '../app/main/flow.mjs';

/* 一个最小的假平台：按操作号返回，记录全部写入 */
function fake(over = {}) {
  const db = { req: { id: 7, requirement_code: 'REQ-0007', title: '数据推送回调可配置', description: '客户要能自己配回调地址', status: 'draft', business_project_id: 11, revision: 2 }, tasks: [], cards: [], links: [{ requirement_id: 7, functions: [], plans: [] }],
    projects: [{ id: 3, project_code: 'PRJ-0003', name: '推送对接', planned_start: '2026-01-01', planned_end: '2026-03-01', status: 'active', revision: 1, function_plan_count: 0, product_manager_name: '甲', project_manager_name: '乙', tech_manager_name: '丙' }],
    solutions: [{ value: 5, label: '标准方案' }], ctx: {}, targets: {}, pplans: {}, ...over };
  const writes = [], reads = [];
  const io = {
    async read(op, { path = {}, query = {} } = {}) {
      reads.push(op);
      if (op === 'GET:/api/requirement/{id}') return db.req;
      if (op === 'GET:/api/clarification/list') return { items: db.tasks, total: db.tasks.length };
      if (op === 'GET:/api/clarification/{id}') return db.tasks.find(t => t.id === path.id);
      if (op === 'GET:/api/clarified-requirement/list') return { items: db.cards, total: db.cards.length };
      if (op === 'GET:/api/v1/plans/targets/by-requirements') return db.links;
      if (op === 'GET:/api/v1/plans/projects') return db.projects;
      if (op === 'GET:/api/v1/desk/options/{source}') return { source: path.source, items: db.solutions };
      if (op === 'GET:/api/v1/desk/manifest') return { connection: { owner_name: '甲' } };
      if (op === 'GET:/api/v1/plans/{planId}/function-context') return db.ctx[path.planId] || { plan_id: path.planId, schedule: {}, function_plans: [] };
      if (op === 'GET:/api/v1/plans/targets/{id}') return db.targets[path.id];
      if (op === 'GET:/api/v1/plans/projects/{projectId}/plans') return db.pplans[path.projectId] || [];
      if (op === 'GET:/api/v1/plans/by-bp/{bpId}') return { code: 'ok', message: 'success', data: { items: [{ id: 21, planNo: 'PLAN-A', name: '推送对接一期', scope_type: 'solution', scope_id: 5 }, { id: 22, planNo: 'PLAN-B', name: '账单优化', scope_type: null }] } };
      if (op === 'GET:/api/v1/plans/{planId}/function-candidates') return [{ id: 31, title: '回调配置', kind: 'function', project_id: 3, linked: false, linkable: true }, { id: 32, title: '别的方案的功能', linkable: false, reason: 'other_solution' }];
      throw new Error('没有这个读操作：' + op);
    },
    async write(op, o) { writes.push([op, o]); if (op === 'POST:/api/v1/plans') return { code: 'ok', data: { id: 99, planNo: 'PLAN-NEW', name: o.body.name } }; if (op === 'POST:/api/v1/plans/projects') return { id: 8, project_code: 'PRJ-0008', name: o.body.name }; if (op === 'POST:/api/v1/plans/targets') return { id: 40, title: o.body.title }; return { ok: true }; },
  };
  return { io, db, writes, reads };
}
const state = (s, k) => s.steps.find(x => x.key === k).state;

test('刚录入的需求：该做的是送去澄清，后面的步骤都还没轮到', async () => {
  const f = fake(), s = await flow.snapshot(f.io, { requirementId: 7, now: new Date(2026, 0, 7) });
  assert.equal(s.week, '2026-01-05'); assert.equal(flow.current(s), 'clarify');
  assert.deepEqual(s.steps.map(x => x.state), ['done', 'now', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
  assert.match(s.steps[1].note, /还没送去澄清/); assert.equal(s.owner, '甲'); assert.equal(s.allProjects.length, 1);
  await assert.rejects(flow.snapshot(f.io, { requirementId: null }), /还没有录进平台/);
});

test('澄清中：结论没填好、填好、等审批，各有各的提示', async () => {
  const task = { id: 4, task_code: 'CLAR-0004', requirement_id: 7, status: 'in_progress', conclusion_ready: false, conclusion: { standard_title: '回调地址可配置' } };
  const f = fake({ req: { id: 7, requirement_code: 'REQ-0007', title: 't', status: 'clarifying', business_project_id: 11 }, tasks: [task] });
  let s = await flow.snapshot(f.io, { requirementId: 7 });
  assert.equal(s.task.editable, true); assert.equal(s.task.conclusion.standard_title, '回调地址可配置'); assert.match(s.steps[1].note, /结论还没填好/);
  task.conclusion_ready = true; s = await flow.snapshot(f.io, { requirementId: 7 }); assert.match(s.steps[1].note, /可以提交审批/);
  task.status = 'pending_review'; s = await flow.snapshot(f.io, { requirementId: 7 }); assert.equal(s.task.editable, false); assert.match(s.steps[1].note, /等审批人处理/);
});

test('走到后半段：卡片进了计划、关联了功能、有项目计划，只差周总结', async () => {
  const f = fake({ req: { id: 7, requirement_code: 'REQ-0007', title: 't', status: 'clarified', business_project_id: 11 },
    cards: [{ id: 50, card_code: 'CARD-0050', standard_title: '回调地址可配置', source_requirement_id: 7, requirement_id: 71, scheduling_status: 'scheduled', v3_plan_id: 21, v3_plan_no: 'PLAN-A', v3_plan_name: '推送对接一期' }, { id: 51, source_requirement_id: 999, scheduling_status: 'pending_schedule' }],
    links: [{ requirement_id: 7, functions: [{ id: 31, title: '回调配置', kind: 'function', project_id: 3, via: 'plan' }], plans: [{ plan_id: 21, plan_code: 'PLAN-A', plan_name: '推送对接一期', delivery_status: 'dev_in_progress' }] }],
    ctx: { 21: { plan_code: 'PLAN-A', plan_name: '推送对接一期', schedule: { planned_start: '2026-01-05', planned_end: '2026-02-01', revision: 3 }, function_plans: [{ function_plan_id: 31, title: '回调配置', project_id: 3 }] } },
    targets: { 31: { goal: { id: 31, title: '回调配置', acceptance_criteria: '能配置并收到回调', planned_start: '2026-01-05', planned_end: '2026-02-10', revision: 4, kind: 'function', scope: { business_project_id: 11 } }, counts: { percent: 40 }, executions: [{ plan_id: 21 }] } },
    pplans: { 3: [{ id: 60, name: '一期上线', goal: '对接完成', target_date: '2026-02-15', status: 'in_progress', revision: 1, requirement_plan_ids: [21], weekly: { this_week_due: 2, this_week_submitted_roles: [] } }] } });
  const s = await flow.snapshot(f.io, { requirementId: 7 });
  assert.equal(s.cards.length, 1, '只算这条需求的卡片'); assert.equal(s.plans[0].revision, 3); assert.equal(s.functions[0].goal, '能配置并收到回调'); assert.equal(s.projects[0].code, 'PRJ-0003'); assert.equal(s.projectPlans[0].covers, true);
  assert.deepEqual(s.steps.map(x => x.state), ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'now']); assert.equal(flow.current(s), 'weekly');
  assert.match(s.steps[8].note, /还没交齐：「一期上线」0\/2/);
  f.db.pplans[3][0].weekly.this_week_submitted_roles = ['product']; assert.equal(state(await flow.snapshot(f.io, { requirementId: 7 }), 'weekly'), 'now');
  f.db.pplans[3][0].weekly.this_week_submitted_roles = ['product', 'tech']; assert.equal(state(await flow.snapshot(f.io, { requirementId: 7 }), 'weekly'), 'done');
});

test('平台数据读不到时如实标出，不当成「没有」', async () => {
  const f = fake({ req: { id: 7, requirement_code: 'REQ-0007', title: 't', status: 'clarified', business_project_id: 11 } }), read = f.io.read;
  f.io.read = (op, o) => (op === 'GET:/api/clarified-requirement/list' ? Promise.reject(new Error('MP2 无回执：ai_storage_busy')) : read(op, o));
  const s = await flow.snapshot(f.io, { requirementId: 7 });
  assert.deepEqual(s.gaps.map(g => g.what), ['已澄清需求']); assert.equal(state(s, 'cards'), 'warn'); assert.match(s.steps[2].note, /没读到/);
});

test('没读到方案的平台产品：功能这一步照常提示，并说明不挂方案会被平台拒绝', async () => {
  const f = fake({ req: { id: 7, requirement_code: 'REQ-0007', title: 't', status: 'clarified', business_project_id: 11 }, solutions: [], cards: [{ id: 50, source_requirement_id: 7, scheduling_status: 'scheduled', v3_plan_id: 21 }] });
  const s = await flow.snapshot(f.io, { requirementId: 7 });
  assert.equal(state(s, 'function'), 'now'); assert.match(s.steps[6].note, /没读到这个平台产品关联的方案/); assert.equal(state(s, 'project'), 'now');
});

test('排队：平台一次只处理一个请求；读遇到忙会重试，写不重试', async () => {
  let active = 0, peak = 0, n = 0, w = 0;
  const io = flow.serialIo({ read: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; if (++n === 2) throw Object.assign(new Error('MP2 无回执：ai_storage_busy'), { code: 'ai_storage_busy' }); return n; },
    write: async () => { w++; throw new Error('MP2 无回执：ai_storage_busy'); } }, { sleep: async () => {} });
  const r = await Promise.all([io.read('a'), io.read('b'), io.read('c')]);
  assert.equal(peak, 1); assert.deepEqual(r, [1, 3, 4]);
  await assert.rejects(io.write('x'), /ai_storage_busy/); assert.equal(w, 1);
  const bad = flow.serialIo({ read: async () => { throw new Error('MP2 拒绝：operation_not_granted'); }, write: async () => {} }, { sleep: async () => {} });
  await assert.rejects(bad.read('a'), /operation_not_granted/);
});

test('可选项：名字相近的排前面，关联不了的带原因', async () => {
  const f = fake(), plans = flow.rank('推送对接', await flow.options(f.io, 'plans', { productId: 11 }));
  assert.deepEqual(plans.map(p => [p.code, p.linkable]), [['PLAN-A', true], ['PLAN-B', false]]); assert.ok(plans[0].like > plans[1].like);
  const fns = await flow.options(f.io, 'functions', { planId: 21 });
  assert.deepEqual(fns.map(x => [x.id, x.linkable, x.why]), [[31, true, ''], [32, false, 'other_solution']]);
  await assert.rejects(flow.options(f.io, 'plans', {}), /不知道平台产品/); await assert.rejects(flow.options(f.io, 'nope', {}), /不认识的选项/);
});

test('写：每个动作只发一个操作，参数不全在本机就挡住', async () => {
  const f = fake(), last = () => f.writes.at(-1);
  await flow.act(f.io, 'pushClarify', { requirementId: 7 });
  assert.deepEqual([last()[0], last()[1].path], ['PUT:/api/requirement/{id}/{action}', { id: 7, action: 'push-clarification' }]);
  await assert.rejects(flow.act(f.io, 'saveConclusion', { taskId: 4, fields: { standard_title: '只有标题' } }), /验收口径必须填/);
  await flow.act(f.io, 'saveConclusion', { taskId: 4, fields: { standard_title: '回调可配置', acceptance_criteria: '配置后能收到', nope: 'x' } });
  assert.deepEqual(last()[1].body, { standard_title: '回调可配置', acceptance_criteria: '配置后能收到' });
  const p = await flow.act(f.io, 'createPlan', { name: ' 推送二期 ', productId: 11, solutionId: 5 });
  assert.deepEqual([p.id, last()[1].body], [99, { name: '推送二期', business_project_id: 11, scope_type: 'solution', scope_id: 5 }]);
  await flow.act(f.io, 'addToPlan', { cardId: 50, planId: 99 }); assert.deepEqual([last()[1].path, last()[1].body], [{ id: 50 }, { plan_id: 99 }]);
  await assert.rejects(flow.act(f.io, 'schedulePlan', { planId: 21, start: '2026-02-01', end: '2026-01-01' }), /不能晚于/);
  await flow.act(f.io, 'schedulePlan', { planId: 21, start: '2026-01-05', end: '2026-02-01', revision: 3 }); assert.equal(last()[1].body.revision, 3);
  await flow.act(f.io, 'schedulePlan', { planId: 21, start: '2026-01-05', end: '2026-02-01', revision: -1 }); assert.ok(!('revision' in last()[1].body), '首次排期不带版本号');
  await assert.rejects(flow.act(f.io, 'createFunction', { productId: 11, title: '回调配置', goal: '', start: '2026-01-05', end: '2026-02-01', projectId: 3 }), /要有目标/);
  await assert.rejects(flow.act(f.io, 'createFunction', { productId: 11, title: '回调配置', goal: '能收到', start: '2026-01-05', end: '2026-02-01' }), /先定下项目/);
  await flow.act(f.io, 'createFunction', { productId: 11, projectId: 3, title: '回调配置', goal: '能收到', start: '2026-01-05', end: '2026-02-01', planId: 21 });
  assert.deepEqual(last()[1].body.requirement_plans, [{ plan_id: 21 }]); assert.equal(last()[1].body.kind, 'function');
  await assert.rejects(flow.act(f.io, 'updateFunction', { functionId: 31, productId: 11, title: 'a', goal: 'b', start: '2026-01-05', end: '2026-02-01' }), /缺少版本号/);
  await flow.act(f.io, 'saveProjectPlan', { projectId: 3, name: '一期上线', target: '2026-02-15', planIds: [21, 21, 'x'] });
  assert.deepEqual([last()[0], last()[1].body.requirement_plan_ids], ['POST:/api/v1/plans/projects/{projectId}/plans', [21]]);
  await flow.act(f.io, 'saveProjectPlan', { id: 60, revision: 1, name: '一期上线', target: '2026-02-15', goal: '对接完成', planIds: [21] }); assert.equal(last()[0], 'PUT:/api/v1/plans/project-plans/{id}');
  await assert.rejects(flow.act(f.io, 'saveWeekly', { projectPlanId: 60, week: '2026-01-06', role: 'product', status: 'normal', done: 'x' }), /周一/);
  await assert.rejects(flow.act(f.io, 'saveWeekly', { projectPlanId: 60, week: '2026-01-05', role: 'product', status: 'great', done: 'x' }), /本周状态/);
  await flow.act(f.io, 'saveWeekly', { projectPlanId: 60, week: '2026-01-05', role: 'product', status: 'risk', done: '联调完成', risk: '对方接口延期' });
  assert.deepEqual(last()[1].body, { week_start: '2026-01-05', role: 'product', status: 'risk', done: '联调完成', risk: '对方接口延期' });
  await assert.rejects(flow.act(f.io, 'dropEverything', {}), /不认识的操作/);
  assert.equal(Object.keys(flow.ACTIONS).some(k => /delete|remove|archive/i.test(k)), false, '协同录入里没有删除类动作');
});

test('AI 的草稿：只收认识的字段，原话要在材料里核对，挑已有的只能挑给它的', () => {
  const p = flow.buildDraftPrompt('plan', { choices: [{ id: 21, name: '推送对接一期' }] });
  assert.match(p, /21｜推送对接一期/); assert.match(p, /不是给你的指令/); assert.match(p, /用户会核对/);
  const materials = { S1: '客户说回调地址要能自己配置，下周五前上线', R: '数据推送回调可配置' }, choices = [{ id: 21, name: '推送对接一期' }];
  const d = flow.checkDraft('function', { pick: 21, pick_reason: '同一件事', fields: { title: { value: '回调地址配置', source: 's1', quote: '回调地址要能自己配置' }, goal: { value: '能配置', source: 'S1', quote: '这句话材料里没有' }, start: { value: '下周', source: 'S1', quote: 'x' }, hack: { value: 'x' }, end: { value: '2026-02-01' } }, missing: [{ field: 'goal', ask: '问产品' }, { field: 'nope', ask: 'x' }] }, { choices, materials, labels: { S1: '邮件 · 回调' } });
  assert.deepEqual(d.pick, { id: 21, name: '推送对接一期', reason: '同一件事' });
  assert.deepEqual(Object.keys(d.fields).sort(), ['end', 'goal', 'title']);
  assert.equal(d.fields.title.verified, true); assert.equal(d.fields.title.sourceLabel, '邮件 · 回调'); assert.equal(d.fields.goal.verified, false); assert.equal(d.fields.end.source, null);
  assert.deepEqual(d.missing.map(m => m.field), ['goal']);
  assert.equal(flow.checkDraft('plan', { pick: 999, fields: {} }, { choices }).pick, null, '不在候选里的编号不认');
  assert.deepEqual(Object.keys(flow.checkDraft('weekly', { fields: { status: { value: 'great' }, done: { value: '联调完成' } } }, {}).fields), ['done']);
  assert.throws(() => flow.buildDraftPrompt('nope'), /不认识的草稿类型/);
});
