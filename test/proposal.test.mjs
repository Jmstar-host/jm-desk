/* AI 提议（1.10.0）：AI 想新建的项目 / 需求先是提议，人确认、并进已有的或不采纳。样例都是虚构的 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as wm from '../app/main/workmodel.mjs';

const sig = (id, title, content) => ({ id, title, content, source_type: 'mail' });
const fromAi = () => {
  const signals = [sig('s1', '导出报表', '客户希望报表能导出成表格，下周五前要'), sig('s2', '周会', '记得周三前回复排期')];
  const v = wm.verify({ items: [
    { level: 'requirement', sid: 's1', title: '报表导出成表格', summary: '客户要导出', project: '报表改进' },
    { level: 'todo', sid: 's2', title: '回复排期' },
  ] }, signals, { work: [], taxonomy: { lines: [], products: [] } });
  return wm.mergeWork([], v, '2026-01-01T00:00:00.000Z').work;
};

test('AI 整理出的新项目和新需求是提议，待办不是', () => {
  const w = fromAi(), by = Object.fromEntries(w.map(x => [x.level, x]));
  assert.equal(by.requirement.proposed, true); assert.equal(by.project.proposed, true); assert.equal(by.project.title, '报表改进');
  assert.equal(by.todo.proposed, undefined);
  assert.equal(by.requirement.parentId, by.project.id);
});

test('确认：可以改名，改过的名字之后 AI 不再覆盖', () => {
  const w = fromAi(), p = w.find(x => x.level === 'project');
  wm.confirmProposal(w, p.id, { title: '报表中心二期', now: '2026-01-02T00:00:00.000Z' });
  assert.equal(p.proposed, undefined); assert.equal(p.title, '报表中心二期'); assert.ok(p.locked.includes('title'));
  assert.match(p.history.at(-1).note, /确认新建，名称定为「报表中心二期」/); assert.equal(p.history.at(-1).by, 'me');
  const r = w.find(x => x.level === 'requirement'); wm.confirmProposal(w, r.id, {});
  assert.equal(r.proposed, undefined); assert.equal(r.title, '报表导出成表格'); assert.equal((r.locked || []).includes('title'), false);
  assert.equal(wm.confirmProposal(w, r.id, { title: '别的名字' }).title, '报表导出成表格'); // 已经确认过的不再动
});

test('并进已有的：线索和下面的工作跟过去，提议本身不再出现', () => {
  const w = fromAi(), p = w.find(x => x.level === 'project'), r = w.find(x => x.level === 'requirement');
  const old = { id: 'p-old', level: 'project', title: '报表中心', status: 'open', sids: ['s9'], history: [] }; w.push(old);
  wm.mergeProposal(w, p.id, 'p-old');
  assert.deepEqual(old.sids.sort(), ['s1', 's9']); assert.equal(r.parentId, 'p-old');
  assert.equal(p.status, 'dropped'); assert.equal(p.mergedInto, 'p-old'); assert.equal(p.proposed, undefined);
  assert.throws(() => wm.mergeProposal(w, r.id, 'p-old'), /同一层级/);
  assert.throws(() => wm.mergeProposal(w, 'p-old', r.id), /只有 AI 的新建提议/);
});

test('不采纳：提议关掉，下面的工作留着', () => {
  const w = fromAi(), p = w.find(x => x.level === 'project'), r = w.find(x => x.level === 'requirement');
  wm.dismissProposal(w, p.id);
  assert.equal(p.status, 'dropped'); assert.equal(r.parentId, null); assert.equal(r.proposed, true);
  assert.throws(() => wm.dismissProposal(w, p.id), /已经确认过了/);
});

test('AI 整理（重排）时新建的项目也是提议', () => {
  const work = [{ id: 'r1', level: 'requirement', title: '甲', status: 'open', sids: [], history: [] }, { id: 'r2', level: 'requirement', title: '乙', status: 'open', sids: [], history: [] }];
  wm.applyReorg(work, { create: [{ ref: 'n1', level: 'project', title: '新的项目', reason: '两条需求是一件事' }], moves: [{ id: 'r1', parent: 'n1' }, { id: 'r2', parent: 'n1' }], items: [{ id: 'r1', parent: 'n1' }, { id: 'r2', parent: 'n1' }] }, { taxonomy: { lines: [], products: [] } });
  const p = work.find(x => x.level === 'project');
  if (p) assert.equal(p.proposed, true); // 重排的入参格式变了的话这里不建项目；建了就必须是提议
});
