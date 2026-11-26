/* 协同录入（1.10.0）：一条需求在需求管理平台上的全流程。
 * 规矩：AI 只出建议和草稿（每个字段标出处）；选已有的还是新建、叫什么、写不写，都由人点。每次写平台前先列出「将写入什么」，再点一次才发。 */
const { ipcRenderer, shell } = require('electron');
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else if (k === 'value') e.value = v ?? ''; else if (v !== undefined && v !== false && v !== null) e.setAttribute(k, v === true ? '' : v); } kids.flat(Infinity).filter(x => x != null && x !== false).forEach(k => e.append(k.nodeType ? k : document.createTextNode(String(k)))); return e; };
const call = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (r && r.ok === false) throw new Error(r.error); return r && 'data' in r ? r.data : r; };
const ID = new URLSearchParams(location.search).get('id');
if (process.platform !== 'darwin') document.body.classList.add('win');
let S = null, step = null, flash = null, busy = false, goNext = null;
const aiMemo = new Map(); // 每一步 AI 上一次给的建议（重新排版后还在；刷新平台数据后清掉）
const pick = {}; // 每一步里人当前选的东西（刷新后保留）
const F = (label, el, req, ev) => [h('label', {}, label, req ? h('i', {}, '*') : null), h('div', {}, el, ev || null)];
const box = (title, ...kids) => h('section', { class: 'box' }, title ? h('h4', {}, ...[].concat(title)) : null, ...kids);
const inp = (v, ph, attrs = {}) => h('input', { value: v || '', placeholder: ph || '', ...attrs });
const area = (v, ph, rows = 3) => { const t = h('textarea', { placeholder: ph || '', rows }); t.value = v || ''; return t; };
const date = v => h('input', { type: 'date', value: v || '' });
const sel = (pairs, cur, attrs = {}) => h('select', attrs, ...pairs.map(([v, n]) => h('option', { value: v, selected: String(v) === String(cur ?? '') }, n)));
const range = (a, b) => h('div', { class: 'two' }, a, h('span', {}, '到'), b);
const fmt = (a, b) => (a || b ? `${a || '未定'} ~ ${b || '未定'}` : '未排期');

async function load(keep) {
  if (!keep) $('#pane').replaceChildren(h('div', { class: 'loading' }, h('i'), h('i'), h('i')));
  try { S = await call('flow:state', ID); } catch (e) { $('#steps').replaceChildren(); $('#pane').replaceChildren(h('div', { class: 'empty' }, e.message)); return; }
  $('#code').textContent = S.requirement.code || ''; $('#what').textContent = S.requirement.title; $('#what').title = S.requirement.title;
  if (!step || !keep) step = step && keep ? step : S.current;
  draw();
}
function draw() {
  const MARK = { done: '✓', warn: '!', now: '', todo: '' };
  $('#steps').replaceChildren(...S.steps.map((x, i) => h('div', { class: `st ${x.state}${x.key === step ? ' on' : ''}`, onclick: () => { step = x.key; flash = null; draw(); } }, h('i', { class: 'd' }, MARK[x.state] || ''), h('div', {}, h('b', {}, `${i + 1}. ${x.label}`), x.note ? h('small', { title: x.note }, x.note) : null))));
  const note = flash ? h('div', { class: 'flash ' + (flash.bad ? 'bad' : 'good') }, flash.text) : null;
  const gaps = S.gaps.length ? h('section', { class: 'box warn' }, h('div', { class: 'note' }, `这次有 ${S.gaps.length} 处平台数据没读到（${[...new Set(S.gaps.map(g => g.what))].join('、')}），下面相应的内容可能不全。点右上角「刷新」再读一次。`)) : null;
  let body; try { body = PANES[step](); } catch (e) { body = [h('div', { class: 'box warn' }, '这一步显示出错：' + e.message)]; }
  $('#pane').replaceChildren(h('div', { class: 'wrap' }, note, gaps, ...[].concat(body).filter(Boolean)));
}

/* ---------- 共用：AI 草稿、依据、确认 ---------- */
/* 依据：标出处和原话；原话在材料里核对过的打勾，没核对上的标问号，没有依据的直说 */
function evLine(f, sources) {
  if (!f) return null;
  if (!f.source) return h('div', { class: 'ev none' }, 'AI 写的，没有给出依据：请自己核对');
  const src = (sources || []).find(s => s.key === f.source);
  return h('div', { class: 'ev ' + (f.verified ? 'good' : 'weak') + (src?.id ? ' link' : ''), title: src?.id ? '在「线索」里看原文' : '', onclick: src?.id ? () => ipcRenderer.send('list:open', src.id) : null }, f.sourceLabel || f.source, f.quote ? [' ', h('q', {}, f.quote)] : null, f.verified ? null : '（原话没在材料里核对上）');
}
/* 让 AI 给这一步的草稿。fill(字段值) 把草稿填进表单；onPick(已有对象) 处理「AI 认为该用已有的」 */
function aiBox(kind, { title, choices = [], fields, onPick }) {
  const out = h('div'), noteIn = inp('', '可以补一句要求，比如：按 12 月上线来排（可不填）');
  const btn = h('button', { class: 'sm' }, aiMemo.has(kind) ? '再让 AI 给一次' : '让 AI 给建议');
  const show = (d, fresh) => {
    const got = Object.keys(d.fields).filter(k => fields[k]);
    for (const k of got) { const el = fields[k]; if (fresh) { el.input.value = d.fields[k].value; el.input.dispatchEvent(new Event('input')); el.input.dispatchEvent(new Event('change')); } if (fresh || el.input.value === d.fields[k].value) el.ev.replaceChildren(evLine(d.fields[k], d.sources) || ''); }
    const bits = [];
    if (d.pick && onPick) bits.push(h('div', { class: 'note' }, h('b', {}, `AI 认为应该用已有的「${d.pick.name}」`), d.pick.reason ? '：' + d.pick.reason : '', '。已经帮你选中，你可以改。'));
    else if (choices.length && onPick) bits.push(h('div', { class: 'note' }, 'AI 认为已有的都不合适，建议新建。要不要新建由你定。'));
    bits.push(h('div', { class: 'note' }, Object.keys(d.fields).length ? `草稿填进了表单（${Object.keys(d.fields).map(k => d.labels[k]).join('、')}），每个字段下面是依据。` : '材料里没有找到能用的内容，没有填草稿。', ` 用到 ${d.sources.filter(x => x.id).length} 条线索、${d.sources.filter(x => x.kb).length} 条知识库结果。`));
    for (const m of d.missing) bits.push(h('div', { class: 'miss' }, `${m.label}：没有依据。${m.ask}`));
    out.replaceChildren(...bits);
  };
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'AI 在读线索和知识库…'; out.replaceChildren();
    try { const d = await call('flow:draft', ID, kind, { choices: choices.map(c => ({ id: c.id, name: c.name })), note: noteIn.value.trim() }); aiMemo.set(kind, d); show(d, true); if (d.pick && onPick) onPick(d.pick); }
    catch (e) { out.replaceChildren(h('div', { class: 'err' }, e.message)); }
    btn.disabled = false; btn.textContent = '再让 AI 给一次';
  };
  if (aiMemo.has(kind)) setTimeout(() => show(aiMemo.get(kind), false), 0);
  return h('section', { class: 'box ai' }, h('h4', {}, title || 'AI 的建议', h('em', {}, '只是建议：不会写进平台')), h('div', { class: 'two' }, noteIn, btn), out);
}
/* 表单字段登记：{ key: { input, ev } }，供 AI 草稿回填和依据显示 */
const reg = (fields, key, input) => { const ev = h('div'); fields[key] = { input, ev }; return ev; };
/* 写平台前的确认：第一次点列出将写入什么，第二次点才发。lines() 返回要列的内容，返回字符串表示有问题、不能提交 */
function confirmBar(label, lines, run, { danger = false } = {}) {
  const slot = h('div'), btn = h('button', { class: danger ? 'danger' : 'pri' }, label);
  btn.onclick = () => {
    const ls = lines(); if (typeof ls === 'string') { slot.replaceChildren(h('div', { class: 'err' }, ls)); return; }
    const go = h('button', { class: 'pri' }, '确认，写入平台'), no = h('button', {}, '取消');
    no.onclick = () => slot.replaceChildren();
    go.onclick = async () => {
      if (busy) return; busy = true; go.disabled = no.disabled = true; go.textContent = '正在写入…';
      try { const text = await run(); flash = { text: text || '已写入平台。' }; step = goNext; goNext = null; aiMemo.clear(); optCache.clear(); await load(!!step); }
      catch (e) { slot.replaceChildren(h('div', { class: 'err' }, e.message)); }
      busy = false;
    };
    slot.replaceChildren(h('div', { class: 'sure' }, h('b', {}, '将写入需求管理平台：'), h('ul', {}, ...ls.map(l => h('li', {}, l))), h('div', { class: 'act' }, go, no)));
  };
  return h('div', {}, h('div', { class: 'act' }, btn), slot);
}
const act = (name, params) => call('flow:act', ID, name, params);
/* 单选列表：已有的（名字相近的排前面）+ 「新建」。返回 { el, value() } */
function chooser(key, items, { newLabel, render, disabled }) {
  const wrap = h('div'), cur = () => pick[key] ?? (items.find(i => !disabled?.(i)) ? String(items.find(i => !disabled?.(i)).id) : 'new');
  const paint = () => wrap.replaceChildren(
    ...items.map(i => { const off = disabled?.(i); return h('label', { class: 'opt' + (cur() === String(i.id) ? ' on' : '') + (off ? ' dis' : ''), title: off || '' }, h('input', { type: 'radio', name: key, checked: cur() === String(i.id), disabled: !!off, onchange: () => { pick[key] = String(i.id); draw(); } }), h('div', { class: 'grow' }, ...render(i)), i.like >= 0.34 ? h('span', { class: 'tag' }, '名字相近') : null); }),
    h('label', { class: 'opt' + (cur() === 'new' ? ' on' : '') }, h('input', { type: 'radio', name: key, checked: cur() === 'new', onchange: () => { pick[key] = 'new'; draw(); } }), h('div', { class: 'grow' }, h('b', {}, newLabel), h('small', {}, '名称由你定；先看上面有没有其实是同一个的'))));
  paint();
  return { el: wrap, value: cur };
}
/* 按需读平台上已有的同类对象（每次进这一步读一次，缓存到下一次刷新） */
const optCache = new Map();
function withOptions(kind, ctx, build) {
  const key = kind + JSON.stringify(ctx) + S.at, slot = h('div');
  const show = list => { try { slot.replaceChildren(...[].concat(build(list)).filter(Boolean)); } catch (e) { slot.replaceChildren(h('div', { class: 'err' }, e.message)); } };
  if (optCache.has(key)) show(optCache.get(key));
  else { slot.replaceChildren(h('div', { class: 'note' }, '正在读平台上已有的…')); call('flow:options', ID, kind, ctx).then(l => { optCache.set(key, l); show(l); }).catch(e => slot.replaceChildren(h('div', { class: 'err' }, e.message))); }
  return slot;
}

/* ---------- 九步 ---------- */
const PANES = {
  raw() {
    const r = S.requirement;
    return [box('原始需求', h('div', { class: 'facts' }, h('label', {}, '编号'), h('div', {}, r.code || '—'), h('label', {}, '标题'), h('div', {}, r.title), h('label', {}, '状态'), h('div', {}, r.statusLabel), h('label', {}, '期望日期'), h('div', {}, r.expected || '未填'),
      h('label', {}, '描述'), h('div', { style: 'white-space:pre-wrap' }, r.description || '（空）'))),
      h('div', { class: 'note' }, `这条需求已经在平台上了。标题、描述、优先级在工作台的详情里改（改完要你确认才推送）。本机挂着 ${S.work.clues} 条线索，后面每一步 AI 给建议时都会用到。`)];
  },
  clarify() {
    const r = S.requirement, t = S.task, out = [];
    if (!t && r.status !== 'clarified') {
      out.push(box('还没送去澄清', h('div', { class: 'note' }, `现在是「${r.statusLabel}」。送去澄清后平台会建一条澄清任务（负责人按平台的规则定），然后在这里填澄清结论。`),
        confirmBar('送去澄清', () => [`把 ${r.code} 的状态从「${r.statusLabel}」推进到「待澄清」`, '平台建立（或沿用）这条需求的澄清任务'], async () => { await act('pushClarify', {}); return '已送去澄清。'; })));
      return out;
    }
    if (!t) return [box('澄清', h('div', { class: 'note' }, '这条需求已经是「已澄清」，平台上没有读到它的澄清任务。'))];
    const fields = {}, L = S.labels.conclusion, c = t.conclusion, ro = !t.editable;
    const rows = Object.keys(L).flatMap(k => { const el = k === 'standard_title' ? inp(c[k], '一句话说清要做什么') : area(c[k], '', k === 'acceptance_criteria' || k === 'main_process' ? 4 : 2); el.disabled = ro; return F(L[k], el, k === 'standard_title' || k === 'acceptance_criteria', reg(fields, k, el)); });
    out.push(box(['澄清任务', h('em', {}, `${t.code || ''} · ${t.statusLabel}`)], h('div', { class: 'note' }, ro ? (t.status === 'approved' ? '审核已通过，结论不能再改。' : `现在是「${t.statusLabel}」，等审批人处理；结论这时不能改。`) : '把需求说清楚：做什么、给谁用、怎么算做完。填好后提交审批，审批通过平台才生成已澄清卡片。', t.reviewNote ? h('div', { class: 'miss' }, '审批人的意见：' + t.reviewNote) : null)));
    if (!ro) out.push(aiBox('conclusion', { title: 'AI 起草澄清结论', fields }));
    out.push(box('澄清结论', h('div', { class: 'f' }, ...rows),
      ro ? null : confirmBar('保存结论', () => { const v = Object.fromEntries(Object.keys(L).map(k => [k, fields[k].input.value.trim()])); if (!v.standard_title || !v.acceptance_criteria) return '标准需求标题和验收口径必须填'; return Object.keys(L).filter(k => v[k]).map(k => `${L[k]}：${v[k].slice(0, 60)}${v[k].length > 60 ? '…' : ''}`); },
        async () => { await act('saveConclusion', { taskId: t.id, fields: Object.fromEntries(Object.keys(L).map(k => [k, fields[k].input.value.trim()])) }); return '结论已保存。'; })));
    if (!ro) out.push(box('提交审批', h('div', { class: 'note' }, t.ready ? '结论已经填好。提交后由产品总监或 CTO 审批，期间不能再改。' : '平台要求标准需求标题和验收口径都保存之后才能提交：先保存结论。'),
      t.ready ? confirmBar('提交审批', () => [`把澄清任务 ${t.code || t.id} 提交审批`, '提交后结论不能再改，直到审批人处理'], async () => { await act('submitReview', { taskId: t.id }); return '已提交审批。'; }) : null));
    if (t.canReview && (t.status === 'pending_review' || t.status === 'pending_cto')) out.push(box('你是审批人', h('div', { class: 'note' }, '审批是你的业务判断，AI 不参与。通过后平台把需求标为已澄清，并生成已澄清卡片，不能撤回。'),
      confirmBar('审批通过', () => [`以你的身份通过澄清任务 ${t.code || t.id}`, '需求变为「已澄清待排期」，生成已澄清卡片', '这一步不能撤回'], async () => { await act('approve', { taskId: t.id }); return '已审批通过。'; }, { danger: true })));
    return out;
  },
  cards() {
    return [box(['已澄清卡片', h('em', {}, String(S.cards.length))], S.cards.length ? h('div', { class: 'list' }, ...S.cards.map(c => h('div', { class: 'r' }, h('span', { class: 'code' }, c.code || ''), h('span', { class: 'ti', title: c.title }, c.title), h('span', { class: 'x' }, c.statusLabel + (c.planName ? ' · ' + c.planName : '')))))
      : h('div', { class: 'note' }, '还没有。澄清审批通过后，平台按拆分出的产品需求自动生成卡片（没拆分就自动生成一张）。')),
      h('div', { class: 'note' }, '进需求计划、排期、做成功能的，都是这些卡片，不是原始需求本身。这一步没有要你做的事。')];
  },
  plan() {
    const free = S.cards.filter(c => !c.planId), out = [];
    if (S.plans.length) out.push(box(['已经在这些需求计划里', h('em', {}, String(S.plans.length))], h('div', { class: 'list' }, ...S.plans.map(p => h('div', { class: 'r' }, h('span', { class: 'code' }, p.code || ''), h('span', { class: 'ti' }, p.name), h('span', { class: 'x' }, fmt(p.start, p.end)))))));
    if (!S.cards.length) return [...out, h('div', { class: 'note' }, '要先有已澄清卡片，才能加入需求计划。')];
    if (!free.length) return [...out, h('div', { class: 'note' }, '所有卡片都已经在需求计划里了。改名称和排期在下一步。')];
    const card = free.find(c => String(c.id) === pick.card) || free[0], fields = {}, name = inp(pick.planName || '', '比如：数据推送对接一期'), sol = sel([['', S.solutions.length ? '请选择方案' : '这个平台产品还没有关联方案'], ...S.solutions.map(s => [s.id, s.name])], pick.solution || (S.solutions.length === 1 ? S.solutions[0].id : ''));
    name.oninput = () => { pick.planName = name.value; }; sol.onchange = () => { pick.solution = sol.value; };
    out.push(box(`${free.length} 张卡片还没进需求计划`, free.length > 1 ? h('div', { class: 'f' }, ...F('处理哪一张', sel(free.map(c => [c.id, `${c.code || ''} ${c.title}`]), card.id, { onchange: e => { pick.card = e.target.value; draw(); } }))) : h('div', { class: 'note' }, `${card.code || ''} ${card.title}`)));
    out.push(withOptions('plans', { like: card.title }, plans => {
      const ch = chooser('plan', plans, { newLabel: '新建一个需求计划', render: p => [h('b', {}, `${p.code || ''} ${p.name}`), h('small', {}, p.linkable ? '' : '没有挂方案：之后关联不到功能')] });
      const isNew = ch.value() === 'new', chosen = plans.find(p => String(p.id) === ch.value());
      return [aiBox('plan', { title: 'AI 建议放进哪个需求计划', choices: plans, fields, onPick: p => { pick.plan = String(p.id); setTimeout(draw, 0); } }),
        box('放进哪个需求计划', ch.el, isNew ? h('div', { class: 'f', style: 'margin-top:12px' }, ...F('名称', name, true, reg(fields, 'name', name)), ...F('方案', sol, false, S.solutions.length ? h('div', { class: 'ev' }, '需求计划要挂在方案下，之后才能关联到功能') : h('div', { class: 'ev none' }, '没读到这个产品关联的方案。可以先建需求计划，但不挂方案的需求计划关联不到功能；关联方案要在平台上由人操作'))) : (fields.name = { input: name, ev: h('div') }, null),
          confirmBar(isNew ? '新建并加入' : '加入这个需求计划', () => isNew ? (name.value.trim() ? [`新建需求计划「${name.value.trim()}」${sol.value ? '，挂在方案「' + S.solutions.find(s => String(s.id) === sol.value)?.name + '」下' : '（不挂方案）'}`, `把卡片 ${card.code || ''} 加入它`] : '需求计划要有名称') : [`把卡片 ${card.code || ''}「${card.title.slice(0, 30)}」加入需求计划 ${chosen.code || ''}「${chosen.name}」`],
            async () => { let pid = chosen?.id; if (isNew) pid = (await act('createPlan', { name: name.value.trim(), solutionId: sol.value || null })).result.id; await act('addToPlan', { cardId: card.id, planId: pid }); delete pick.plan; delete pick.planName; return '已加入需求计划。'; }))];
    }));
    return out;
  },
  schedule() {
    if (!S.plans.length) return [h('div', { class: 'note' }, '还没有需求计划。')];
    return S.plans.map(p => {
      const name = inp(p.name), a = date(p.start), b = date(p.end);
      return box([`${p.code || ''} ${p.name}`, h('em', {}, fmt(p.start, p.end))], p.late ? h('div', { class: 'miss' }, '排期的结束晚于它所在功能的截止日。') : null,
        h('div', { class: 'f' }, ...F('名称', name), ...F('排期', range(a, b), true)),
        confirmBar('保存', () => { const ls = []; if (name.value.trim() && name.value.trim() !== p.name) ls.push(`名称改为「${name.value.trim()}」`); if (a.value !== (p.start || '') || b.value !== (p.end || '')) { if (!a.value || !b.value) return '排期的开始和结束都要填'; if (a.value > b.value) return '开始不能晚于结束'; ls.push(`排期改为 ${a.value} ~ ${b.value}${p.functions.length > 1 ? `（这个需求计划挂在 ${p.functions.length} 个功能下，排期是共用的）` : ''}`); } return ls.length ? ls : '没有改动'; },
          async () => { if (name.value.trim() && name.value.trim() !== p.name) await act('renamePlan', { planId: p.id, name: name.value.trim() }); if (a.value !== (p.start || '') || b.value !== (p.end || '')) await act('schedulePlan', { planId: p.id, start: a.value, end: b.value, revision: p.revision }); return '需求计划已更新。'; }));
    });
  },
  project() {
    const out = [];
    if (S.projects.length) out.push(box(['这条需求做在这些项目里', h('em', {}, String(S.projects.length))], h('div', { class: 'list' }, ...S.projects.map(p => h('div', { class: 'r' }, h('span', { class: 'code' }, p.code || ''), h('span', { class: 'ti' }, p.name), h('span', { class: 'x' }, fmt(p.start, p.end)))))));
    if (S.functions.length) return [...out, h('div', { class: 'note' }, '项目是由功能决定的：功能在哪个项目里，这条需求就做在哪个项目里。要换项目，在平台上把功能改到别的项目。')];
    if (!S.plans.length) return [...out, h('div', { class: 'note' }, '先把需求放进需求计划。')];
    const fields = {}, name = inp(pick.projName || ''), desc = area(pick.projDesc || '', '项目要做什么（可不填）'), a = date(pick.projStart), b = date(pick.projEnd);
    name.oninput = () => { pick.projName = name.value; }; desc.oninput = () => { pick.projDesc = desc.value; }; a.onchange = () => { pick.projStart = a.value; }; b.onchange = () => { pick.projEnd = b.value; };
    const list = S.allProjects, ch = chooser('project', list, { newLabel: '新建一个项目', render: p => [h('b', {}, `${p.code || ''} ${p.name}`), h('small', {}, `${fmt(p.start, p.end)} · ${p.functions} 个功能`)] }), isNew = ch.value() === 'new', chosen = list.find(p => String(p.id) === ch.value());
    out.push(aiBox('project', { title: 'AI 建议做在哪个项目里', choices: list, fields, onPick: p => { pick.project = String(p.id); setTimeout(draw, 0); } }));
    out.push(box('做在哪个项目里', ch.el, isNew ? h('div', { class: 'f', style: 'margin-top:12px' }, ...F('项目名称', name, true, reg(fields, 'name', name)), ...F('说明', desc, false, reg(fields, 'description', desc)), ...F('起止', range(a, b), false, h('div', {}, reg(fields, 'start', a), reg(fields, 'end', b)))) : null,
      isNew ? confirmBar('新建项目', () => { if (!name.value.trim()) return '项目要有名称'; if (!!a.value !== !!b.value) return '起止要么都填，要么都不填'; return [`在这个平台产品下新建项目「${name.value.trim()}」${a.value ? `，${a.value} ~ ${b.value}` : ''}`]; },
        async () => { const r = await act('createProject', { name: name.value.trim(), description: desc.value.trim(), start: a.value, end: b.value }); pick.project = String(r.result.id); delete pick.projName; goNext = 'function'; return `项目已建好${r.result.code ? '（' + r.result.code + '）' : ''}。接着在「功能」这一步定功能。`; })
        : h('div', { class: 'note', style: 'margin-top:10px' }, `选定「${chosen?.name || ''}」不会写平台：在下一步「功能」里新建功能时，功能会建在这个项目下。`)));
    return out;
  },
  function() {
    const out = [];
    if (S.functions.length) out.push(box(['已经关联的功能', h('em', {}, String(S.functions.length))], h('div', { class: 'list' }, ...S.functions.map(f => h('div', { class: 'r' }, h('span', { class: 'kd project' }, f.kind === 'matter' ? '事项' : '功能'), h('span', { class: 'ti' }, f.title), h('span', { class: 'x' }, fmt(f.start, f.end) + (f.via === 'direct' ? ' · 需求直接指定' : '')))))));
    const free = S.plans.filter(p => !p.functions.length);
    if (!S.plans.length) return [...out, h('div', { class: 'note' }, '先把需求放进需求计划。')];
    if (!free.length) return [...out, h('div', { class: 'note' }, '需求计划都已经关联到功能了。功能的目标在下一步改。')];
    const plan = free.find(p => String(p.id) === pick.fnPlan) || free[0], proj = S.allProjects.find(p => String(p.id) === pick.project) || S.projects[0] || null;
    const fields = {}, title = inp(pick.fnTitle || ''), goal = area(pick.fnGoal || '', '做完的标准：能逐条核对的句子', 4), a = date(pick.fnStart || plan.start), b = date(pick.fnEnd || plan.end), kind = sel([['function', '功能（开发工作）'], ['matter', '事项（非开发工作）']], pick.fnKind || 'function'), mc = sel(Object.entries(S.labels.matter), pick.fnMc || 'other');
    title.oninput = () => { pick.fnTitle = title.value; }; goal.oninput = () => { pick.fnGoal = goal.value; }; a.onchange = () => { pick.fnStart = a.value; }; b.onchange = () => { pick.fnEnd = b.value; }; kind.onchange = () => { pick.fnKind = kind.value; draw(); }; mc.onchange = () => { pick.fnMc = mc.value; };
    if (free.length > 1) out.push(box('处理哪个需求计划', h('div', { class: 'f' }, ...F('需求计划', sel(free.map(p => [p.id, `${p.code || ''} ${p.name}`]), plan.id, { onchange: e => { pick.fnPlan = e.target.value; draw(); } })))));
    out.push(withOptions('functions', { planId: plan.id }, fns => {
      const WHY = { other_solution: '属于别的方案，关联不了', function_scope_invalid: '功能的方案已失效，关联不了', already_linked: '已经关联了' };
      const ch = chooser('fn', fns, { newLabel: '新建一个功能', disabled: f => (f.linkable ? '' : WHY[f.why] || '关联不了'), render: f => [h('b', {}, f.name), h('small', {}, `${f.kind === 'matter' ? '事项' : '功能'} · ${fmt(f.start, f.end)}${f.projectId ? ' · ' + (S.allProjects.find(p => Number(p.id) === Number(f.projectId))?.name || '项目 ' + f.projectId) : ''}${f.linkable ? '' : ' · ' + (WHY[f.why] || '关联不了')}`)] });
      const isNew = ch.value() === 'new', chosen = fns.find(f => String(f.id) === ch.value());
      return [!S.solutions.length ? h('section', { class: 'box warn' }, h('div', { class: 'note' }, '没读到这个平台产品关联的方案。平台要求需求计划挂在方案下才能关联到功能：需求计划没挂方案的话，下面的关联会被平台拒绝。给产品关联方案要在平台上由人操作。')) : null,
        aiBox('function', { title: 'AI 建议关联到哪个功能', choices: fns.filter(f => f.linkable), fields, onPick: f => { pick.fn = String(f.id); setTimeout(draw, 0); } }),
        box(`需求计划「${plan.name}」关联到哪个功能`, ch.el, isNew ? h('div', { class: 'f', style: 'margin-top:12px' }, ...F('建在哪个项目', sel([['', '先在上一步「项目」里选定或新建'], ...S.allProjects.map(p => [p.id, `${p.code || ''} ${p.name}`])], proj?.id || '', { onchange: e => { pick.project = e.target.value; draw(); } }), true),
          ...F('功能名称', title, true, reg(fields, 'title', title)), ...F('目标', goal, true, reg(fields, 'goal', goal)), ...F('起止', range(a, b), true, h('div', {}, reg(fields, 'start', a), reg(fields, 'end', b))), ...F('类型', kind), ...(kind.value === 'matter' ? F('事项类别', mc, true) : [])) : null,
          confirmBar(isNew ? '新建功能并关联' : '关联到这个功能', () => { if (!isNew) return [`把需求计划 ${plan.code || ''}「${plan.name}」关联到功能「${chosen.name}」`, plan.start ? '需求计划的排期不变' : '需求计划还没有排期：平台会按功能的起止给它排期']; if (!proj) return '先选定功能建在哪个项目'; if (!title.value.trim() || !goal.value.trim()) return '功能名称和目标都要填'; if (!a.value || !b.value) return '起止都要填'; if (a.value > b.value) return '开始不能晚于结束';
            return [`在项目 ${proj.code || ''}「${proj.name}」下新建${kind.value === 'matter' ? '事项' : '功能'}「${title.value.trim()}」`, `目标：${goal.value.trim().slice(0, 80)}`, `起止 ${a.value} ~ ${b.value}`, `同时把需求计划「${plan.name}」关联到它`]; },
            async () => { if (isNew) await act('createFunction', { projectId: proj.id, title: title.value.trim(), goal: goal.value.trim(), start: a.value, end: b.value, kind: kind.value, matterCategory: mc.value, planId: plan.id, solutionId: S.requirement.solutionId }); else await act('linkFunction', { functionId: chosen.id, planId: plan.id }); for (const k of ['fn', 'fnTitle', 'fnGoal', 'fnStart', 'fnEnd']) delete pick[k]; return isNew ? '功能已建好并关联。' : '已关联到功能。'; }))];
    }));
    return out;
  },
  goal() {
    if (!S.functions.length) return [h('div', { class: 'note' }, '先把需求计划关联到功能。')];
    const out = [h('div', { class: 'note' }, '平台上项目本身没有文字目标：项目的目标写在「项目计划」里（目标、里程碑、计划上线）；功能的目标就是它的验收标准和截止日。')];
    for (const f of S.functions) {
      const title = inp(f.title), goal = area(f.goal, '做完的标准', 4), a = date(f.start), b = date(f.end), ok = f.revision != null;
      out.push(box([`功能的目标 · ${f.title}`, h('em', {}, f.percent != null ? `完成 ${f.percent}%` : '')], ok ? null : h('div', { class: 'miss' }, '这个功能的详情这次没读到，不能改：点「刷新」。'),
        h('div', { class: 'f' }, ...F('功能名称', title, true), ...F('目标', goal, true), ...F('起止', range(a, b), true)),
        ok ? confirmBar('保存功能的目标', () => { const ls = []; if (title.value.trim() !== f.title) ls.push(`名称改为「${title.value.trim()}」`); if (goal.value.trim() !== (f.goal || '')) ls.push(`目标改为：${goal.value.trim().slice(0, 80)}`); if (a.value !== (f.start || '') || b.value !== (f.end || '')) ls.push(`起止改为 ${a.value} ~ ${b.value}`); if (!title.value.trim() || !goal.value.trim() || !a.value || !b.value) return '名称、目标、起止都要填'; return ls.length ? ls : '没有改动'; },
          async () => { await act('updateFunction', { functionId: f.id, productId: f.productId, title: title.value.trim(), goal: goal.value.trim(), start: a.value, end: b.value, revision: f.revision }); return '功能的目标已更新。'; }) : null));
    }
    for (const p of S.projects) {
      const mine = S.projectPlans.filter(x => Number(x.projectId) === Number(p.id)), key = 'pp' + p.id, ch = chooser(key, mine, { newLabel: '新建一个项目计划', render: x => [h('b', {}, x.name), h('small', {}, `计划上线 ${x.target || '未定'}${x.covers ? ' · 已覆盖这条需求' : ''}`)] });
      if (pick[key] == null && mine.find(x => x.covers)) pick[key] = String(mine.find(x => x.covers).id);
      const cur = mine.find(x => String(x.id) === ch.value()) || null, fields = {}, name = inp(cur?.name || ''), g = area(cur?.goal || '', '这个阶段要达到什么'), ms = inp(cur?.milestone || '', '比如：完成联调'), tg = date(cur?.target), a = date(cur?.start), b = date(cur?.end);
      const linked = [...new Set(S.functions.filter(f => Number(f.projectId) === Number(p.id)).flatMap(f => f.planIds))], want = [...new Set([...(cur?.planIds || []), ...S.plans.map(x => Number(x.id)).filter(i => linked.includes(i))])];
      out.push(aiBox('projectPlan', { title: `AI 起草项目计划 · ${p.name}`, choices: mine, fields, onPick: x => { pick[key] = String(x.id); setTimeout(draw, 0); } }));
      out.push(box([`项目的目标 · ${p.code || ''} ${p.name}`, h('em', {}, '项目计划')], ch.el, h('div', { class: 'f', style: 'margin-top:12px' }, ...F('名称', name, true, reg(fields, 'name', name)), ...F('目标', g, false, reg(fields, 'goal', g)), ...F('里程碑', ms, false, reg(fields, 'milestone', ms)), ...F('计划上线', tg, true, reg(fields, 'target', tg)), ...F('起止', range(a, b))),
        h('div', { class: 'note', style: 'margin-top:8px' }, want.length ? `会把这条需求所在的需求计划算进这个项目计划（共 ${want.length} 个需求计划）。` : '这条需求的需求计划还没有关联到这个项目的功能，暂时算不进来。'),
        confirmBar(cur ? '保存项目计划' : '新建项目计划', () => { if (!name.value.trim()) return '项目计划要有名称'; if (!tg.value) return '要填计划上线日期'; if (!!a.value !== !!b.value) return '起止要么都填，要么都不填'; if (cur && cur.revision == null) return '缺少版本号：先刷新';
          return [`${cur ? '修改' : '在项目「' + p.name + '」下新建'}项目计划「${name.value.trim()}」`, `目标：${g.value.trim().slice(0, 80) || '（空）'}；里程碑：${ms.value.trim() || '（空）'}`, `计划上线 ${tg.value}${a.value ? `，起止 ${a.value} ~ ${b.value}` : ''}`, `包含 ${want.length} 个需求计划`]; },
          async () => { await act('saveProjectPlan', { id: cur?.id, projectId: p.id, name: name.value.trim(), goal: g.value.trim(), milestone: ms.value.trim(), target: tg.value, start: a.value, end: b.value, planIds: want, status: cur?.status, revision: cur?.revision }); delete pick[key]; return '项目计划已保存。'; })));
    }
    return out;
  },
  weekly() {
    const pps = S.projectPlans.filter(p => p.covers).length ? S.projectPlans.filter(p => p.covers) : S.projectPlans;
    if (!pps.length) return [h('div', { class: 'note' }, '周总结是按项目计划写的：先在上一步建好项目计划。')];
    const lackWk = p => (p.weekly?.due ?? 1) > (p.weekly?.roles || []).length; // 默认打开本周还没交齐的那一个
    const pp = pps.find(p => String(p.id) === pick.wkPlan) || pps.find(lackWk) || pps[0], proj = S.projects.find(p => Number(p.id) === Number(pp.projectId)), team = proj?.team || {};
    const myRoles = Object.keys(S.labels.roles).filter(r => S.owner && team[r] === S.owner), role = pick.wkRole || myRoles[0] || Object.keys(S.labels.roles).find(r => !(pp.weekly?.roles || []).includes(r)) || 'product', week = pick.wkWeek || S.week;
    return [box('写哪一份', h('div', { class: 'f' }, ...F('项目计划', sel(pps.map(p => [p.id, `${S.projects.find(x => Number(x.id) === Number(p.projectId))?.name || ''} · ${p.name}`]), pp.id, { onchange: e => { pick.wkPlan = e.target.value; draw(); } })),
        ...F('哪一周', h('input', { type: 'date', value: week, onchange: e => { pick.wkWeek = e.target.value; draw(); } }), true, h('div', { class: 'ev' }, '用这一周周一的日期')),
        ...F('角色', sel(Object.entries(S.labels.roles).map(([k, n]) => [k, `${n}${team[k] ? '（' + team[k] + '）' : '（项目上没设）'}`]), role, { onchange: e => { pick.wkRole = e.target.value; draw(); } }), true,
          h('div', { class: 'ev' + (myRoles.includes(role) ? '' : ' none') }, myRoles.includes(role) ? '你是这个角色，可以写' : `平台只允许这个角色在项目上的本人写。${S.owner ? '这条连接的所有者是 ' + S.owner + '，' : ''}看起来不是这个角色，保存多半会被平台拒绝`)))),
      withOptions('weekly', { projectId: pp.id }, list => {
        const old = list.find(w => w.week === week && w.role === role) || null, fields = {}, st = sel(Object.entries(S.labels.week), old?.status || 'normal'), done = area(old?.done || '', '这一周实际做了什么，分条写', 5), next = area(old?.next || '', '下周打算做什么', 3), risk = area(old?.risk || '', '风险、卡点、需要谁支持', 2);
        const prev = list.filter(w => w.role === role && w.week < week)[0];
        return [aiBox('weekly', { title: 'AI 起草周总结', fields }),
          box([old ? '修改这一周的周总结' : '填这一周的周总结', h('em', {}, `${week} 起 · ${S.labels.roles[role]}`)], old && old.author ? h('div', { class: 'miss' }, `这一份已经有人填过了（${old.author}）。保存会改掉它；不是你本人的那一份，平台会拒绝。`) : null, prev ? h('div', { class: 'note' }, `上一份（${prev.week}）的下周计划：${prev.next || '（没写）'}`) : null,
            h('div', { class: 'f', style: 'margin-top:8px' }, ...F('本周状态', st, true, reg(fields, 'status', st)), ...F('本周进展', done, true, reg(fields, 'done', done)), ...F('下周计划', next, false, reg(fields, 'next', next)), ...F('风险', risk, false, reg(fields, 'risk', risk))),
            confirmBar(old ? '保存修改' : '保存周总结', () => { if (!done.value.trim()) return '本周进展不能为空'; if (new Date(week + 'T00:00:00').getDay() !== 1) return '「哪一周」要选周一'; return [`${old ? '修改' : '填写'}项目计划「${pp.name}」${week} 这一周的${S.labels.roles[role]}周总结`, `状态：${S.labels.week[st.value]}`, `进展：${done.value.trim().slice(0, 80)}${done.value.trim().length > 80 ? '…' : ''}`, '以你本人的名义提交']; },
              async () => { await act('saveWeekly', { projectPlanId: pp.id, week, role, status: st.value, done: done.value.trim(), next: next.value.trim(), risk: risk.value.trim(), revision: old?.revision }); return '周总结已保存。'; })),
          list.length ? box(['最近的周总结', h('em', {}, String(list.length))], h('div', { class: 'list' }, ...list.slice(0, 6).map(w => h('div', { class: 'r', title: w.done }, h('span', { class: 'x' }, w.week), h('span', { class: 'tag' }, S.labels.roles[w.role] || w.role), h('span', { class: 'ti' }, w.done), h('span', { class: 'x' }, `${S.labels.week[w.status] || w.status} · ${w.author}`))))) : null];
      })];
  },
};

$('#reload').onclick = () => { optCache.clear(); aiMemo.clear(); flash = null; load(true); };
$('#web').onclick = () => S && ipcRenderer.invoke('work:mp2-open', { kind: 'requirement', id: S.requirement.id, code: S.requirement.code }).catch(() => {});
load();
