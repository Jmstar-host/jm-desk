import path from 'node:path';
import fs from 'node:fs';
/* 面板应用背后的服务：搬运、综合汇总、待办、邮箱统计、需求池。收集与平台调用复用 ../../src；邮件用 node:sqlite。 */
import * as pipeline from '../core/pipeline.mjs';
import * as mp2 from '../core/mp2.mjs';
import * as mail from './mail.mjs';
import { packSignals } from './summary.mjs';
import * as wm from './workmodel.mjs';
import * as digest from './digest.mjs';
import * as meeting from './meeting.mjs';
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
  /* 工作台看板（1.3.1）：把全部工作摊平给界面，由界面按「平台的树」和「我要处理的」来排，不再用本机自己的分组 */
  async function workBoard() {
    const scope = await scopeIds().catch(() => null);
    const w = loadWork(), t = dataStore.read('taxonomy.json', { lines: [], products: [], projects: [] }), cfg = desk.config();
    const kids = new Map(); for (const x of w) if (x.parentId) { if (!kids.has(x.parentId)) kids.set(x.parentId, []); kids.get(x.parentId).push(x); }
    const items = w.filter(x => x.status !== 'dropped' || x.mergedInto == null).map(x => ({ id: x.id, level: x.level, type: x.type || null, title: x.title, status: x.status, deadline: x.deadline || null, priority: x.priority || 'medium',
      parentId: x.parentId || null, productId: x.productId || null, product: x.product || null, updatedAt: x.updatedAt || x.addedAt || null,
      mp2: x.mp2 ? { kind: x.mp2.kind, id: x.mp2.id, code: x.mp2.code || null } : null, mp2Label: x.mp2Status?.label || null, missing: x.mp2Status?.found === false,
      pending: wm.mp2Pending(x).length, pushError: x.mp2Error && x.mp2Dirty?.length ? x.mp2Error : null, suggest: !x.mp2 && x.mp2Suggest ? x.mp2Suggest.action : null,
      todosOpen: (kids.get(x.id) || []).filter(c => c.level === 'todo' && c.status === 'open').length, clues: (x.sids || []).length, ready: !x.mp2 && x.ready ? x.ready : null, stagedBy: x.mp2 && wm.mp2Pending(x).length ? x.stagedBy || null : null }));
    return { items, taxonomy: t, levels: wm.LEVELS, reqTypes: wm.REQ_TYPES, scope, platform: { id: 'mp2', linked: mp2.ready(cfg), name: '需求管理平台', base: cfg.mp2?.webBase || cfg.mp2?.baseUrl || null, syncedAt: t.syncedAt || null },
      /* 工作台能切换的平台。接入方式有两种：contract = 平台按 JM Desk 的接入规范（docs/DESK-CONTRACT.md）开放接口；adapter = JM Desk 按平台现有的接口适配。
       * 现在只有需求管理平台（按它现有的接口适配）；ERP 等以后在这里登记 */
      platforms: [{ id: 'mp2', name: '需求管理平台', linked: mp2.ready(cfg), mode: 'adapter', syncedAt: t.syncedAt || null }] };
  }
  function workTree(opts) { return { ...wm.tree(loadWork(), { ...opts, taxonomy: dataStore.read('taxonomy.json', null) }), taxonomy: dataStore.read('taxonomy.json', { lines: [], products: [] }), levels: wm.LEVELS, reqTypes: wm.REQ_TYPES, needsReview: loadWork().filter(x => x.needsReview && x.status === 'open').length }; }
  function workItem(id) {
    const w = loadWork(), it = w.find(x => x.id === id); if (!it) throw new Error('这条工作已经不在了');
    const sigs = new Map(desk.listSignals().map(s => [s.id, s]));
    const srcs = (it.sids || []).map(s => sigs.get(s)).filter(Boolean).map(digest.summarize);
    return { ...it, pending: wm.mp2Pending(it), chain: wm.evidenceChain(it, srcs, w), crumbs: wm.breadcrumb(w, it), children: w.filter(c => c.parentId === id).map(c => ({ id: c.id, level: c.level, title: c.title, status: c.status })),
      parents: w.filter(p => p.status === 'open' && p.id !== id && wm.LEVELS[p.level].n < wm.LEVELS[it.level].n).map(p => ({ id: p.id, level: p.level, title: p.title })),
      sources: (it.sids || []).map(s => sigs.get(s)).filter(Boolean).map(digest.summarize) };
  }
  /* D87：保存即回写——改的是 MP2 的项目 / 需求时，只把改动字段送回 MP2；回写失败本地照样保存，标「待回写」，下次保存或拉取时重试 */
  async function editWork(id, patch, by = 'me', { push = true } = {}) {
    const w = loadWork(); wm.editItem(w, id, patch, undefined, by);
    const it = w.find(x => x.id === id); if (it && !push) { it.stagedBy = by; it.stagedAt = new Date().toISOString(); } // 谁提交的改动：工作台「待推送」里显示
    saveWork(w);
    const mp2Sync = push ? await pushMp2(id, by) : null; // 界面上先存本机，人看过改动再推送（push: false）；助手补充信息仍然保存即推送
    return { ...workItem(id), mp2Sync };
  }
  /* 推送前核对版本：重新读平台上的当前值，和编辑前读到的基线比。别人改过我也要改的字段 → 冲突，不推送，交给人选。
   * 项目另有平台的 revision 把关（updateProject 带 revision，对不上平台拒绝）。 */
  async function checkMp2(id) {
    const it = loadWork().find(x => x.id === id); if (!it?.mp2 || it.mp2.kind !== 'requirement') return { conflicts: [] };
    const cur = await mp2.getRequirement(requireMp2(), { id: it.mp2.id, code: it.mp2.code });
    if (!cur) return { conflicts: [], missing: true };
    const fields = wm.mp2RequirementFields(cur, taxonomy());
    return { conflicts: wm.mp2Conflicts(it, fields), current: fields };
  }
  /** 界面上的「推送」。mode：undefined 先核对；'mine' 冲突时用我的；'platform' 放弃我的改动、换成平台现在的。 */
  async function pushWork(id, mode, by = 'me') {
    const it0 = loadWork().find(x => x.id === id); if (!it0?.mp2) throw new Error('这条工作还没有对应平台记录');
    if (mode !== 'platform') { const sc = await scopeIds({ fresh: true }), pid = recordProduct(it0); // 平台只允许改负责范围内的记录：先查，免得发出去再被拒
      if (sc && pid != null && !sc.includes(Number(pid))) return { ok: false, outOfScope: true, error: `「${it0.product || '#' + pid}」不在这个关联的负责范围里，平台不允许改这条。到需求管理平台「AI 接入」把它加进负责范围，再回来推送`, item: workItem(id) }; }
    if (!wm.mp2Pending(it0).length && mode !== 'platform') return { ok: true, nothing: true, item: workItem(id) };
    let chk = { conflicts: [] };
    try { chk = await checkMp2(id); } catch (e) { return { ok: false, error: '推送前没能读到平台上的最新内容，没有推送：' + e.message, item: workItem(id) }; }
    if (chk.missing) return { ok: false, error: '需求管理平台上找不到这条记录了：先「从需求管理平台拉取」', item: workItem(id) };
    if (mode === 'platform') { const w = loadWork(), it = w.find(x => x.id === id); wm.mp2Discard(it, chk.current || null); (it.history ||= []).push({ at: new Date().toISOString(), by, fields: [], note: '放弃本机改动，改用平台上的内容' }); saveWork(w); return { ok: true, discarded: true, item: workItem(id) }; }
    if (chk.conflicts.length && mode !== 'mine') return { ok: false, conflict: chk.conflicts, item: workItem(id) };
    if (chk.current) { const w = loadWork(), it = w.find(x => x.id === id); wm.mp2Rebase(it, chk.current); saveWork(w); } // 平台上别人改的、和我无关的字段先并进基线
    const r = await pushMp2(id, by);
    return { ...(r || { ok: true, nothing: true }), item: workItem(id) };
  }
  async function pushMp2(id, by = 'me') {
    const w = loadWork(), it = w.find(x => x.id === id); if (!it?.mp2) return null;
    const cfg = desk.config(); if (!mp2.ready(cfg)) return { ok: false, error: '还没有关联需求管理平台' };
    let p; try { p = wm.mp2Patch(it, { taxonomy: taxonomy() }); } catch (e) { return { ok: false, error: e.message } }
    if (!p) return null;
    try {
      // 项目是整体提交：updateProject 会先读平台上的当前值（说明、起止），把改动盖上去再提交
      const r = p.kind === 'requirement' ? await mp2.updateRequirement(cfg, p.id, p.body) : await mp2.updateProject(cfg, p.id, p.body, { productId: it.mp2.productId ?? (taxonomy().projects || []).find(x => x.mp2Id === it.mp2.id)?.productMp2Id ?? (taxonomy().products || []).find(x => x.id === it.productId)?.mp2Id });
      const w2 = loadWork(), it2 = w2.find(x => x.id === id);
      if (it2) { wm.markMp2Pushed(it2, p, r); (it2.history ||= []).push({ at: new Date().toISOString(), by, fields: p.fields, note: `已回写需求管理平台 ${it2.mp2.code || '#' + it2.mp2.id}${r?.startFilled ? '（平台要求起止成对，计划开始按今天填）' : ''}` }); it2.history = it2.history.slice(-20); saveWork(w2); }
      return { ok: true, fields: p.fields, code: it2?.mp2.code || null };
    } catch (e) {
      const w2 = loadWork(), it2 = w2.find(x => x.id === id); if (it2) { wm.markMp2Failed(it2, p, e.message); saveWork(w2); }
      return { ok: false, error: e.message, fields: p.fields };
    }
  }
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
  /* 从已关联的需求管理平台同步产品树：优先读「产品项目计划」的树（产品线 › 平台产品 › 项目，D86）；
   * 平台还没有这个接口或连接没有授权时，退回旧的业务产品树（没有项目）。同步后顺带刷新已绑定工作的 MP2 状态。 */
  const requireMp2 = () => { const cfg = desk.config(); if (!mp2.ready(cfg)) throw new Error('还没有关联需求管理平台（设置 › 需求管理平台）'); return cfg; };
  /* D87：从需求管理平台拉取——产品树（产品线 › 平台产品 › 项目）+ 全部原始需求，落成工作台的工作（MP2 为准）。
   * 顺序：先把本地「待回写」的改动推上去，再拉取合并，再刷新进度，最后让 AI 给还没对齐的本地工作出建议（待归入）。 */
  async function syncTaxonomy({ suggest = true } = {}) {
    const cfg = requireMp2();
    let t, fallback = null;
    try { t = wm.flattenPortfolio(await mp2.portfolioTree(cfg)); }
    catch (e) { if (e.stop) throw e; fallback = e.code || e.message; t = { ...wm.flattenTree(await mp2.productTree(cfg)), projects: [] }; }
    dataStore.write('taxonomy.json', t); scopeCache = null; // 负责范围可能在平台上调整过
    let pushed = 0, pushFailed = 0;
    for (const it of loadWork().filter(x => x.mp2 && x.mp2Dirty?.length)) { const r = await pushMp2(it.id, 'me'); if (r?.ok) pushed++; else if (r) pushFailed++; }
    let reqs = null, reqError = null;
    try { reqs = await mp2.listRequirements(cfg); } catch (e) { if (e.stop) throw e; reqError = e.message; }
    const w = loadWork(), m = wm.mergeMp2(w, { taxonomy: t, requirements: reqs }); saveWork(w);
    let refreshed = 0; try { refreshed = (await refreshMp2()).updated; } catch { /* 刷新失败不影响拉取结果 */ }
    let suggested = 0, suggestError = null;
    if (suggest) { try { suggested = await suggestMp2(); } catch (e) { suggestError = e.message; } }
    const pending = loadWork().filter(x => x.status === 'open' && !x.mp2 && (['project', 'requirement'].includes(x.level) || (!x.parentId && !x.productId))).length;
    return { lines: t.lines.length, products: t.products.length, projects: (t.projects || []).length, requirements: reqs ? reqs.length : null, reqError,
      added: m.added, updated: m.updated, missing: m.missing, pushed, pushFailed, refreshed, suggested, suggestError, pending, syncedAt: t.syncedAt, origin: t.origin || null, fallback };
  }
  /* 待归入：AI 把本地还没对应 MP2 的工作映射到 MP2（绑定已有 / 新建到某平台产品 / 归到某平台产品），只写建议，人确认后才生效 */
  async function suggestMp2() {
    const w = loadWork(), packed = wm.packUnaligned(w); let t = taxonomy();
    if (!packed || !(t.products || []).length) return 0;
    // 只让 AI 在这个关联的负责范围内选平台产品：范围外的建议上传时一定被平台拒绝
    try { const scope = await mp2.responsibility(desk.config()); if (scope?.length) { const ids = new Set(scope.map(s => s.id)); const inScope = (t.products || []).filter(p => ids.has(mp2IdOf(p))); if (inScope.length) t = { ...t, products: inScope, projects: (t.projects || []).filter(j => inScope.some(p => p.id === j.productId)) }; } } catch { /* 读不到范围时按整棵树给建议 */ }
    const data = await chatJSON(wm.buildSuggestPrompt({ taxonomy: t, work: w }), packed);
    const w2 = loadWork(), n = wm.applySuggest(w2, data, { taxonomy: t }); saveWork(w2); return n;
  }
  /* AI 准备好一条要录入 / 新建到平台的工作（1.5.0）：只记在本机（ready），在工作台「待录入」里标出来，人点「录入」才真的写平台。
   * 和 git 一样：AI（助手、本机 AI、执行者）提交，人在 JM Desk 推送 */
  function stageReady(id, by, { action, product, productMp2Id } = {}) {
    const w = loadWork(), it = w.find(x => x.id === id); if (!it) throw new Error('这条工作已经不在了');
    if (it.mp2) throw new Error('这条已经对应平台记录了，用 update_work 改');
    let p = product ? productByName(product) : null;
    if (product && !p) throw new Error(`产品树里没有「${product}」，先 list_mp2_upload_products 看可选的`);
    if (!p && productMp2Id != null) { const t = taxonomy(), pr = (t.products || []).find(x => x.mp2Id === productMp2Id), ln = pr && (t.lines || []).find(l => l.id === pr.lineId); if (pr) p = { product: pr.name, productId: pr.id, line: ln?.path || null, lineId: ln?.id || null }; }
    if (p) wm.editItem(w, id, p, undefined, by);
    it.ready = { by, at: new Date().toISOString(), action: action || (it.level === 'project' ? 'create' : 'upload') };
    (it.history ||= []).push({ at: it.ready.at, by, fields: ['ready'], note: '准备好录入平台，等确认' });
    saveWork(w); return { ok: true, staged: true, id, product: it.product || null, note: '已在 JM Desk 工作台「待录入」里备好，用户核对后点「录入」才会写到需求管理平台' };
  }
  async function applyMp2Suggestion(id, by = 'me', { stage = false } = {}) {
    const it = loadWork().find(x => x.id === id); if (!it) throw new Error('这条工作已经不在了');
    const s = it.mp2Suggest; if (!s) throw new Error('这条工作没有待确认的建议');
    if (s.action === 'bind') return { ok: true, action: 'bind', item: bindWork(id, { id: s.mp2Id, code: s.code, title: s.title }, by) };
    if (stage && s.action === 'create') return { action: 'create', ...stageReady(id, by, { productMp2Id: s.productMp2Id }) };
    if (s.action === 'create' && it.level === 'requirement') return { action: 'create', ...(await uploadWork(id, by, { productId: s.productMp2Id })) };
    if (s.action === 'create' && it.level === 'project') return { action: 'create', ...(await createProjectWork(id, by, { productId: s.productMp2Id })) };
    const prod = (taxonomy().products || []).find(p => p.mp2Id === s.productMp2Id); if (!prod) throw new Error('产品树里已经没有这个平台产品，先拉取一次');
    const line = (taxonomy().lines || []).find(l => l.id === prod.lineId);
    const w = loadWork(); wm.editItem(w, id, { product: prod.name, productId: prod.id, line: line?.path || null, lineId: line?.id || null }, undefined, by); saveWork(w);
    return { ok: true, action: 'anchor', item: workItem(id) };
  }
  function dismissMp2Suggestion(id) { const w = loadWork(), it = w.find(x => x.id === id); if (it) { delete it.mp2Suggest; it.mp2SuggestDismissed = true; saveWork(w); } return workItem(id); }
  /* 本地项目在 MP2 新建为平台研发项目（来源 product），成功后绑定；同一平台产品下已有同名项目时不新建，返回候选 */
  async function createProjectWork(id, by = 'me', { productId } = {}) {
    const cfg = requireMp2(), t = taxonomy(), it = loadWork().find(x => x.id === id);
    if (!it) throw new Error('这条工作已经不在了');
    if (it.level !== 'project') throw new Error('只有「项目」可以在需求管理平台新建为项目');
    if (it.mp2) throw new Error(`已经对应 ${it.mp2.code || '#' + it.mp2.id}`);
    const prod = productId ? (t.products || []).find(p => p.mp2Id === Number(productId)) : (t.products || []).find(p => p.id === it.productId || p.name === it.product);
    if (!prod) throw new Error('先选这个项目建在哪个平台产品下');
    const body = { business_project_id: prod.mp2Id, name: String(it.title || '').trim().slice(0, 60), source: 'product' };
    if (it.summary) body.description = String(it.summary).slice(0, 2000);
    if (/^\d{4}-\d{2}-\d{2}/.test(String(it.deadline || ''))) body.planned_end = String(it.deadline).slice(0, 10);
    let r;
    try { r = await mp2.createProject(cfg, body); }
    catch (e) {
      if (!/同名项目/.test(e.message)) throw e;
      const same = (t.projects || []).filter(p => p.productId === prod.id && p.name === body.name).map(p => ({ id: p.mp2Id, code: p.code, name: p.name }));
      return { ok: false, duplicate: true, message: `「${prod.name}」下已有同名项目，没有重复创建。确认是同一件事就绑定它。`, candidates: same };
    }
    t.projects = [...(t.projects || []).filter(p => p.mp2Id !== r.id), { id: `mp2:j:${r.id}`, mp2Id: r.id, name: r.name, code: r.project_code || null, productId: prod.id,
      path: prod.path, state: 'idle', start: r.planned_start || null, end: r.planned_end || null, revision: r.revision ?? 0, requirementIds: [] }];
    dataStore.write('taxonomy.json', t);
    const w = loadWork(); wm.bindMp2(w, id, { id: r.id }, { taxonomy: t, by }); const h = w.find(x => x.id === id).history; h[h.length - 1].note = `在需求管理平台新建项目 ${r.project_code || '#' + r.id}${r.startFilled ? '（平台要求起止成对，计划开始按今天填）' : ''}`;
    wm.mergeMp2(w, { taxonomy: { ...t, projects: t.projects.filter(p => p.mp2Id === r.id) }, partial: true }); saveWork(w);
    desk.log('moved', `新建项目 · ${body.name} → MP2 ${r.project_code || '#' + r.id}`, { work: id });
    return { ok: true, id: r.id, code: r.project_code || null, title: r.name, product: prod.name, item: workItem(id) };
  }
  const taxonomy = () => dataStore.read('taxonomy.json', { lines: [], products: [], projects: [] });
  /** 产品树里的平台产品（名称或编号）→ 工作台字段 { product, productId, line, lineId, mp2Id } */
  function productByName(name) {
    const t = taxonomy(), n = String(name || '').trim(), list = t.products || [];
    const p = list.find(x => x.name === n || x.code === n) || (list.filter(x => x.name.includes(n)).length === 1 ? list.find(x => x.name.includes(n)) : null);
    if (!p) return null; const line = (t.lines || []).find(l => l.id === p.lineId);
    return { product: p.name, productId: p.id, line: line?.path || null, lineId: line?.id || null, mp2Id: p.mp2Id };
  }
  /* 绑定 / 解绑 MP2 记录（项目来自产品树，需求来自搜索）；by：me 界面 / assistant 助手 / local-ai 本机 AI */
  function bindWork(id, ref, by = 'me') { const w = loadWork(); wm.bindMp2(w, id, ref, { taxonomy: taxonomy(), by }); delete w.find(x => x.id === id).mp2Suggest; wm.foldMp2Duplicates(w); saveWork(w); return workItem(id); } // 绑到已拉取的记录：拉取副本并进这条
  function unbindWork(id, by = 'me') { const w = loadWork(); wm.unbindMp2(w, id, { by }); saveWork(w); return workItem(id); }
  async function searchMp2Requirements(q) { return mp2.searchRequirements(requireMp2(), q); }
  /* D87：把本地需求上传为 MP2 原始需求，成功后自动绑定并读一次进度。重名时不创建，返回同名候选让人 / 助手选择绑定。 */
  /* 能上传到的平台产品：产品树里、且在关联负责范围内的（范围为空 = 都行；读不到范围时列出全部并标 unknown） */
  const mp2IdOf = p => p.mp2Id ?? (Number(String(p.id).replace(/^mp2:p:/, '')) || null);
  async function mp2UploadTargets() {
    const cfg = requireMp2(), t = taxonomy(), all = (t.products || []).map(p => ({ mp2Id: mp2IdOf(p), name: p.name, code: p.code || null, path: p.path || '' })).filter(p => p.mp2Id);
    let scope = null; try { scope = await mp2.responsibility(cfg); } catch (e) { if (e.stop) throw e; }
    if (!scope || !scope.length) return { scoped: false, unknown: scope === null, synced: all.length > 0, products: all };
    const ids = new Set(scope.map(s => s.id));
    const inTree = all.filter(p => ids.has(p.mp2Id));
    const missing = scope.filter(s => !inTree.some(p => p.mp2Id === s.id)).map(s => ({ mp2Id: s.id, name: s.name, code: null, path: '' }));
    return { scoped: true, unknown: false, synced: all.length > 0, products: [...inTree, ...missing] };
  }
  async function uploadWork(id, by = 'me', { product, productId } = {}) {
    const cfg = requireMp2();
    if (product || productId) { // 选了平台产品（界面下拉给 MP2 id，助手给名称）：先按产品树改平台产品（产品线跟着走），再上传
      const t = taxonomy(), name = String(product || '').trim(), list = t.products || [];
      const p = productId ? list.find(x => mp2IdOf(x) === Number(productId))
        : list.find(x => x.name === name || x.code === name) || (list.filter(x => x.name.includes(name)).length === 1 ? list.find(x => x.name.includes(name)) : null);
      if (!p) throw new Error(list.length ? `产品树里没有唯一匹配「${name || '#' + productId}」的平台产品` : '还没有同步产品树：先「从需求管理平台拉取」');
      const line = (t.lines || []).find(l => l.id === p.lineId);
      const ws = loadWork(); wm.editItem(ws, id, { product: p.name, productId: p.id, ...(line ? { line: line.name, lineId: line.id } : {}) }); saveWork(ws);
    }
    const w = loadWork(), it = w.find(x => x.id === id);
    const sigs = new Map(desk.listSignals().map(s => [s.id, s]));
    const sources = (it?.sids || []).map(s => sigs.get(s)).filter(Boolean).map(digest.summarize);
    const body = wm.mp2RequirementDraft(w, id, { taxonomy: taxonomy(), sources });
    let r;
    try { r = await mp2.createRequirement(cfg, body); }
    catch (e) {
      if (/负责范围/.test(e.message)) {
        const names = await mp2UploadTargets().then(r => r.products.map(p => p.name)).catch(() => []);
        const head = body.business_project_id ? `「${it.product}」不在这个关联的负责范围里` : '需求管理平台要求这条需求挂到你负责的平台产品下';
        throw Object.assign(new Error(`${head}：在上传处选一个平台产品再上传${names.length ? `（可选：${names.join('、')}）` : ''}`), { code: 'product_required', products: names });
      }
      if (e.code !== 'title_duplicated') throw e;
      const same = (await mp2.searchRequirements(cfg, body.title).catch(() => [])).filter(x => x.title === body.title);
      return { ok: false, duplicate: true, message: `需求管理平台已有同名需求「${body.title}」，没有重复创建。确认是同一件事就绑定它。`, candidates: same };
    }
    const fresh = loadWork(); wm.bindMp2(fresh, id, { id: r.id, code: r.code, title: r.title }, { taxonomy: taxonomy(), by });
    const h = fresh.find(x => x.id === id).history; h[h.length - 1].note = `上传到需求管理平台 ${r.code || '#' + r.id}`;
    delete fresh.find(x => x.id === id).mp2Suggest;
    wm.mergeMp2(fresh, { taxonomy: { ...taxonomy(), projects: [] }, partial: true, requirements: [{ id: r.id, code: r.code, title: body.title, description: body.description, priority: body.priority,
      status: 'draft', product_id: body.business_project_id ?? null, expected_date: body.expected_date || null, requirement_type: body.requirement_type || null }] }); // 记下基线，之后保存可回写
    saveWork(fresh);
    desk.log('moved', `上传 · ${body.title.slice(0, 28)} → MP2 ${r.code || '#' + r.id}`, { work: id });
    try { await refreshMp2(); } catch { /* 进度读取失败不影响上传结果 */ }
    return { ok: true, id: r.id, code: r.code, title: r.title, product: body.business_project_id ? it.product : null, item: workItem(id) };
  }
  /* 刷新已绑定工作的 MP2 状态：项目看产品树（先同步产品树才是最新），需求读 by-requirements */
  async function refreshMp2() {
    const cfg = requireMp2(), w = loadWork();
    const ids = w.filter(x => x.mp2?.kind === 'requirement').map(x => x.mp2.id);
    const links = [];
    for (let i = 0; i < ids.length; i += 200) links.push(...await mp2.requirementLinks(cfg, ids.slice(i, i + 200)));
    const known = new Set(w.filter(x => x.mp2?.kind === 'requirement' && x.mp2Base).map(x => x.mp2.id)); // 拉取到的需求：没进需求计划也算找得到
    const updated = wm.applyMp2Status(w, { taxonomy: taxonomy(), links, known });
    saveWork(w);
    return { updated, requirements: ids.length };
  }
  /* 给助手 / 本机 AI：工作台的工作（可按层级、状态、标题筛选），附 MP2 绑定与实时状态 */
  function workList({ level, status = 'open', q } = {}) {
    const w = loadWork(), kw = String(q || '').trim().toLowerCase(), byId = new Map(w.map(x => [x.id, x]));
    return w.filter(x => (!level || x.level === level) && (status === 'all' || x.status === status) && (!kw || String(x.title).toLowerCase().includes(kw)))
      .slice(0, 150).map(x => ({ id: x.id, level: wm.LEVELS[x.level]?.label || x.level, title: x.title, status: wm.STATUS[x.status] || x.status,
        type: x.type ? wm.REQ_TYPES[x.type] : undefined, line: x.line || undefined, product: x.product || undefined, deadline: x.deadline || undefined,
        summary: x.summary ? String(x.summary).slice(0, 300) : undefined, priority: x.priority,
        pending_writeback: x.mp2Dirty?.length ? { fields: x.mp2Dirty, error: x.mp2Error } : undefined,
        suggestion: x.mp2Suggest ? { action: x.mp2Suggest.action, target: x.mp2Suggest.code || x.mp2Suggest.title || x.mp2Suggest.product, reason: x.mp2Suggest.reason } : undefined,
        parent: x.parentId && byId.get(x.parentId) ? { id: x.parentId, title: byId.get(x.parentId).title } : undefined,
        mp2: x.mp2 ? { kind: x.mp2.kind, id: x.mp2.id, code: x.mp2.code, title: x.mp2.title, status: x.mp2Status?.label,
          plans: x.mp2Status?.plans?.map(p => `${p.name || p.code}：${p.label}${p.end ? '，排期至 ' + p.end : ''}`), functions: x.mp2Status?.functions?.map(f => f.title) } : undefined }));
  }
  /* 给助手 / 本机 AI：产品树里的项目（可按平台产品或名称筛选） */
  function mp2Projects({ product, q } = {}) {
    const t = taxonomy(), kw = String(q || '').trim().toLowerCase();
    const prodOf = id => (t.products || []).find(p => p.id === id);
    return (t.projects || []).filter(p => (!product || prodOf(p.productId)?.name === product) && (!kw || (p.name + ' ' + (p.code || '')).toLowerCase().includes(kw)))
      .slice(0, 100).map(p => ({ id: p.mp2Id, code: p.code, name: p.name, product: prodOf(p.productId)?.name, line_path: prodOf(p.productId)?.path, state: wm.MP2_PROJECT_STATE[p.state] || p.state }));
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
  /* 会议纪要：AI 整理后作为一条「本机会议」线索进线索池，状态 local（只在本机，不自动送平台；在线索里点「恢复搬运」才送） */
  async function saveMeeting(m) {
    let minutes = null, aiError = null;
    try { minutes = await chatJSON(meeting.buildMinutesPrompt(), `会议主题：${m.topic || '（没填）'}\n时长：${Math.round(m.durationSec / 60)} 分钟\n逐字稿：\n<<<\n${m.transcript.slice(0, 60000)}\n>>>`); }
    catch (e) { aiError = e.message; }
    const sig = meeting.meetingSignal(m, minutes);
    desk.putSignal(sig); desk.updateSignal(sig.id, { status: 'local' });
    desk.log('meeting', `会议纪要 · ${sig.title.slice(0, 28)}（${Math.round(m.durationSec / 60)} 分钟）`, { signal: sig.id });
    return { id: sig.id, title: sig.title, minutes, aiError, chars: m.transcript.length };
  }
  /* 把指定的线索交给 AI 整理成工作（会议纪要「整理进工作台」用）；和「汇总新线索」同一套抽取与合并 */
  const summarizeMeetings = () => summarize({ sources: ['meeting_local'], hours: 24 * 14, refresh: false });
  /* AI 按线索补全平台字段：每个字段给出值和原话出处；线索里没有的列进 missing（界面上标「需要人工补充」）。只给建议，不改数据 */
  /* 关联的负责范围（平台产品 id 列表）：平台只允许改范围内的记录。缓存 5 分钟；读不到返回 null（按不限处理，由平台把关） */
  let scopeCache = null;
  async function scopeIds({ fresh = false } = {}) {
    const cfg = desk.config(); if (!mp2.ready(cfg)) return null;
    if (!fresh && scopeCache && Date.now() - scopeCache.at < 5 * 60e3) return scopeCache.ids;
    let ids = null; try { const sc = await mp2.responsibility(cfg); ids = sc?.length ? sc.map(x => Number(x.id)) : null; } catch { ids = scopeCache?.ids ?? null; }
    scopeCache = { at: Date.now(), ids }; return ids;
  }
  const recordProduct = it => it?.mp2?.productId ?? (taxonomy().products || []).find(p => p.id === it?.productId)?.mp2Id ?? null;
  /* 手动新建一条待录入（需求或项目）：给一句话也行，之后用「AI 结合线索和知识补全」 */
  function newDraft({ level = 'requirement', title = '', summary = '', productId = null } = {}) {
    if (!['requirement', 'project'].includes(level)) throw new Error('只能新建需求或项目');
    const t = taxonomy(), prod = productId ? (t.products || []).find(p => p.id === productId) : null, line = prod ? (t.lines || []).find(l => l.id === prod.lineId) : null;
    const now = new Date().toISOString(), w = loadWork();
    const it = { id: 'w_' + Math.random().toString(16).slice(2, 14), level, type: level === 'requirement' ? 'feature' : null, title: String(title || '').trim().slice(0, 200) || (level === 'requirement' ? '新需求' : '新项目'),
      summary: String(summary || '').slice(0, 4000), owner: 'me', who: '', sids: [], parentId: null, line: line?.path || prod?.path || null, lineId: line?.id || null, product: prod?.name || null, productId: prod?.id || null,
      deadline: null, deadline_verified: false, priority: 'medium', status: 'open', addedAt: now, updatedAt: now, locked: [], history: [{ at: now, by: 'me', fields: ['created'], note: '手动新建' }] };
    w.push(it); saveWork(w); return it;
  }
  /* 线索池里和这条相关的线索（没有挂线索时用）：按标题、说明里的词打分，取前几条 */
  function relatedSignals(it, n = 5) {
    const text = `${it.title} ${it.summary || ''}`, words = [...new Set((text.match(/[A-Za-z0-9]{2,}|[\u4e00-\u9fa5]{2,}/g) || []).flatMap(x => /[\u4e00-\u9fa5]/.test(x) && x.length > 4 ? x.match(/.{2}/g) : [x.toLowerCase()]))].slice(0, 24);
    if (!words.length) return [];
    return desk.listSignals().filter(s => s.status !== 'split').map(s => { const hay = (s.title + '\n' + String(s.content || '').slice(0, 20000)).toLowerCase(); return { s, n: words.filter(k => hay.includes(k)).length }; })
      .filter(x => x.n >= Math.min(2, words.length)).sort((a, b) => b.n - a.n).slice(0, n).map(x => x.s);
  }
  /* AI 按线索和知识补全平台字段：依据可以来自这条挂的线索（S）、线索池里相关的线索（S）、知识库检索结果（K）。
   * 每个字段给出值和原话出处，原话要真的在那份材料里；没依据的列进 missing。只给建议，不改数据 */
  async function aiFill(id, { knowledge = [] } = {}) {
    const w = loadWork(), it = w.find(x => x.id === id); if (!it) throw new Error('这条工作已经不在了');
    const all = new Map(desk.listSignals().map(s => [s.id, s]));
    let sigs = (it.sids || []).map(s => all.get(s)).filter(Boolean).slice(0, 8), related = false;
    if (sigs.length < 3) { const more = relatedSignals(it).filter(s => !sigs.includes(s)); if (more.length) related = true; sigs = [...sigs, ...more].slice(0, 8); }
    const kn = (knowledge || []).filter(k => k && k.text).slice(0, 4);
    if (!sigs.length && !kn.length && !String(it.summary || '').trim() && /^新(需求|项目)$/.test(it.title)) return { fields: {}, missing: [{ field: '*', ask: '先在标题或描述里用一两句话说要做什么，AI 才能去线索池和知识库里找依据' }], sources: [] };
    let products = (taxonomy().products || []).map(p => p.name);
    try { const t = await mp2UploadTargets(); if (t.products?.length) products = t.products.map(p => p.name); } catch {}
    const packed = [...sigs.map((s, i) => `S${i + 1}｜${digest.summarize(s).sourceLabel}｜${s.title}｜${s.occurred_at || s.collectedAt || ''}\n${String(s.content || '').slice(0, 5000)}`),
      ...kn.map((k, i) => `K${i + 1}｜知识库｜${k.title}\n${String(k.text).slice(0, 3000)}`)].join('\n\n---\n\n');
    const prompt = wm.buildFillPrompt({ level: it.level, products });
    const data = await chatJSON(prompt, `当前这条（用户写的草稿，是要做的事，不是依据）：${it.title}\n${it.summary || ''}\n\n材料（S 是线索，K 是知识库）：\n${packed || '（没有找到相关的线索和知识）'}`);
    const fields = {}, norm = x => String(x || '').replace(/\s+/g, '');
    for (const [k, v] of Object.entries(data?.fields || {})) {
      if (!wm.EVIDENCE_FIELDS[k] || !v || v.value == null || v.value === '') continue;
      const ref = String(v.source || '').toUpperCase(), n = Number(ref.replace(/\D/g, '')) - 1, isK = ref.startsWith('K');
      const sig = isK ? null : sigs[n], kb = isK ? kn[n] : null, body = sig ? sig.content : kb ? kb.text : '';
      const quote = String(v.quote || '').slice(0, 120), real = !!(body && quote && norm(body).includes(norm(quote).slice(0, 12)));
      if (k === 'product' && !products.includes(String(v.value))) continue;
      fields[k] = { value: String(v.value).slice(0, k === 'summary' ? 2000 : 200), sid: sig?.id || null, kb: kb ? kb.title : null, quote: sig || kb ? quote : '', verified: real,
        source: sig ? digest.summarize(sig).sourceLabel + ' · ' + sig.title : kb ? '知识库 · ' + kb.title : '用户草稿' };
      if (!sig && !kb) fields[k].by = 'draft';
    }
    return { fields, missing: (data?.missing || []).filter(m => m && m.field).slice(0, 8), related, sources: [...sigs.map(s => ({ id: s.id, title: s.title })), ...kn.map(k => ({ kb: k.title }))] };
  }
  /* 保存字段依据（录入前由界面带上）：{ 字段: { by: 'ai'|'me', sid, quote } } */
  function setEvidence(id, fields) {
    const w = loadWork(), it = w.find(x => x.id === id); if (!it) throw new Error('这条工作已经不在了');
    const clean = {}; for (const [k, e] of Object.entries(fields || {})) if (wm.EVIDENCE_FIELDS[k] && e) clean[k] = e.by === 'me' || e.by === 'draft' ? { by: 'me' } : { by: 'ai', sid: e.sid ? String(e.sid) : null, kb: e.kb ? String(e.kb).slice(0, 80) : null, quote: String(e.quote || '').slice(0, 200), verified: !!e.verified };
    for (const e of Object.values(clean)) if (e.sid && !(it.sids ||= []).includes(e.sid)) it.sids.push(e.sid); // 用到的线索挂到这条上，证据链里能看到
    it.evidence = { at: new Date().toISOString(), fields: clean }; saveWork(w); return it.evidence;
  }
  return { stageReady, scopeIds, newDraft, aiFill, setEvidence, saveMeeting, summarizeMeetings, addTodo, requirementPool, workBoard, pushWork, workTree, workItem, editWork, reorganize, syncTaxonomy, bindWork, unbindWork, uploadWork, mp2UploadTargets, createProjectWork, productByName, applyMp2Suggestion, dismissMp2Suggestion, suggestMp2, pushMp2, searchMp2Requirements, refreshMp2, mp2Projects, workList, signals, signal, setIgnored, candidates, setSource, collect, summarize, tasks, setTask, lastSummary, pool, ticker: (n = 30) => desk.ticker(n), mailStats: () => cachedStats(getSettings().mailDb) };
}
