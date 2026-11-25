/* 对话工作台的会话：每个会话一个文件，放在 <数据目录>/threads/<id>.json。
 *   { id, title, createdAt, updatedAt, target: { kind: 'assistant' } | { kind: 'project', id }, session, scope: { integrations: null | [接入 id] }, turns: [{ id, at, q, a, steps, used, error, incomplete, stopped, provider, ms }] }
 * target 是这个会话在和谁说话：JM Desk 自己的助手，或某个执行项目（本机 Codex / DSH，见 executors.mjs）；建好后不变。session 是执行者那边的会话号（Codex 用来接着上一次）。
 * scope.integrations 为 null 表示可以用全部已启用的接入；数组表示只用其中这些（只对助手有意义）。
 * 工具返回值可能含业务数据：只保存截断后的片段，文件权限 0600，和工作区其他数据一样只留在本机。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID = /^t[a-z0-9]{8,24}$/;
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const newId = p => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
export const titleOf = q => clip(String(q || '').replace(/\s+/g, ' ').trim(), 24) || '新对话';
const cleanScope = s => ({ integrations: Array.isArray(s?.integrations) ? [...new Set(s.integrations.map(String).filter(x => /^[a-z0-9][a-z0-9-]{0,30}$/.test(x)))] : null });
const cleanTarget = t => t?.kind === 'project' && /^p[a-z0-9]{6,24}$/.test(String(t.id)) ? { kind: 'project', id: String(t.id) } : { kind: 'assistant' };
const keepArgs = a => { const j = JSON.stringify(a ?? {}); return j.length > 4000 ? { '…': '参数太长，未保存' } : JSON.parse(j); };
const cleanStep = s => ({ kind: String(s.kind || ''), tool: clip(s.tool, 160), ...(s.integration ? { integration: clip(s.integration, 60) } : {}), ...(s.args !== undefined ? { args: keepArgs(s.args) } : {}),
  ...(s.why ? { why: clip(s.why, 120) } : {}), ...(s.text ? { text: clip(s.text, 4000) } : {}), ...(s.reasoning ? { reasoning: clip(s.reasoning, 8000) } : {}), ...(s.final ? { final: true } : {}), ...(s.ok !== undefined ? { ok: !!s.ok } : {}), ...(s.result ? { result: clip(s.result, 2000) } : {}), ...(s.error ? { error: clip(s.error, 300) } : {}), ...(s.ms ? { ms: Number(s.ms) || 0 } : {}) });

export function createThreads(dir, { max = 300 } = {}) {
  const file = id => { if (!ID.test(String(id))) throw new Error('没有这个对话'); return path.join(dir, id + '.json'); };
  const read = id => { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch (e) { if (e.message === '没有这个对话') throw e; return null; } };
  function write(t) {
    fs.mkdirSync(dir, { recursive: true });
    const f = file(t.id), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(t, null, 1), { mode: 0o600 }); fs.renameSync(tmp, f);
    return t;
  }
  const summary = t => ({ id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, scope: t.scope, target: t.target || { kind: 'assistant' }, turns: t.turns.length, last: clip(t.turns.at(-1)?.a || t.turns.at(-1)?.error || '', 60) });
  function list() {
    let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json') && ID.test(n.slice(0, -5))); } catch {}
    return names.map(n => read(n.slice(0, -5))).filter(t => t && Array.isArray(t.turns)).map(summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  function get(id) { const t = read(id); if (!t) throw new Error('没有这个对话'); return t; }
  function create({ title = '', scope, target } = {}) {
    const now = new Date().toISOString();
    const t = write({ id: newId('t'), title: clip(title, 40) || '新对话', createdAt: now, updatedAt: now, target: cleanTarget(target), session: null, scope: cleanScope(scope), turns: [] });
    for (const old of list().slice(max)) remove(old.id); // 只留最近的 max 个
    return t;
  }
  function appendTurn(id, turn) {
    const t = get(id);
    const rec = { id: newId('r'), at: new Date().toISOString(), q: clip(turn.q, 8000), ...(turn.a ? { a: clip(turn.a, 12000) } : {}), steps: (turn.steps || []).slice(0, 80).map(cleanStep), used: (turn.used || []).slice(0, 20).map(String),
      ...(turn.error ? { error: clip(turn.error, 500) } : {}), ...(turn.incomplete ? { incomplete: true } : {}), ...(turn.stopped ? { stopped: true } : {}), ...(turn.provider ? { provider: String(turn.provider) } : {}), ...(turn.ms ? { ms: Number(turn.ms) || 0 } : {}) };
    if (!t.turns.length && (!t.title || t.title === '新对话')) t.title = titleOf(turn.q);
    t.turns.push(rec); t.updatedAt = rec.at;
    write(t);
    return { thread: summary(t), turn: rec };
  }
  function rename(id, title) { const t = get(id); t.title = clip(String(title || '').trim(), 40) || t.title; write(t); return summary(t); }
  function setSession(id, session) { const t = get(id); t.session = session ? clip(session, 80) : null; write(t); return true; }
  function setScope(id, scope) { const t = get(id); t.scope = cleanScope(scope); write(t); return summary(t); }
  function remove(id) { try { fs.rmSync(file(id), { force: true }); } catch (e) { if (e.message === '没有这个对话') throw e; } return true; }
  return { list, get, create, appendTurn, rename, setScope, setSession, remove };
}
