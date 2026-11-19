import path from 'node:path';
import fs from 'node:fs';
/* 面板应用背后的服务：搬运、综合汇总、待办、邮箱统计、需求池。收集与平台调用复用 ../../src；邮件用 node:sqlite。 */
import * as pipeline from '../core/pipeline.mjs';
import * as mp2 from '../core/mp2.mjs';
import * as mail from './mail.mjs';
import { packSignals } from './summary.mjs';
import * as wm from './workmodel.mjs';
import * as digest from './digest.mjs';
const { store: desk } = pipeline;

/* 读 Mailspring 库（node:sqlite 是同步的）放到工作线程里，不卡住主进程和精灵动画；工作线程起不来时退回直接调用 */
import { Worker } from 'node:worker_threads';
let mw = null, mwSeq = 0; const mwWait = new Map();
function mailCall(fn, ...args) {
  if (mw === false) return mail[fn](...args);
  try {
    if (!mw) {
      mw = new Worker(new URL('./mail-worker.mjs', import.meta.url));
      mw.on('message', m => { const p = mwWait.get(m.id); if (p) { mwWait.delete(m.id); m.ok ? p.res(m.data) : p.rej(new Error(m.error)); } });
      mw.on('error', e => { console.warn('mail worker 出错，改为直接读取：', e.message); for (const p of mwWait.values()) p.rej(e); mwWait.clear(); mw = false; });
      mw.unref();
    }
    const id = ++mwSeq;
    return new Promise((res, rej) => { mwWait.set(id, { res, rej }); mw.postMessage({ id, fn, args }); }).catch(e => (mw === false ? mail[fn](...args) : Promise.reject(e)));
  } catch (e) { mw = false; return mail[fn](...args); }
}
let statsCache = null;
function cachedStats(dbFile) {
  if (statsCache && Date.now() - statsCache.at < 20000) return statsCache.p;
  const p = mailCall('stats', dbFile); statsCache = { at: Date.now(), p }; p.catch(() => { statsCache = null; }); return p;
}

export function createServices({ dataStore, chatJSON, getSettings }) {
  const collectors = () => ({ ...pipeline.COLLECTORS, mail: w => mailCall('collect', { since: w.since.getTime(), until: w.until.getTime(), dbFile: getSettings().mailDb }) });
  async function collect() { const c = await pipeline.collect(collectors()); const s = await pipeline.submit(); return { collect: c, submit: s, status: pipeline.status() }; }
  function recentSignals(hours, sources) {
    const since = Date.now() - hours * 3600e3;
    return desk.listSignals().filter(s => s.status !== 'split' && (!sources || sources.includes(s.source_type)))
      .filter(s => Date.parse(s.occurred_at || s.collectedAt || 0) >= since)
      .sort((a, b) => Date.parse(b.occurred_at || 0) - Date.parse(a.occurred_at || 0));
  }
  async function summarize({ sources = null, hours = 48, refresh = true } = {}) {
    const ran = refresh ? await pipeline.collect(collectors()).catch(e => ({ error: e.message })) : null;
    const signals = recentSignals(hours, sources).slice(0, 40), at = new Date(), file = sources ? 'summary-mail.json' : 'summary.json';
    if (!signals.length) { const r = { at: at.toISOString(), sources, overview: `最近 ${hours} 小时没有需要整理的新线索。`, items: [], fyi: [], counts: {}, collect: ran }; dataStore.write(file, r); return r; }
    const work = loadWork(), taxonomy = dataStore.read('taxonomy.json', { lines: [], products: [] });
    const v = wm.verify(await chatJSON(wm.buildPrompt(at, { taxonomy, work }), packSignals(signals)), signals, { work, taxonomy });
    const counts = signals.reduce((m, s) => ((m[s.source_type] = (m[s.source_type] || 0) + 1), m), {});
    const t = wm.mergeWork(work, v); dataStore.write('work.json', t.work);
    const byLevel = Object.fromEntries(Object.keys(wm.LEVELS).map(l => [l, v.items.filter(i => i.level === l).length + v.merges.filter(m => (t.work.find(w => w.id === m.id) || {}).level === l).length]));
    // 本次涉及的工作：新建的 + 合并进已有工作的（显示合并后的样子），按 id 去重
    const touched = [...new Map([...v.items.map(i => t.work.find(w => w.id === i.id) || i), ...v.merges.map(m => t.work.find(w => w.id === m.id)).filter(Boolean)].map(w => [w.id, w])).values()];
    const r = { at: at.toISOString(), sources, overview: v.overview, items: touched.map(i => ({ ...i, crumbs: wm.breadcrumb(t.work, i) })), merged: v.merges.length, fyi: v.fyi, counts, byLevel, collect: ran };
    dataStore.write(file, r);
    desk.log('summary', `汇总 · ${signals.length} 条线索 → ${Object.entries(byLevel).filter(([, n]) => n).map(([l, n]) => wm.LEVELS[l].label + ' ' + n).join('、') || '没有新工作'}`, {});
    return { ...r, added: t.added, updated: t.updated };
  }
  /* 工作列表：work.json；第一次读时把旧版 tasks.json（全部当待办）迁移过来 */
  function loadWork() {
    let w = dataStore.read('work.json', null);
    if (!w) { w = wm.migrateTasks(dataStore.read('tasks.json', [])); dataStore.write('work.json', w); }
    return w;
  }
  const saveWork = w => dataStore.write('work.json', w);
  /* 待办：从线索整理出的跟进动作。挂在某条需求下的是「需求跟进」，其余是「日常」 */
  const ancestor = (w, list, level) => { let p = w, g = 0; while (p && g++ < 6) { p = list.find(x => x.id === p.parentId); if (p && p.level === level) return p; } return null; };
  const tasks = () => { const w = loadWork(); return w.filter(x => x.level === 'todo').map(x => { const req = ancestor(x, w, 'requirement'), proj = req ? ancestor(req, w, 'project') : null;
    return { ...x, crumbs: wm.breadcrumb(w, x), kind: req ? 'follow' : 'daily', requirement: req ? { id: req.id, title: req.title, status: req.status } : null, project: proj ? { id: proj.id, title: proj.title } : null }; }); };
  /* 需求池：每条需求是某个项目里要完成的一件完整的事；按项目分组，附带跟进中的待办数 */
  function requirementPool() {
    const w = loadWork(), cut = Date.now() - 14 * 864e5;
    const reqs = w.filter(x => x.level === 'requirement' && (x.status === 'open' || Date.parse(x.doneAt || x.updatedAt || 0) > cut));
    const groups = new Map();
    for (const r of reqs) {
      const p = ancestor(r, w, 'project'), key = p ? p.id : '';
      if (!groups.has(key)) { const prog = p ? ancestor(p, w, 'program') : null;
        groups.set(key, { id: p?.id || null, title: p?.title || '还没归入项目', line: p?.line || null, product: p?.product || null, program: prog?.title || null, autoCreated: !!p && (!!p.autoCreated || (p.history?.[0]?.by === 'ai' && !(p.locked || []).length)), suggested: !!p?.anchorSuggested, reqs: [] }); }
      const todos = w.filter(t => t.level === 'todo' && t.parentId === r.id);
      groups.get(key).reqs.push({ id: r.id, title: r.title, summary: r.summary, type: r.type, status: r.status, deadline: r.deadline, deadline_verified: r.deadline_verified, priority: r.priority, who: r.who,
        todosOpen: todos.filter(t => t.status === 'open').length, todosDone: todos.filter(t => t.status === 'done').length, clues: (r.sids || []).length });
    }
    const list = [...groups.values()].sort((a, b) => (a.id === null) - (b.id === null) || b.reqs.length - a.reqs.length);
    return { projects: list, counts: { projects: list.filter(g => g.id).length, open: reqs.filter(r => r.status === 'open').length, unassigned: groups.get('')?.reqs.length || 0 } };
  }
  /* 线索 → 从它整理出的工作 */
  function derivedIndex() { const m = new Map(); for (const x of loadWork()) for (const s of x.sids || []) { if (!m.has(s)) m.set(s, []); m.get(s).push({ id: x.id, level: x.level, title: x.title, status: x.status }); } return m; }
  function setTask(id, status) { const w = loadWork(); wm.editItem(w, id, { status }); saveWork(w); return tasks(); }
  function workTree(opts) { return { ...wm.tree(loadWork(), opts), taxonomy: dataStore.read('taxonomy.json', { lines: [], products: [] }), levels: wm.LEVELS, reqTypes: wm.REQ_TYPES, needsReview: loadWork().filter(x => x.needsReview && x.status === 'open').length }; }
  function workItem(id) {
    const w = loadWork(), it = w.find(x => x.id === id); if (!it) throw new Error('这条工作已经不在了');
    const sigs = new Map(desk.listSignals().map(s => [s.id, s]));
    return { ...it, crumbs: wm.breadcrumb(w, it), children: w.filter(c => c.parentId === id).map(c => ({ id: c.id, level: c.level, title: c.title, status: c.status })),
      parents: w.filter(p => p.status === 'open' && p.id !== id && wm.LEVELS[p.level].n < wm.LEVELS[it.level].n).map(p => ({ id: p.id, level: p.level, title: p.title })),
      sources: (it.sids || []).map(s => sigs.get(s)).filter(Boolean).map(digest.summarize) };
  }
  function editWork(id, patch) { const w = loadWork(); wm.editItem(w, id, patch); saveWork(w); return workItem(id); }
  /* AI 管理：重新分层、挂靠、合并重复、按需新建项目 / 专项 */
  async function reorganize() {
    const w = loadWork(), taxonomy = dataStore.read('taxonomy.json', { lines: [], products: [] });
    if (!w.some(x => x.status === 'open')) return { log: [], summary: '没有进行中的工作' };
    const data = await chatJSON(wm.buildReorgPrompt({ taxonomy }), wm.packWork(w, new Map(desk.listSignals().map(s => [s.id, s]))));
    if (process.env.JM_DESK_DEBUG_DIR) fs.writeFileSync(path.join(process.env.JM_DESK_DEBUG_DIR, 'reorg-raw.json'), JSON.stringify(data, null, 1)); // 调试用，只在设置了目录时写
    const r = wm.applyReorg(w, data, { taxonomy }); saveWork(w);
    desk.log('reorg', `AI 整理工作 · ${r.log.length} 处调整`, {});
    return r;
  }
  /* 从已关联的需求管理平台同步产品树 */
  async function syncTaxonomy() {
    const cfg = desk.config(); if (!mp2.ready(cfg)) throw new Error('还没有关联需求管理平台（设置 › 需求管理平台），产品树要从平台同步');
    const t = wm.flattenTree(await mp2.productTree(cfg)); dataStore.write('taxonomy.json', t);
    return { lines: t.lines.length, products: t.products.length, syncedAt: t.syncedAt };
  }
  const lastSummary = kind => dataStore.read(kind === 'mail' ? 'summary-mail.json' : 'summary.json', null);
  function pool() {
    const all = desk.listSignals().filter(s => s.status !== 'split'), by = st => all.filter(s => s.status === st);
    return { status: pipeline.status(),
      queued: by('queued').sort((a, b) => Date.parse(b.occurred_at || 0) - Date.parse(a.occurred_at || 0)).slice(0, 30).map(digest.summarize),
      submitted: by('submitted').slice(-30).reverse().map(s => ({ id: s.id, title: s.title, source: s.source_type, at: s.submittedAt || s.occurred_at, batch: s.batchId })),
      failed: by('failed').slice(-10).reverse().map(s => ({ id: s.id, title: s.title, error: s.lastError })) };
  }
  async function candidates(status) { const cfg = desk.config(); if (!mp2.ready(cfg)) return { linked: false }; return { linked: true, ...(await mp2.myCandidates(cfg, { status: status || undefined, size: 30 })) }; }
  function setSource(name, on) { const cfg = desk.config(); if (!cfg.sources[name]) throw new Error('未知信息源：' + name); cfg.sources[name].enabled = !!on; desk.saveConfig(cfg); return pipeline.status().sources; }
  /* 线索列表：status = queued | submitted | failed | ignored | all；source = mail | feishu_im | feishu_meeting；q 关键字 */
  function signals({ status = 'all', source = null, q = '' } = {}) {
    const kw = String(q || '').trim().toLowerCase();
    const all = desk.listSignals().filter(s => s.status !== 'split');
    const counts = all.reduce((m, s) => ((m[s.status] = (m[s.status] || 0) + 1), (m['src:' + s.source_type] = (m['src:' + s.source_type] || 0) + 1), m), { all: all.length });
    const items = all.filter(s => (status === 'all' || s.status === status) && (!source || s.source_type === source) && (!kw || (s.title + '\n' + s.content).toLowerCase().includes(kw)))
      .sort((a, b) => Date.parse(b.occurred_at || b.collectedAt || 0) - Date.parse(a.occurred_at || a.collectedAt || 0))
      .slice(0, 500).map(digest.summarize);
    const idx = derivedIndex(); for (const it of items) it.derived = idx.get(it.id) || [];
    return { items, counts };
  }
  function signal(id) { const s = desk.listSignals().find(x => x.id === id); if (!s) throw new Error('这条线索已经不在了'); return { ...digest.detail(s), derived: derivedIndex().get(id) || [] }; }
  function setIgnored(id, on) {
    const s = desk.listSignals().find(x => x.id === id); if (!s) throw new Error('这条线索已经不在了');
    if (on && s.status !== 'queued') throw new Error('只有待搬运的线索可以设为不搬运');
    if (!on && s.status !== 'ignored') return signal(id);
    desk.updateSignal(id, { status: on ? 'ignored' : 'queued' }); desk.log(on ? 'ignored' : 'restored', `${on ? '不搬运' : '恢复搬运'} · ${s.title.slice(0, 28)}`, { signal: id });
    return signal(id);
  }
  /* 助手内置工具用：新建一条待办（可挂在某条需求下） */
  function addTodo({ title, summary = '', requirement_id = null, deadline = null }) {
    const w = loadWork(), t = String(title || '').trim().slice(0, 40); if (!t) throw new Error('待办需要标题');
    const req = requirement_id ? w.find(x => x.id === requirement_id && x.level === 'requirement') : null; if (requirement_id && !req) throw new Error('没有这条需求：' + requirement_id);
    const now = new Date().toISOString(), it = { id: 'w_' + Math.random().toString(16).slice(2, 14), level: 'todo', type: null, title: t, summary: String(summary).slice(0, 120), owner: 'me', who: '', sids: [], parentId: req?.id || null,
      line: req?.line || null, product: req?.product || null, deadline: /^\d{4}-\d{2}-\d{2}/.test(deadline || '') ? deadline : null, deadline_verified: false, priority: 'medium', status: 'open', addedAt: now, updatedAt: now, history: [{ at: now, by: 'assistant', fields: ['created'], note: '助手新建' }] };
    w.push(it); saveWork(w); return it;
  }
  return { addTodo, requirementPool, workTree, workItem, editWork, reorganize, syncTaxonomy, signals, signal, setIgnored, candidates, setSource, collect, summarize, tasks, setTask, lastSummary, pool, ticker: (n = 30) => desk.ticker(n), mailStats: () => cachedStats(getSettings().mailDb) };
}
