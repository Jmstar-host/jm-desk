/* 工作台（1.3.1）：按「先选平台 → 看平台的结构 → 按平台的录入字段填 → 确认后推送（推送前核对版本）」来排。
 * 左：平台 + 我要处理的（待录入 / 待推送 / 我的待办）+ 平台结构（产品线 › 平台产品）；中：所选范围的记录；右：详情。
 * 平台上的记录以平台为准；本机从线索整理出来、还没进平台的在「待录入」。 */
const { ipcRenderer } = require('electron');
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== false && v !== null) e.setAttribute(k, v === true ? '' : v); } kids.flat().filter(x => x != null && x !== false).forEach(k => e.append(k.nodeType ? k : document.createTextNode(k))); return e; };
const qs = new URLSearchParams(location.search);
for (const k of ['a1', 'a2']) if (/^#[0-9a-f]{6}$/i.test(qs.get(k) || '')) document.documentElement.style.setProperty('--' + k, qs.get(k));
if (process.platform !== 'darwin' || qs.get('embedded')) document.body.classList.add('win'); // 嵌在主窗口里时左边没有红绿灯，不用留空
const call = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (r && r.ok === false && 'error' in r && !('item' in r)) throw new Error(r.error); return r && 'data' in r ? r.data : r; };
const when = t => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };
const KIND = { project: '项目', requirement: '需求', todo: '待办', program: '专项' };
const PRI = [['high', '高'], ['medium', '中'], ['low', '低']];
const STATUS = { open: '进行中', done: '已完成', dropped: '不做了' };
const FLD = { created: '新建', title: '标题', summary: '说明', level: '层级', type: '类型', parentId: '上级', line: '产品线', product: '平台产品', lineId: '产品线', productId: '平台产品', status: '状态', deadline: '日期', priority: '优先级', mp2: '平台对应', owner: '负责人' };
let B = null, view = localStorage.getItem('jmWorkView') || 'inbox', current = qs.get('focus') || null, q = '', showAll = false, showDone = false, syncing = false, flash = null, jump = !!current;
const say = (text, cls = 'ok') => { $('#msg').replaceChildren(text ? h('div', { class: cls === 'err' ? 'err' : 'ok' }, text) : ''); };
const isOpen = x => x.status === 'open';
const pathOf = p => { const l = (B.taxonomy.lines || []).find(x => x.id === p.lineId); const v = l?.path || p.path || ''; return Array.isArray(v) ? v.join(' › ') : v; };
/* 负责范围：平台只允许这个关联改范围内的平台产品。B.scope 为空表示读不到范围（不拦，由平台把关） */
const prodMp2 = pid => (B.taxonomy.products || []).find(p => p.id === pid)?.mp2Id ?? null;
const inScope = mp2Id => !B.scope || mp2Id == null || B.scope.includes(Number(mp2Id));
const sets = () => ({
  inbox: B.items.filter(x => isOpen(x) && !x.mp2 && (x.level === 'project' || x.level === 'requirement')),
  push: B.items.filter(x => x.mp2 && x.pending > 0),
  todo: B.items.filter(x => x.level === 'todo' && isOpen(x)),
  program: B.items.filter(x => x.level === 'program' && isOpen(x)),
});
const ofProduct = pid => B.items.filter(x => x.mp2 && (x.productId || '') === pid && (showDone || isOpen(x)));
const setTodo = async (id, done) => { try { await call('svc:task-set', id, done ? 'done' : 'open'); await load(); } catch (e) { say(e.message, 'err'); } };

async function load() {
  try { B = await call('work:board'); } catch (e) { $('#rows').replaceChildren(h('div', { class: 'err' }, e.message)); return; }
  if (jump && current) { // 从别处点进来看某一条：切到它所在的范围
    const x = B.items.find(i => i.id === current); jump = false;
    if (x) view = x.mp2 ? 'p:' + (x.productId || '') : x.level === 'todo' ? 'todo' : x.level === 'program' ? 'program' : 'inbox';
  }
  const S = sets();
  if (view.startsWith('p:') && !ofProduct(view.slice(2)).length && !B.items.some(x => x.mp2 && (x.productId || '') === view.slice(2))) view = 'inbox';
  $('#sum').textContent = `待录入 ${S.inbox.length} · 待推送 ${S.push.length} · 我的待办 ${S.todo.length}`;
  drawNav(); drawList();
  if (current) show(current);
}
function go(key) { view = key; localStorage.setItem('jmWorkView', key); current = null; q = ''; $('#q').value = ''; say(''); drawNav(); drawList(); const first = $('#rows .r'); if (first) show(first.dataset.id); else { $('#dhd').replaceChildren(); $('#detail').replaceChildren(h('div', { class: 'empty' }, '这里现在是空的')); } }

/* ---------- 左：平台、我要处理的、平台结构 ---------- */
const MODE = { contract: '平台按 JM Desk 规范开放接口', adapter: 'JM Desk 按平台现有接口适配' };
let navFilter = '', openLines = JSON.parse(localStorage.getItem('jmWorkLines') || 'null'), platOpen = false;
const ICON = {
  chev: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sync: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};
const svg = (name, cls = 'ic') => { const e = document.createElement('i'); e.className = cls; e.innerHTML = ICON[name]; return e; };
/* 平台切换：列头是当前平台，点开是平台列表（自绘浮层）。切换平台时左边的结构、中间的记录都换成那个平台的 */
function platMenu(anchor) {
  document.querySelector('.platpop')?.remove(); if (platOpen) { platOpen = false; return; } platOpen = true;
  const pop = h('div', { class: 'selpop platpop' },
    ...B.platforms.map(p => h('div', { class: 'pp' + (p.id === B.platform.id ? ' on' : ''), onclick: () => { platOpen = false; pop.remove(); /* 只有一个平台时不用切换；多平台时按 id 切换数据源 */ } },
      h('i', { class: 'dot' + (p.linked ? '' : ' off') }), h('div', { class: 'grow' }, h('b', {}, p.name), h('small', {}, (p.linked ? '已关联' : '未关联') + ' · ' + MODE[p.mode])))),
    h('div', { class: 'pp add', onclick: () => { platOpen = false; pop.remove(); ipcRenderer.send('panel:action', 'app.integrations'); } }, svg('plus'), h('div', { class: 'grow' }, h('b', {}, '接入新平台'), h('small', {}, '先在「设置 › 接入」添加平台的 API；按它生成工作台页面还在做'))));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect(); pop.style.left = r.left + 'px'; pop.style.top = (r.bottom + 4) + 'px'; pop.style.width = Math.max(r.width, 260) + 'px';
  setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!pop.contains(e.target)) { pop.remove(); platOpen = false; document.removeEventListener('mousedown', off, true); } }, true));
}
function drawNav() {
  const S = sets(), P = B.platform, t = B.taxonomy || {};
  const ni = (key, label, tip, n, hot, cls = '') => h('div', { class: 'ni ' + cls + (view === key ? ' on' : ''), title: tip || label, onclick: () => go(key) }, h('span', { class: 'l' }, label), / ro/.test(cls) ? h('span', { class: 'rotag' }, '只读') : null,
    h('span', { class: 'c' + (n ? (hot ? ' hot' : '') : ' zero') }, String(n)));
  /* 列头：平台切换 + 拉取 */
  const pick = h('div', { class: 'platpick grow', title: '切换平台', onclick: e => platMenu(e.currentTarget) }, h('i', { class: 'dot' + (P.linked ? '' : ' off') }), h('b', { class: 'grow' }, P.name), svg('down'));
  $('#navhd').replaceChildren(pick, P.linked
    ? h('button', { class: 'icon' + (syncing ? ' spin' : ''), disabled: syncing, onclick: sync, title: syncing ? '拉取中…' : '拉取最新：读平台现在的产品线 › 平台产品 › 项目 › 需求' }, svg('sync'))
    : h('button', { class: 'sm pri', onclick: () => ipcRenderer.send('panel:action', 'app.connect') }, '去关联'));
  const out = [h('div', { class: 'ln first' }, !P.linked ? '还没有关联：录入和推送都要先关联账号' : P.syncedAt ? '拉取于 ' + when(P.syncedAt) : '还没拉取过平台的结构'),
    h('div', { class: 'nh' }, '我要处理的'),
    ni('inbox', '待录入', '从线索整理出、还没进平台的项目和需求', S.inbox.length, true),
    ni('push', '待推送', '改过、还没推到平台', S.push.length, true),
    ni('todo', '我的待办', '只在本机，不进平台', S.todo.length, false),
    S.program.length ? ni('program', '专项', '只在本机', S.program.length, false) : null];
  /* 平台结构：产品线一组，可以折叠；默认只展开有记录的产品线；可以按名字筛 */
  const has = new Map(); for (const x of B.items) if (x.mp2) { const k = x.productId || ''; has.set(k, (has.get(k) || 0) + (isOpen(x) ? 1 : 0)); }
  const groups = new Map();
  for (const p of t.products || []) { const path = pathOf(p) || '未归产品线'; if (!groups.has(path)) groups.set(path, []); groups.get(path).push(p); }
  if (!openLines) openLines = [...groups].filter(([, ps]) => ps.some(p => has.get(p.id) > 0)).map(([k]) => k);
  const f = navFilter.trim().toLowerCase();
  const tree = h('div', { class: 'tree' });
  for (const [path, ps] of groups) {
    const list = f ? ps.filter(p => (p.name + ' ' + (p.code || '')).toLowerCase().includes(f) || path.toLowerCase().includes(f)) : ps; if (!list.length) continue;
    const open = f || openLines.includes(path), n = list.reduce((a, p) => a + (has.get(p.id) || 0), 0), short = path.split(' › ').at(-1);
    tree.append(h('div', { class: 'tg' + (open ? ' open' : ''), title: path, onclick: () => { openLines = open ? openLines.filter(x => x !== path) : [...openLines, path]; localStorage.setItem('jmWorkLines', JSON.stringify(openLines)); drawNav(); } },
      svg('chev', 'ic chev'), h('span', { class: 'l' }, short), h('span', { class: 'cnt' }, `${list.length}`)));
    if (open) for (const p of list) { const ro = !inScope(p.mp2Id); tree.append(ni('p:' + p.id, p.name, `${p.name}${p.code ? '（' + p.code + '）' : ''}\n${path}${ro ? '\n不在这个关联的负责范围里：只能看，不能录入和修改' : ''}`, has.get(p.id) || 0, false, 'leaf' + (ro ? ' ro' : ''))); }
  }
  if (has.has('')) tree.append(ni('p:', '没挂平台产品的', null, has.get(''), false));
  out.push(h('div', { class: 'nh row' }, h('span', { class: 'grow' }, '平台结构'), (t.products || []).length ? h('span', { class: 'cnt' }, `${(t.products || []).length} 个平台产品`) : null));
  if ((t.products || []).length > 8) {
    const fi = h('input', { class: 'navq', placeholder: '筛选平台产品', value: navFilter });
    fi.addEventListener('input', e => { navFilter = e.target.value; const pos = e.target.selectionStart; drawNav(); const n = $('#nav .navq'); n.focus(); n.setSelectionRange(pos, pos); });
    out.push(fi);
  }
  if (!(t.products || []).length) out.push(h('div', { class: 'ln' }, P.linked ? '点右上角的拉取按钮读平台的结构' : '关联后显示平台的产品线和平台产品'));
  else if (!tree.childNodes.length) out.push(h('div', { class: 'ln' }, '没有匹配的平台产品'));
  out.push(tree);
  const keep = $('#nav').scrollTop; $('#nav').replaceChildren(...out.filter(Boolean)); $('#nav').scrollTop = keep;
}

/* ---------- 中：记录 ---------- */
function row(x, cls = '') {
  return h('div', { class: `r ${cls} ${x.id === current ? 'on' : ''} ${x.status !== 'open' ? 'done' : ''}`, 'data-id': x.id, onclick: () => show(x.id) },
    x.level === 'todo' ? h('input', { type: 'checkbox', class: 'ck', title: x.status === 'done' ? '重新打开' : '标为完成', checked: x.status === 'done', onclick: e => e.stopPropagation(), onchange: e => setTodo(x.id, e.target.checked) }) : null,
    h('span', { class: 'kd ' + x.level }, KIND[x.level]), x.mp2?.code ? h('span', { class: 'code' }, x.mp2.code) : null, h('span', { class: 'ti', title: x.title }, x.title),
    x.pending ? h('span', { class: 'tag warn', title: x.pushError || '' }, x.pushError ? '推送失败' : '待推送') : null,
    x.missing ? h('span', { class: 'tag warn' }, '平台上找不到') : null,
    !x.mp2 && x.suggest === 'bind' ? h('span', { class: 'tag', title: 'AI 认为平台上已经有这条' }, '可能已在平台') : null,
    x.mp2Label ? h('span', { class: 'x' }, x.mp2Label) : null, x.deadline ? h('span', { class: 'x' }, '⏰ ' + String(x.deadline).slice(5, 10)) : null);
}
function drawList() {
  const S = sets(), k = q.trim().toLowerCase(), m = x => !k || (x.title + ' ' + (x.mp2?.code || '')).toLowerCase().includes(k);
  const byDl = (a, b) => String(a.deadline || '9').localeCompare(String(b.deadline || '9'));
  let title = '', desc = '', rows = [], empty = '';
  const nest = (list, heads) => { // 项目带着它下面的需求，剩下的需求单列
    const ids = new Set(list.map(x => x.id)), out = [];
    for (const p of list.filter(x => x.level === 'project' && m(x))) { out.push(row(p)); for (const r of list.filter(x => x.parentId === p.id && m(x))) out.push(row(r, 'sub')); }
    const rest = list.filter(x => x.level !== 'project' && !(x.parentId && ids.has(x.parentId) && list.find(p => p.id === x.parentId)?.level === 'project' && m(list.find(p => p.id === x.parentId))) && m(x));
    if (rest.length) { if (out.length && heads) out.push(h('div', { class: 'gh' }, heads)); out.push(...rest.map(x => row(x))); }
    return out;
  };
  if (view === 'inbox') { title = '待录入'; desc = 'AI 从邮件、飞书、纪要里整理出来的项目和需求，还没进平台。逐条核对：按平台的字段补全后录入，或对应到平台上已有的记录。'; rows = nest(S.inbox, '不在项目里的需求'); empty = '没有待录入的内容。点右上角「汇总新线索」让 AI 整理最近的线索。'; }
  else if (view === 'push') { title = '待推送'; desc = '这些平台记录在本机改过，还没推到平台。点开核对改动，确认后推送。'; rows = S.push.filter(m).map(x => row(x)); empty = '没有待推送的改动。'; }
  else if (view === 'todo') {
    title = '我的待办'; desc = '只在本机，不进平台。挂在某条需求下的是为了推进它，其余是日常。';
    const groups = new Map(); for (const x of S.todo.filter(m).sort(byDl)) { const key = x.parentId || ''; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(x); }
    for (const [pid, list] of [...groups].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1))) { const p = B.items.find(i => i.id === pid); rows.push(h('div', { class: 'gh' }, p ? `为了：${p.mp2?.code ? p.mp2.code + ' ' : ''}${p.title}` : '日常'), ...list.map(x => row(x))); }
    empty = '没有进行中的待办。';
  } else if (view === 'program') { title = '专项'; desc = '跨项目的大事，只在本机。'; rows = S.program.filter(m).map(x => row(x)); }
  else {
    const pid = view.slice(2), p = (B.taxonomy.products || []).find(x => x.id === pid), list = ofProduct(pid);
    title = p ? p.name : '没挂平台产品的'; desc = (p ? pathOf(p) + ' · ' : '') + '平台上的项目和需求，以平台为准。';
    rows = nest(list, '不在项目里的需求');
    const doneN = B.items.filter(x => x.mp2 && (x.productId || '') === pid && !isOpen(x)).length;
    if (doneN) rows.push(h('div', { class: 'more', onclick: () => { showDone = !showDone; drawList(); } }, showDone ? '只看进行中的' : `显示已完成 / 已关闭的 ${doneN} 条`));
    empty = '这个平台产品下还没有项目和需求。';
  }
  $('#mt').textContent = title; $('#mp').textContent = desc; $('#mp').title = desc;
  const n = $('#rows') && rows.filter(r => r.classList?.contains('r')).length; $('#mc').textContent = n ? String(n) : ''; $('#mc').style.display = n ? '' : 'none';
  $('#rows').replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty' }, k ? '没有找到' : empty)]));
}

/* ---------- 右：详情 ---------- */
const F = (label, el, req) => [h('label', {}, label, req ? h('i', {}, '*') : null), el];
const sel = (pairs, cur) => h('select', {}, ...pairs.map(([v, n]) => h('option', { value: v, selected: v === cur }, n)));
const day = v => /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : '';
async function show(id) {
  current = id; document.querySelectorAll('#rows .r').forEach(e => e.classList.toggle('on', e.dataset.id === id));
  let w; try { w = await call('work:item', id); } catch (e) { $('#dhd').replaceChildren(); $('#detail').replaceChildren(h('div', { class: 'empty' }, e.message)); current = null; return; }
  if (current !== id) return;
  const d = w.mp2 ? platformDetail(w) : (w.level === 'project' || w.level === 'requirement') ? intakeDetail(w) : localDetail(w);
  const note = flash && flash.id === id ? h('div', { class: 'flash ' + (flash.cls === 'err' ? 'bad' : 'good') }, flash.text) : null; flash = null;
  /* 列头：位置（面包屑）+ 次要操作；下面一张张卡片 */
  $('#dhd').replaceChildren(h('span', { class: 'crumb grow', title: d.crumb }, d.crumb), ...(d.tools || []).filter(Boolean));
  $('#detail').replaceChildren(h('div', { class: 'dwrap' }, ...[note, ...d.body, ...tail(w)].flat().filter(Boolean)));
  $('#detail').scrollTop = 0;
}
const done = async (id, text, cls) => { flash = { id, text, cls }; await load(); };
const card = (title, ...kids) => h('section', { class: 'box' }, title ? h('h4', {}, ...[].concat(title)) : null, ...kids);
const WHO = { ai: 'AI', me: '我', 'local-ai': '本机 AI', assistant: '助手' };
/* 证据链：线索 → AI 整理 → 字段与依据 → 录入平台 → 平台上的各阶段；点线索条目打开原文 */
const CHAIN_STATE = { done: '已完成', now: '进行中', todo: '未开始', warn: '需要处理', skip: '跳过' };
function chainCard(w) {
  if (!w.chain?.length) return null;
  return card(['证据链', h('em', {}, `${w.chain.filter(s => s.state === 'done').length}/${w.chain.length}`)], h('ol', { class: 'chain' }, ...w.chain.map(st => h('li', { class: 'cs ' + st.state },
    h('i', { class: 'cd', title: CHAIN_STATE[st.state] || '' }), h('div', { class: 'cb' }, h('div', { class: 'ct' }, h('b', {}, st.label), st.at ? h('time', {}, when(st.at)) : null), st.note ? h('div', { class: 'cn' }, st.note) : null,
      ...(st.items || []).map(it => h('div', { class: 'ci' + (it.sid ? ' link' : ''), title: it.sid ? '在「线索」里看原文' : '', onclick: it.sid ? () => ipcRenderer.send('list:open', it.sid) : null }, it.text)))))));
}
function tail(w) {
  return [chainCard(w),
    w.children.length ? card([`下面的工作`, h('em', {}, String(w.children.length))], h('div', { class: 'list' }, ...w.children.map(c => h('div', { class: 'r' + (c.status !== 'open' ? ' done' : ''), onclick: () => { jump = true; current = c.id; load(); } },
      c.level === 'todo' ? h('input', { type: 'checkbox', class: 'ck', checked: c.status === 'done', onclick: e => e.stopPropagation(), onchange: e => setTodo(c.id, e.target.checked) }) : null,
      h('span', { class: 'kd ' + c.level }, KIND[c.level]), h('span', { class: 'ti' }, c.title), h('span', { class: 'x' }, STATUS[c.status]))))) : null,
    w.sources.length ? card(['依据的线索', h('em', {}, String(w.sources.length))], ...w.sources.map(s => h('div', { class: 'src', title: '在「线索」里看原文', onclick: () => ipcRenderer.send('list:open', s.id) }, h('b', {}, `${s.sourceLabel} · ${s.title}`), h('small', {}, s.preview)))) : null,
    (w.history || []).length ? card('变更记录', h('ol', { class: 'tl' }, ...(w.history || []).slice().reverse().slice(0, 12).map(x => h('li', {},
      h('time', {}, when(x.at)), h('span', {}, h('b', {}, WHO[x.by] || '系统'), (x.fields || []).length ? ' 改了 ' + x.fields.map(f => FLD[f] || f).join('、') : '', x.note ? h('small', {}, x.note) : null))))) : null];
}

/* 平台上的记录：按平台的字段展示；保存只存本机，核对改动后再推送 */
function platformDetail(w) {
  const isReq = w.mp2.kind === 'requirement', st = w.mp2Status, P = B.platform, m = h('div'), prods = B.taxonomy.products || [];
  const ro = !inScope(w.mp2.productId ?? prodMp2(w.productId)); // 负责范围外：平台不让改，界面只读
  const fld = { title: h('input', { value: w.title, maxlength: isReq ? 200 : 60 }), deadline: h('input', { type: 'date', value: day(w.deadline) }) };
  if (isReq) Object.assign(fld, { summary: h('textarea', {}, w.summary || ''), priority: sel(PRI, w.priority), type: sel(Object.entries(B.reqTypes), w.type),
    product: h('select', {}, ...prods.map(p => h('option', { value: p.id, selected: p.id === w.productId }, `${p.name}　${pathOf(p)}`))) });
  if (ro) Object.values(fld).forEach(e => { e.disabled = true; e.title = '不在负责范围里，只能看'; });
  const save = async () => {
    const patch = { title: fld.title.value.trim(), deadline: fld.deadline.value || null };
    if (isReq) {
      Object.assign(patch, { summary: fld.summary.value, priority: fld.priority.value, type: fld.type.value });
      if (fld.product.value && fld.product.value !== w.productId) { const tp = prods.find(p => p.id === fld.product.value), tl = (B.taxonomy.lines || []).find(l => l.id === tp.lineId); Object.assign(patch, { product: tp.name, productId: tp.id, line: tl?.path || null, lineId: tl?.id || null }); }
    }
    if (!patch.title) { m.replaceChildren(h('div', { class: 'err' }, '标题不能空')); return; }
    try { const r = await call('work:edit', w.id, patch, { push: false }); await done(w.id, r.pending?.length ? '已存在本机。核对下面的改动，确认后推送到平台。' : '没有改动。'); } catch (e) { m.replaceChildren(h('div', { class: 'err' }, e.message)); }
  };
  /* 待推送：改前 → 改后；推送前主进程会重新读一次平台，别人改过同一个字段时并排给人选 */
  const pend = h('div');
  const drawPend = conflict => {
    if (!w.pending.length) return pend.replaceChildren();
    if (ro) return pend.replaceChildren(h('div', { class: 'box warn' }, h('h4', {}, `本机有 ${w.pending.length} 处改动推不上去`),
      h('table', { class: 'diff' }, ...w.pending.map(p => h('tr', {}, h('td', { class: 'k' }, p.label), h('td', { class: 'o' }, p.from), h('td', {}, p.to)))),
      h('div', { class: 'act' }, h('button', { onclick: async () => { try { await call('work:push', w.id, 'platform'); await done(w.id, '已放弃本机的改动，现在和平台一致。'); } catch (e) { await done(w.id, e.message, 'err'); } } }, '放弃改动'),
        h('span', { class: 'muted' }, '或者把这个平台产品加进负责范围后再推送'))));
    const push = async mode => { pend.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try { const r = await call('work:push', w.id, mode);
        if (r.conflict) return drawPend(r.conflict);
        await done(w.id, r.ok === false ? `没有推送：${r.error}` : r.discarded ? '已放弃本机的改动，现在和平台一致。' : r.nothing ? '没有需要推送的改动。' : `已推送到${P.name} ${r.code || ''}`, r.ok === false ? 'err' : 'ok');
      } catch (e) { await done(w.id, e.message, 'err'); } };
    if (conflict) return pend.replaceChildren(h('div', { class: 'box warn' }, h('h4', {}, '平台上这条记录刚被别人改过'), h('p', {}, '下面这些字段，你和平台上的新内容不一样。选一个：'),
      h('table', { class: 'diff' }, h('tr', {}, h('th', {}, '字段'), h('th', {}, '你改成'), h('th', {}, '平台现在')), ...conflict.map(c => h('tr', {}, h('td', { class: 'k' }, c.label), h('td', {}, c.mine), h('td', {}, c.platform)))),
      h('div', { class: 'act' }, h('button', { class: 'pri', onclick: () => push('mine') }, '用我的覆盖'), h('button', { onclick: () => push('platform') }, '改用平台的'))));
    pend.replaceChildren(h('div', { class: 'box hot' }, h('h4', {}, `${w.pending.length} 处改动还没推到${P.name}`),
      h('table', { class: 'diff' }, ...w.pending.map(p => h('tr', {}, h('td', { class: 'k' }, p.label), h('td', { class: 'o' }, p.from), h('td', {}, p.to)))),
      w.mp2Error && w.mp2Dirty?.length ? h('div', { class: 'err' }, '上次推送失败：' + w.mp2Error) : null,
      h('div', { class: 'act' }, h('button', { class: 'pri', onclick: () => push() }, '确认，推送到平台'), h('button', { onclick: () => push('platform') }, '放弃改动'), h('span', { class: 'muted' }, '推送前会核对平台上是不是最新'))));
  };
  drawPend();
  const parent = w.crumbs.filter(c => c.level === 'project').at(-1);
  return { crumb: `${P.name} › ${[w.line, w.product].filter(Boolean).join(' › ') || '没挂平台产品'}`,
    tools: [h('button', { class: 'sm', onclick: () => ipcRenderer.invoke('work:mp2-open', w.mp2) }, '在平台上查看'),
      h('button', { class: 'sm ghost', title: '只取消本机的对应关系，不改平台', onclick: async () => { try { await call('work:unbind', w.id); await done(w.id, '已解除对应，这条回到「待录入」。'); } catch (e) { m.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '解除对应')],
    body: [
    h('h2', {}, w.title),
    h('div', { class: 'facts' }, h('span', { class: 'kd ' + w.level }, isReq ? '原始需求' : '研发项目'), h('span', { class: 'code' }, w.mp2.code || '#' + w.mp2.id),
      st ? h('span', { class: 'tag' + (st.found === false ? ' warn' : '') }, st.label) : null, h('span', {}, '以平台为准')),
    ro ? h('div', { class: 'box warn' }, h('h4', {}, `「${w.product || '这个平台产品'}」不在你这个关联的负责范围里`),
      h('p', {}, '需求管理平台只允许 AI 关联改负责范围内的记录，所以这条在这里只能看，不能改，也推不上去。'),
      h('p', {}, '要改：到需求管理平台「AI 接入」，给这个连接的负责范围加上这个平台产品，再回来点左上角的拉取按钮。'),
      h('div', { class: 'act' }, h('button', { class: 'pri', onclick: () => ipcRenderer.invoke('mp2:open-revoke') }, '打开「AI 接入」'), h('button', { onclick: () => ipcRenderer.invoke('work:mp2-open', w.mp2) }, '在平台上直接改'))) : null,
    pend,
    card(isReq ? '需求信息' : '项目信息', h('div', { class: 'f' }, ...F(isReq ? '需求标题' : '项目名称', fld.title, true),
      ...(isReq ? [...F('需求描述', fld.summary, true), ...F('平台产品', fld.product, true), ...F('优先级', fld.priority), ...F('需求类型', fld.type), ...F('预期完成时间', fld.deadline)]
        : [...F('平台产品', h('div', { class: 'ro' }, `${w.product || '—'}（创建后固定）`)), ...F('计划结束', fld.deadline)]),
      ...F('状态', h('div', { class: 'ro' }, `${st?.label || STATUS[w.status]}（由平台的流程推进）`)),
      ...(isReq ? F('所属项目', h('div', { class: 'ro' }, parent ? parent.title : '不在项目里（由平台的功能和需求计划决定）')) : [])),
      ro ? null : h('div', { class: 'act in-f' }, h('button', { class: 'pri', onclick: save }, '保存改动'), h('span', { class: 'muted' }, '先存在本机，核对后再推送')), m),
    h('section', { class: 'box' }, h('h4', {}, '平台上的进度'),
      ...[w.mp2.kind === 'project' && st?.start ? h('p', {}, `项目周期 ${st.start} ~ ${st.end || '未定'}`) : null,
        st?.plans?.length ? h('ul', {}, ...st.plans.map(p => h('li', {}, `需求计划「${p.name || p.code}」：${p.label}${p.start ? `，排期 ${p.start} ~ ${p.end || '未定'}` : '，未排期'}`))) : null,
        isReq && st?.found && !st.plans?.length ? h('p', {}, '还没进入需求计划') : null,
        st?.functions?.length ? h('p', {}, '所属功能：' + st.functions.map(f => f.title + (f.via === 'direct' ? '（未进计划）' : '')).join('、')) : null,
        !st ? h('p', {}, '还没读取过') : null].filter(Boolean),
      h('div', { class: 'act' }, h('button', { class: 'sm', onclick: async () => { try { const r = await call('work:mp2-refresh'); await done(w.id, `已刷新 ${r.updated} 条的进度`); } catch (e) { m.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '刷新进度'), st?.at ? h('span', { class: 'muted' }, '读取于 ' + when(st.at)) : null))] };
}

/* 待录入：选好录成什么、挂在哪个平台产品下，按平台的字段补全，确认后录入；或者对应到平台上已有的记录 */
function intakeDetail(w) {
  const isReq = w.level === 'requirement', P = B.platform, s = w.mp2Suggest, m = h('div'), prods = B.taxonomy.products || [];
  const fail = e => m.replaceChildren(h('div', { class: 'err' }, e.message || String(e)));
  const kind = sel([['requirement', '原始需求'], ['project', '研发项目'], ['todo', '只是我的待办（不进平台）']], w.level);
  kind.addEventListener('change', async () => { try { await call('work:edit', w.id, { level: kind.value }, { push: false }); jump = true; await done(w.id, kind.value === 'todo' ? '已改成待办，留在本机。' : '已改。'); } catch (e) { fail(e); } });
  const fld = { title: h('input', { value: w.title, maxlength: isReq ? 200 : 60 }), summary: h('textarea', { placeholder: isReq ? '用一两句话说要做什么也行，点右上角「AI 结合线索和知识补全」，AI 会找依据补成：现状、问题、期望' : '项目要做什么（可不填）' }, w.summary || ''),
    deadline: h('input', { type: 'date', value: day(w.deadline) }), priority: sel(PRI, w.priority || 'medium'), type: sel(Object.entries(B.reqTypes), w.type || 'feature'),
    product: h('select', {}, h('option', { value: '' }, '读取可选的平台产品…')) };
  const hint = h('div', { class: 'muted' });
  /* 字段依据：AI 补全时记下每个字段取自哪条线索的哪句话；人改过的记「人工补充」；录入时一起存下并写进平台的描述 */
  const prov = Object.fromEntries(Object.entries(w.evidence?.fields || {}).map(([k, e]) => [k, { ...e }])), miss = {}, chips = {};
  const chip = k => { const e = prov[k], el = chips[k] || (chips[k] = h('div', { class: 'prov' }));
    el.className = 'prov' + (e ? (e.by === 'me' || e.by === 'draft' ? ' me' : e.verified === false ? ' weak' : ' ai') : miss[k] ? ' miss' : '');
    el.replaceChildren(...(e ? (e.by === 'me' ? [h('b', {}, '人工补充')] : e.by === 'draft' ? [h('b', {}, '按你写的草稿'), h('small', {}, '没找到线索或知识依据，录入前请确认')] : [h('b', {}, e.verified === false ? '依据（原话没核对上）' : '依据'), h('span', { class: 'q', title: e.source || '', onclick: () => e.sid && ipcRenderer.send('list:open', e.sid) }, `「${e.quote || '—'}」`), e.kb ? h('b', { class: 'kb' }, '知识库') : null, e.source ? h('small', {}, e.source) : null])
      : miss[k] ? [h('b', {}, '线索和知识里都没有，需要人工补充'), miss[k] ? h('small', {}, miss[k]) : null] : []));
    return el; };
  const markMe = k => { if (prov[k]?.by === 'me') return; prov[k] = { by: 'me' }; delete miss[k]; chip(k); };
  const want = s?.productMp2Id || prods.find(p => p.name === w.product)?.mp2Id || null;
  const fill = (list, text) => { fld.product.replaceChildren(h('option', { value: '' }, list.length ? `选一个平台产品（${list.length} 个可选）` : '没有可选的平台产品'), ...list.map(p => h('option', { value: String(p.mp2Id), selected: p.mp2Id === want }, `${p.name}${p.path ? '　' + (Array.isArray(p.path) ? p.path.join(' › ') : p.path) : ''}`))); hint.textContent = text; };
  for (const k of ['title', 'summary', 'priority', 'type', 'deadline']) fld[k].addEventListener(k === 'priority' || k === 'type' || k === 'deadline' ? 'change' : 'input', () => markMe(k));
  fld.product.addEventListener('change', () => markMe('product'));
  const FILL = 'AI 结合线索和知识补全';
  const fillBtn = h('button', { class: 'sm ai', title: '先保存你写的标题和描述，再让 AI 到这条的线索、线索池里相关的线索、已接入的知识库里找依据，按平台要填的字段补全，每个字段附上原话出处', onclick: async () => {
    fillBtn.disabled = true; fillBtn.textContent = 'AI 找依据、补全中…';
    try {
      await call('work:edit', w.id, { title: fld.title.value.trim() || w.title, summary: fld.summary.value }, { push: false }); // 用你刚写的内容去找依据
      const r = await call('work:ai-fill', w.id), f = r.fields || {};
      const setSel = (el, v) => { const o = [...el.options].find(o => o.value === v || o.textContent.split('　')[0] === v); if (o) { el.value = o.value; return true; } return false; };
      if (f.title) fld.title.value = f.title.value; if (f.summary) fld.summary.value = f.summary.value; if (f.deadline && /^\d{4}-\d{2}-\d{2}/.test(f.deadline.value)) fld.deadline.value = f.deadline.value.slice(0, 10);
      if (f.priority) setSel(fld.priority, f.priority.value); if (f.type) setSel(fld.type, f.type.value);
      if (f.product && !setSel(fld.product, f.product.value)) delete f.product;
      for (const [k, e] of Object.entries(f)) { prov[k] = e.by === 'draft' ? { by: 'draft' } : { by: 'ai', sid: e.sid, kb: e.kb, quote: e.quote, verified: e.verified, source: e.source }; delete miss[k]; }
      for (const m of r.missing || []) { if (m.field === '*') { fail(new Error(m.ask)); continue; } if (!prov[m.field] || prov[m.field].by !== 'me') { miss[m.field] = m.ask || ''; delete prov[m.field]; } }
      Object.keys(chips).forEach(chip); ['title', 'summary', 'priority', 'type', 'deadline', 'product'].forEach(chip);
      const nS = (r.sources || []).filter(x => x.id).length, nK = (r.sources || []).filter(x => x.kb).length;
      m.replaceChildren(h('div', { class: 'ok' }, `参考了 ${nS} 条线索${r.related ? '（含线索池里相关的）' : ''}、${nK} 条知识库结果；补全了 ${Object.keys(f).length} 项${Object.keys(miss).length ? `，${Object.keys(miss).length} 项没找到依据，需要你补充` : ''}。核对后再录入。`));
    } catch (e) { fail(e); }
    fillBtn.disabled = false; fillBtn.textContent = FILL;
  } }, FILL);
  if (!P.linked) fill([], '');
  else if (!prods.length) fill([], '先点左上角「拉取最新」读平台的结构。');
  else if (!isReq) fill(prods.filter(p => inScope(p.mp2Id)).map(p => ({ mp2Id: p.mp2Id, name: p.name, path: pathOf(p) })), s?.action === 'create' && s.product ? `AI 建议建在「${s.product}」下。` : '');
  else call('work:mp2-targets').then(t => fill(t.products, (t.scoped ? '只列出你这个关联负责范围内的平台产品。' : '') + (s?.action === 'create' && s.product ? (t.products.some(p => p.mp2Id === s.productMp2Id) ? `AI 建议录到「${s.product}」。` : `AI 建议的「${s.product}」不在你的负责范围里，请另选。`) : ''))).catch(fail);
  const dup = (r, bind) => m.replaceChildren(h('div', { class: 'err' }, r.message), ...r.candidates.map(c => h('div', { class: 'hit' }, h('span', {}, `${c.code || '#' + c.id} · ${c.title || c.name}`), h('button', { onclick: () => bind(c) }, '就是它，对应'))));
  const bindTo = async c => { try { await call('work:bind', w.id, isReq ? c : { id: c.id }); await call('work:mp2-refresh').catch(() => null); jump = true; await done(w.id, `已对应到平台上的 ${c.code || '#' + c.id}。`); } catch (e) { fail(e); } };
  const submit = h('button', { class: 'pri', disabled: !P.linked, onclick: async () => {
    const title = fld.title.value.trim(), productId = Number(fld.product.value);
    if (!title) return fail(new Error(isReq ? '需求标题不能空' : '项目名称不能空'));
    if (isReq && !fld.summary.value.trim()) return fail(new Error('需求描述是平台的必填项'));
    if (!productId) return fail(new Error('先选平台产品'));
    submit.disabled = true; submit.textContent = '录入中…';
    try {
      await call('work:edit', w.id, isReq ? { title, summary: fld.summary.value, priority: fld.priority.value, type: fld.type.value, deadline: fld.deadline.value || null } : { title, summary: fld.summary.value, deadline: fld.deadline.value || null }, { push: false });
      const filled = { title: true, summary: !!fld.summary.value.trim(), priority: isReq, type: isReq, deadline: !!fld.deadline.value, product: true };
      await call('work:evidence', w.id, Object.fromEntries(Object.entries(filled).filter(([k, on]) => on).map(([k]) => [k, prov[k] || { by: 'me' }]))); // 录入前把字段依据存下，平台描述里会带上摘录
      const r = isReq ? await call('work:upload', w.id, { productId }) : await call('work:mp2-create-project', w.id, { productId });
      if (r.duplicate) { submit.disabled = false; submit.textContent = `录入到${P.name}`; return dup(r, bindTo); }
      await call('work:mp2-refresh').catch(() => null); jump = true;
      await done(w.id, `已录入${P.name}：${r.code || ''}`);
    } catch (e) { submit.disabled = false; submit.textContent = `录入到${P.name}`; fail(e); }
  } }, `录入到${P.name}`);
  /* 平台上已经有了：搜索（需求）或从所选平台产品的项目里选（项目） */
  const find = h('div');
  const openFind = () => {
    if (isReq) {
      const kw = h('input', { value: w.title, style: 'flex:1;min-width:0' }), hits = h('div');
      const search = async () => { hits.replaceChildren(h('div', { class: 'muted' }, '搜索中…')); try { const r = await call('work:mp2-search', kw.value); hits.replaceChildren(...(r.length ? r.map(c => h('div', { class: 'hit' }, h('span', {}, `${c.code || '#' + c.id} · ${c.title}`), c.status ? h('small', { class: 'muted' }, c.status) : null, h('button', { onclick: () => bindTo(c) }, '对应'))) : [h('div', { class: 'muted' }, '平台上没有找到')])); } catch (e) { hits.replaceChildren(h('div', { class: 'err' }, e.message)); } };
      kw.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) search(); });
      find.replaceChildren(h('div', { class: 'box' }, h('h4', {}, '在平台上找已有的需求'), h('div', { class: 'act' }, kw, h('button', { onclick: search }, '搜索')), hits));
    } else {
      const list = B.taxonomy.projects || [];
      const pick = h('select', { style: 'flex:1;min-width:0' }, h('option', { value: '' }, list.length ? `选平台上的项目（${list.length} 个）` : '平台上还没有项目'), ...list.map(p => h('option', { value: String(p.mp2Id) }, `${p.code ? p.code + ' · ' : ''}${p.name}`)));
      find.replaceChildren(h('div', { class: 'box' }, h('h4', {}, '对应平台上已有的项目'), h('div', { class: 'act' }, pick, h('button', { onclick: () => { const p = list.find(x => String(x.mp2Id) === pick.value); if (p) bindTo({ id: p.mp2Id, code: p.code }); } }, '对应'))));
    }
  };
  return { crumb: `待录入 › ${P.name}`,
    tools: [h('button', { class: 'sm ghost', title: '不录入了，从待录入里拿掉', onclick: async () => { try { await call('work:edit', w.id, { status: 'dropped' }, { push: false }); current = null; await load(); $('#dhd').replaceChildren(); $('#detail').replaceChildren(h('div', { class: 'empty' }, '已标为不做了')); } catch (e) { fail(e); } } }, '不做了')],
    body: [
    h('h2', {}, w.title),
    h('div', { class: 'facts' }, h('span', { class: 'tag warn' }, '还没进平台'), w.who ? h('span', {}, '提出：' + w.who) : null, w.deadline_quote ? h('span', { title: w.deadline_verified ? '' : '原文里没找到这句，待确认' }, `交期原话：「${w.deadline_quote}」`) : null),
    !P.linked ? h('div', { class: 'box warn' }, h('h4', {}, `还没有关联${P.name}`), h('p', {}, '关联账号后才能录入。'), h('div', { class: 'act' }, h('button', { class: 'pri', onclick: () => ipcRenderer.send('panel:action', 'app.connect') }, '去关联'))) : null,
    s?.action === 'bind' ? h('div', { class: 'box hot' }, h('h4', {}, 'AI 认为平台上已经有这条'), h('p', {}, `${s.code || '#' + s.mp2Id}「${s.title}」${s.reason ? '（' + s.reason + '）' : ''}`),
      h('div', { class: 'act' }, h('button', { class: 'pri', onclick: async () => { try { await call('work:mp2-apply', w.id); await call('work:mp2-refresh').catch(() => null); jump = true; await done(w.id, '已对应到平台记录。'); } catch (e) { fail(e); } } }, '就是它，对应'),
        h('button', { onclick: async () => { try { await call('work:mp2-dismiss', w.id); await done(w.id, '好，按新记录来录。'); } catch (e) { fail(e); } } }, '不是，要新录'))) : null,
    card([`录入到${P.name}`, h('span', { class: 'grow' }), fillBtn], h('div', { class: 'f' }, ...F('录成', kind), ...F('平台产品', h('div', { class: 'stack' }, fld.product, hint, chip('product')), true),
      ...F(isReq ? '需求标题' : '项目名称', h('div', { class: 'stack' }, fld.title, chip('title')), true), ...F(isReq ? '需求描述' : '项目说明', h('div', { class: 'stack' }, fld.summary, chip('summary')), isReq),
      ...(isReq ? [...F('优先级', h('div', { class: 'stack' }, fld.priority, chip('priority'))), ...F('需求类型', h('div', { class: 'stack' }, fld.type, chip('type'))), ...F('预期完成时间', h('div', { class: 'stack' }, fld.deadline, chip('deadline')))] : F('计划结束', h('div', { class: 'stack' }, fld.deadline, chip('deadline'))))),
      h('div', { class: 'act in-f' }, submit, h('button', { onclick: openFind }, '平台上已有，去对应')), m),
    find] };
}

/* 只在本机的：待办、专项 */
function localDetail(w) {
  const m = h('div'), isTodo = w.level === 'todo';
  const fld = { title: h('input', { value: w.title, maxlength: 60 }), summary: h('textarea', { style: 'min-height:60px' }, w.summary || ''), deadline: h('input', { type: 'date', value: day(w.deadline) }),
    parentId: h('select', {}, h('option', { value: '' }, isTodo ? '日常（不挂在哪条需求下）' : '（无上级）'), ...w.parents.map(p => h('option', { value: p.id, selected: w.parentId === p.id }, `${KIND[p.level]} · ${p.title}`))),
    status: sel(Object.entries(STATUS), w.status) };
  const save = async () => { try { await call('work:edit', w.id, { title: fld.title.value.trim() || w.title, summary: fld.summary.value, deadline: fld.deadline.value || null, parentId: fld.parentId.value || null, status: fld.status.value }, { push: false }); await done(w.id, '已保存。'); } catch (e) { m.replaceChildren(h('div', { class: 'err' }, e.message)); } };
  return { crumb: w.crumbs.length ? w.crumbs.map(c => `${KIND[c.level]} · ${c.title}`).join(' › ') : isTodo ? '我的待办 › 日常' : '专项',
    tools: [isTodo ? h('button', { class: 'sm', title: '这其实是产品要做的一件事：改成需求，进「待录入」', onclick: async () => { try { await call('work:edit', w.id, { level: 'requirement' }, { push: false }); jump = true; await done(w.id, '已改成需求，在「待录入」里补全后录入平台。'); } catch (e) { m.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '这其实是一条需求') : null],
    body: [
    h('h2', {}, w.title),
    h('div', { class: 'facts' }, h('span', { class: 'kd ' + w.level }, KIND[w.level]), h('span', {}, '只在本机，不进平台'), w.who ? h('span', {}, '来自：' + w.who) : null),
    card(isTodo ? '待办' : '专项', h('div', { class: 'f' }, ...F('标题', fld.title), ...F('备注', fld.summary), ...F('截止', fld.deadline), ...F(isTodo ? '为了哪条' : '上级', fld.parentId), ...F('状态', fld.status)),
      h('div', { class: 'act in-f' }, h('button', { class: 'pri', onclick: save }, '保存')), m)] };
}

/* ---------- 顶部动作 ---------- */
async function sync() {
  if (syncing) return; syncing = true; drawNav(); say('');
  try {
    const r = await call('work:sync-taxonomy');
    const parts = [`${r.products} 个平台产品、${r.projects} 个项目` + (r.requirements != null ? `、${r.requirements} 条需求` : '')];
    if (r.added || r.updated) parts.push(`新增 ${r.added}、更新 ${r.updated}`);
    if (r.pushed) parts.push(`推送了 ${r.pushed} 条本机改动`);
    if (r.pushFailed) parts.push(`${r.pushFailed} 条改动没推成，还在「待推送」`);
    if (r.missing) parts.push(`${r.missing} 条在平台上已找不到`);
    const warn = [r.fallback && `平台暂不支持产品项目计划的树（${r.fallback}），没有项目`, r.reqError && `需求没拉到：${r.reqError}`, r.suggestError && `AI 没能给出录入建议：${r.suggestError}`].filter(Boolean);
    say('已拉取：' + parts.join('；') + (warn.length ? '。' + warn.join('；') : ''), warn.length || r.pushFailed ? 'err' : 'ok');
  } catch (e) { say(e.message, 'err'); }
  syncing = false; await load();
}
$('#q').addEventListener('input', e => { q = e.target.value; drawList(); });
/* 新建需求：在当前所选的平台产品下（选的是负责范围外的产品时不带），建一条待录入，打开后用 AI 结合线索和知识补全 */
$('#newreq').onclick = async () => {
  try {
    const pid = view.startsWith('p:') && view.length > 2 && inScope(prodMp2(view.slice(2))) ? view.slice(2) : null;
    const it = await call('work:new', { level: 'requirement', productId: pid });
    view = 'inbox'; localStorage.setItem('jmWorkView', 'inbox'); current = it.id; jump = false; flash = { id: it.id, text: '写一两句要做什么，再点「AI 结合线索和知识补全」；也可以直接手填。' };
    await load(); setTimeout(() => { const t = document.querySelector('#detail .f input:not([type])'); if (t) { t.focus(); t.select(); } }, 50);
  } catch (e) { say(e.message, 'err'); }
};
$('#summ').onclick = async e => {
  const b = e.target; b.disabled = true; b.textContent = '汇总中…'; say('');
  try {
    const r = await call('svc:summary-run', 'all'), n = {};
    for (const it of r.items || []) n[it.level || 'todo'] = (n[it.level || 'todo'] || 0) + 1;
    const got = ['project', 'requirement', 'todo'].filter(k => n[k]).map(k => `${KIND[k]} ${n[k]}`).join('、');
    say(`${r.overview || '汇总完成'}${got ? '：整理出 ' + got + '，项目和需求在「待录入」' : '（没有新的工作）'}`); await load();
  } catch (er) { say(er.message, 'err'); }
  b.disabled = false; b.textContent = '汇总新线索';
};
$('#reorg').onclick = async e => {
  const b = e.target; b.disabled = true; b.textContent = 'AI 整理中…'; say('');
  try { const r = await call('work:reorg'); say(`${r.summary || 'AI 整理完成'}${r.log.length ? '：' + r.log.slice(0, 6).join('；') + (r.log.length > 6 ? ` 等 ${r.log.length} 处` : '') : '（没有需要调整的）'}`); await load(); }
  catch (er) { say(er.message, 'err'); }
  b.disabled = false; b.textContent = 'AI 整理';
};
ipcRenderer.on('list:focus', (_e, id) => { if (id) { current = id; jump = true; } load(); });
// 打开工作台时顺带刷新一次已对应记录在平台上的进度（没关联或没有对应时静默跳过）
load().then(() => { if (!current) { const first = $('#rows .r'); if (first) show(first.dataset.id); } return call('work:mp2-refresh').then(r => { if (r?.updated) load(); }).catch(() => null); });
