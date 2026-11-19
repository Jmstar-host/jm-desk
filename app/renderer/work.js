/* 工作台：按 产品线 › 平台产品 分组，组内按 专项 › 项目 › 需求 › 待办 的上下级展开；右侧可改层级、上级、归属、状态 */
const { ipcRenderer } = require('electron');
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== false && v !== null) e.setAttribute(k, v === true ? '' : v); } kids.flat().filter(x => x != null && x !== false).forEach(k => e.append(k.nodeType ? k : document.createTextNode(k))); return e; };
const qs = new URLSearchParams(location.search);
for (const k of ['a1', 'a2']) if (/^#[0-9a-f]{6}$/i.test(qs.get(k) || '')) document.documentElement.style.setProperty('--' + k, qs.get(k));
if (process.platform !== 'darwin') document.body.classList.add('win');
const call = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (r && r.ok === false) throw new Error(r.error); return r && 'data' in r ? r.data : r; };
const when = t => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };
const STATUS = { open: '进行中', done: '已完成', dropped: '不做了' };
let T = null, f = { level: 'all', status: 'open', q: '' }, current = qs.get('focus') || null;
const say = (text, cls = 'ok') => { $('#msg').replaceChildren(text ? h('div', { class: cls === 'err' ? 'err' : 'ok' }, text) : ''); };

function lvTag(l) { return h('span', { class: 'lv ' + l }, T.levels[l].label); }
function chips() {
  const cnt = T.counts;
  $('#lvchips').replaceChildren(...[['all', '全部层级'], ...Object.entries(T.levels).map(([k, v]) => [k, v.label])].map(([k, n]) =>
    h('b', { class: f.level === k ? 'on' : '', onclick: () => { f.level = k; draw(); } }, n, k !== 'all' && cnt[k] ? h('i', {}, String(cnt[k])) : null)));
  $('#stchips').replaceChildren(...[['open', '进行中'], ['done', '已完成'], ['all', '全部']].map(([k, n]) => h('b', { class: f.status === k ? 'on' : '', onclick: () => { f.status = k; load(); } }, n)));
}
async function load() {
  try { T = await call('work:tree', { status: f.status }); } catch (e) { $('#items').replaceChildren(h('div', { class: 'err' }, e.message)); return; }
  const c = T.counts;
  $('#sum').textContent = `专项 ${c.program} · 项目 ${c.project} · 需求 ${c.requirement} · 待办 ${c.todo}` + (T.taxonomy.products?.length ? ` · 产品树 ${T.taxonomy.products.length} 个产品` : ' · 产品树未同步');
  chips(); draw();
  if (T.needsReview) say(`有 ${T.needsReview} 条旧版待办还没分层，点右上角「AI 整理」让 AI 重新分类`, 'err');
  if (current) show(current);
}
function match(w) { const k = f.q.trim().toLowerCase(); return !k || (w.title + (w.summary || '')).toLowerCase().includes(k); }
function rowOf(w, depth) {
  return h('div', { class: `row ${w.id === current ? 'on' : ''} ${w.status !== 'open' ? 'done' : ''}`, 'data-id': w.id, style: `padding-left:${10 + depth * 18}px`, onclick: () => show(w.id) },
    lvTag(w.level), w.type ? h('span', { class: 'tp ' + w.type }, T.reqTypes[w.type]) : null, h('span', { class: 'ti' }, w.title),
    w.needsReview ? h('span', { class: 'rv' }, '待分层') : null, w.deadline ? h('span', { class: 'dl' }, '⏰ ' + w.deadline.slice(5)) : null);
}
function draw() {
  const box = $('#items'), out = [];
  for (const g of T.groups) {
    const rows = [];
    const walk = (w, d) => {
      const kids = w.children || [];
      if (f.level === 'all') { if (match(w) || kids.some(function any(c) { return match(c) || (c.children || []).some(any); })) { rows.push(rowOf(w, d)); kids.forEach(c => walk(c, d + 1)); } }
      else { if (w.level === f.level && match(w)) rows.push(rowOf(w, 0)); kids.forEach(c => walk(c, d)); }
    };
    g.items.forEach(w => walk(w, 0));
    if (rows.length) out.push(h('div', { class: 'grp' }, g.label, g.suggested ? h('em', {}, 'AI 建议的归属，待确认') : null), ...rows);
  }
  box.replaceChildren(...(out.length ? out : [h('div', { class: 'empty' }, f.status === 'open' ? '还没有进行中的工作。去「汇总」整理一次线索。' : '没有找到')]));
}
function datalist(id, arr) { return h('datalist', { id }, ...arr.map(x => h('option', { value: x }))); }
async function show(id) {
  current = id; document.querySelectorAll('.row').forEach(e => e.classList.toggle('on', e.dataset.id === id));
  let w; try { w = await call('work:item', id); } catch (e) { $('#detail').replaceChildren(h('div', { class: 'empty' }, e.message)); current = null; return; }
  if (current !== id) return;
  const fld = {
    title: h('input', { value: w.title }), summary: h('textarea', {}, w.summary || ''),
    level: h('select', {}, ...Object.entries(T.levels).map(([k, v]) => h('option', { value: k, selected: w.level === k }, `${v.label}（${v.hint}）`))),
    type: h('select', {}, ...Object.entries(T.reqTypes).map(([k, v]) => h('option', { value: k, selected: w.type === k }, v))),
    parentId: h('select', {}, h('option', { value: '' }, '（无上级）'), ...w.parents.map(p => h('option', { value: p.id, selected: w.parentId === p.id }, `${T.levels[p.level].label} · ${p.title}`))),
    line: h('input', { value: w.line || '', list: 'dl-lines', placeholder: '产品线' }), product: h('input', { value: w.product || '', list: 'dl-products', placeholder: '平台产品' }),
    status: h('select', {}, ...Object.entries(STATUS).map(([k, v]) => h('option', { value: k, selected: w.status === k }, v))),
    deadline: h('input', { value: w.deadline || '', placeholder: 'YYYY-MM-DD' }),
    priority: h('select', {}, ...[['high', '高'], ['medium', '中'], ['low', '低']].map(([k, v]) => h('option', { value: k, selected: w.priority === k }, v))),
  };
  const syncType = () => { fld.type.disabled = fld.level.value !== 'requirement'; };
  fld.level.onchange = syncType; syncType();
  const m = h('div');
  const save = async () => {
    const patch = { title: fld.title.value, summary: fld.summary.value, level: fld.level.value, parentId: fld.parentId.value || null, line: fld.line.value || null, product: fld.product.value || null,
      status: fld.status.value, deadline: fld.deadline.value || null, priority: fld.priority.value };
    if (patch.level === 'requirement') patch.type = fld.type.value;
    const tl = (T.taxonomy.lines || []).find(l => l.path === patch.line || l.name === patch.line), tp = (T.taxonomy.products || []).find(p => p.name === patch.product);
    patch.lineId = tl?.id || null; patch.productId = tp?.id || null;
    try { await call('work:edit', id, patch); m.replaceChildren(h('div', { class: 'ok' }, '已保存。改过的字段会锁定，AI 整理时不再改它们。')); await load(); } catch (e) { m.replaceChildren(h('div', { class: 'err' }, e.message)); }
  };
  const lines = (T.taxonomy.lines || []).map(l => l.path), prods = (T.taxonomy.products || []).map(p => p.name);
  $('#detail').replaceChildren(...[
    w.crumbs.length ? h('div', { class: 'crumb' }, ...w.crumbs.flatMap((c, i) => [i ? ' › ' : '', h('b', { onclick: () => show(c.id) }, `${T.levels[c.level].label} · ${c.title}`)])) : null,
    h('h2', {}, w.title),
    h('div', { class: 'm' }, lvTag(w.level), w.type ? h('span', { class: 'tp ' + w.type }, T.reqTypes[w.type]) : null, h('span', {}, STATUS[w.status]), w.who ? h('span', {}, '提出：' + w.who) : null,
      w.anchorSuggested ? h('span', { class: 'rv' }, '归属是 AI 建议的') : null, (w.locked || []).length ? h('span', {}, '人工确认过：' + w.locked.length + ' 项') : null),
    w.deadline_quote ? h('div', { class: 'note' }, `交期依据：「${w.deadline_quote}」${w.deadline_verified ? '' : '（原文里没找到，待确认）'}`) : null,
    h('div', { class: 'f' }, h('label', {}, '标题'), fld.title, h('label', {}, '说明'), fld.summary, h('label', {}, '层级'), fld.level, h('label', {}, '需求类型'), fld.type,
      h('label', {}, '上级'), fld.parentId, h('label', {}, '产品线'), fld.line, h('label', {}, '平台产品'), fld.product,
      h('label', {}, '状态'), fld.status, h('label', {}, '交期'), fld.deadline, h('label', {}, '优先级'), fld.priority),
    datalist('dl-lines', lines), datalist('dl-products', prods),
    h('div', { class: 'act' }, h('button', { class: 'pri', onclick: save }, '保存'), w.level === 'requirement' ? h('button', { title: '需求在需求管理平台评估、排期', onclick: () => ipcRenderer.invoke('mp2:open-pool') }, '在需求管理平台查看') : null), m,
    w.children.length ? h('div', { class: 'sec' }, `下级 ${w.children.length}`) : null,
    ...w.children.map(c => h('div', { class: 'row', onclick: () => show(c.id) }, lvTag(c.level), h('span', { class: 'ti' }, c.title), h('span', { class: 'dl' }, STATUS[c.status]))),
    w.sources.length ? h('div', { class: 'sec' }, `来自 ${w.sources.length} 条线索`) : null,
    ...w.sources.map(s => h('div', { class: 'src', title: '在线索窗口里看原文', onclick: () => ipcRenderer.send('list:open', s.id) }, h('div', {}, `${s.sourceLabel} · ${s.title}`), h('small', {}, s.preview))),
    (w.history || []).length ? h('div', { class: 'sec' }, '变更记录') : null,
    h('div', { class: 'hist' }, ...(w.history || []).slice().reverse().map(x => h('div', {}, `${when(x.at)} · ${x.by === 'ai' ? 'AI' : x.by === 'me' ? '我' : '系统'} · ${(x.fields || []).join('、')}${x.note ? ' · ' + x.note : ''}`)))].filter(Boolean));
}

$('#q').addEventListener('input', e => { f.q = e.target.value; draw(); });
$('#sigs').onclick = () => ipcRenderer.send('list:open', null);
$('#reorg').onclick = async e => {
  const b = e.target; b.disabled = true; b.textContent = 'AI 整理中…'; say('');
  try { const r = await call('work:reorg'); say(`${r.summary || 'AI 整理完成'}${r.log.length ? '：' + r.log.slice(0, 6).join('；') + (r.log.length > 6 ? ` 等 ${r.log.length} 处` : '') : '（没有需要调整的）'}`); await load(); }
  catch (er) { say(er.message, 'err'); }
  b.disabled = false; b.textContent = 'AI 整理';
};
$('#sync').onclick = async e => {
  const b = e.target; b.disabled = true;
  try { const r = await call('work:sync-taxonomy'); say(`已同步产品树：${r.lines} 个产品线 / 类目，${r.products} 个平台产品`); await load(); } catch (er) { say(er.message, 'err'); }
  b.disabled = false;
};
ipcRenderer.on('list:focus', (_e, id) => { if (id) current = id; load(); });
load();
