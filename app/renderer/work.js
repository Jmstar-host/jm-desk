/* 工作台：按 产品线 › 平台产品 分组，组内按 专项 › 项目 › 需求 › 待办 的上下级展开；右侧可改层级、上级、归属、状态 */
const { ipcRenderer } = require('electron');
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== false && v !== null) e.setAttribute(k, v === true ? '' : v); } kids.flat().filter(x => x != null && x !== false).forEach(k => e.append(k.nodeType ? k : document.createTextNode(k))); return e; };
const qs = new URLSearchParams(location.search);
for (const k of ['a1', 'a2']) if (/^#[0-9a-f]{6}$/i.test(qs.get(k) || '')) document.documentElement.style.setProperty('--' + k, qs.get(k));
if (process.platform !== 'darwin' || qs.get('embedded')) document.body.classList.add('win'); // 嵌在主窗口里时左边没有红绿灯，不用留空
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
  const tx = T.taxonomy || {};
  $('#sum').textContent = `专项 ${c.program} · 项目 ${c.project} · 需求 ${c.requirement} · 待办 ${c.todo}` +
    (tx.products?.length ? ` · 产品树 ${tx.products.length} 个产品${tx.projects?.length ? ` / ${tx.projects.length} 个项目` : ''}${tx.syncedAt ? ' · 同步于 ' + when(tx.syncedAt) : ''}` : ' · 产品树未同步');
  chips(); draw();
  if (T.needsReview) say(`有 ${T.needsReview} 条旧版待办还没分层，点右上角「AI 整理」让 AI 重新分类`, 'err');
  if (current) show(current);
}
function match(w) { const k = f.q.trim().toLowerCase(); return !k || (w.title + (w.summary || '')).toLowerCase().includes(k); }
function rowOf(w, depth) {
  return h('div', { class: `row ${w.id === current ? 'on' : ''} ${w.status !== 'open' ? 'done' : ''}`, 'data-id': w.id, style: `padding-left:${10 + depth * 18}px`, onclick: () => show(w.id) },
    w.level === 'todo' ? h('input', { type: 'checkbox', class: 'ck', title: w.status === 'done' ? '重新打开' : '标为完成', checked: w.status === 'done', onclick: e => e.stopPropagation(),
      onchange: async e => { try { await call('svc:task-set', w.id, e.target.checked ? 'done' : 'open'); await load(); } catch (er) { say(er.message, 'err'); } } }) : null,
    lvTag(w.level), w.type ? h('span', { class: 'tp ' + w.type }, T.reqTypes[w.type]) : null, h('span', { class: 'ti' }, w.title),
    w.needsReview ? h('span', { class: 'rv' }, '待分层') : null,
    w.mp2 ? h('span', { class: 'mp', title: '对应需求管理平台的记录' }, `${w.mp2.code || '#' + w.mp2.id}${w.mp2Status?.label ? ' · ' + w.mp2Status.label : ''}`) : null,
    w.mp2Dirty?.length ? h('span', { class: 'rv', title: w.mp2Error || '' }, '待回写') : null,
    !w.mp2 && w.mp2Suggest ? h('span', { class: 'rv', title: w.mp2Suggest.reason || '' }, 'AI 建议归入') : null,
    w.deadline ? h('span', { class: 'dl' }, '⏰ ' + w.deadline.slice(5)) : null);
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
    if (rows.length) out.push(h('div', { class: 'grp' + (g.pending ? ' pend' : '') }, g.label, g.pending ? h('em', {}, '本地记下、还没对应平台：逐条确认归入或新建') : g.suggested ? h('em', {}, 'AI 建议的归属，待确认') : null), ...rows);
  }
  box.replaceChildren(...(out.length ? out : [h('div', { class: 'empty' }, f.status === 'open' ? '还没有进行中的工作。点右上角「汇总新线索」整理一次。' : '没有找到')]));
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
  // D87：对应需求管理平台的记录，层级 / 上级 / 状态 / 产品线以平台为准；项目的平台产品创建后固定
  const onMp2 = !!w.mp2;
  if (onMp2) {
    for (const k of ['level', 'parentId', 'status', 'line']) { fld[k].disabled = true; fld[k].title = '以需求管理平台为准'; }
    if (w.mp2.kind === 'project') { fld.product.disabled = true; fld.product.title = '项目的平台产品在需求管理平台创建后固定'; }
    fld.summary.rows = 8;
  }
  const m = h('div');
  const save = async () => {
    let patch;
    if (onMp2) {
      patch = { title: fld.title.value, summary: fld.summary.value, deadline: fld.deadline.value || null, priority: fld.priority.value };
      if (w.level === 'requirement') {
        patch.type = fld.type.value;
        if (fld.product.value !== (w.product || '')) {
          const tp = (T.taxonomy.products || []).find(p => p.name === fld.product.value);
          if (!tp) { m.replaceChildren(h('div', { class: 'err' }, '平台产品要从产品树里选（输入时会有提示）')); return; }
          const tl = (T.taxonomy.lines || []).find(l => l.id === tp.lineId);
          Object.assign(patch, { product: tp.name, productId: tp.id, line: tl?.path || null, lineId: tl?.id || null });
        }
      }
    } else {
      patch = { title: fld.title.value, summary: fld.summary.value, level: fld.level.value, parentId: fld.parentId.value || null, line: fld.line.value || null, product: fld.product.value || null,
        status: fld.status.value, deadline: fld.deadline.value || null, priority: fld.priority.value };
      if (patch.level === 'requirement') patch.type = fld.type.value;
      const tl = (T.taxonomy.lines || []).find(l => l.path === patch.line || l.name === patch.line), tp = (T.taxonomy.products || []).find(p => p.name === patch.product);
      patch.lineId = tl?.id || null; patch.productId = tp?.id || null;
      if (tp && !tl) { const pl = (T.taxonomy.lines || []).find(l => l.id === tp.lineId); patch.line = pl?.path || patch.line; patch.lineId = pl?.id || null; }
    }
    try {
      const r = await call('work:edit', id, patch), s = r.mp2Sync;
      m.replaceChildren(s?.ok ? h('div', { class: 'ok' }, `已保存，并已回写需求管理平台 ${s.code || ''}`)
        : s && !s.ok ? h('div', { class: 'err' }, `已保存在本机；回写需求管理平台失败：${s.error}。下次保存或拉取时会再试。`)
        : h('div', { class: 'ok' }, onMp2 ? '已保存（没有需要回写平台的改动）。' : '已保存。改过的字段会锁定，AI 整理时不再改它们。'));
      await load();
    } catch (e) { m.replaceChildren(h('div', { class: 'err' }, e.message)); }
  };
  const lines = (T.taxonomy.lines || []).map(l => l.path), prods = (T.taxonomy.products || []).map(p => p.name);
  $('#detail').replaceChildren(...[
    w.crumbs.length ? h('div', { class: 'crumb' }, ...w.crumbs.flatMap((c, i) => [i ? ' › ' : '', h('b', { onclick: () => show(c.id) }, `${T.levels[c.level].label} · ${c.title}`)])) : null,
    h('h2', {}, w.title),
    h('div', { class: 'm' }, lvTag(w.level), w.type ? h('span', { class: 'tp ' + w.type }, T.reqTypes[w.type]) : null, h('span', {}, STATUS[w.status]), w.who ? h('span', {}, '提出：' + w.who) : null,
      w.anchorSuggested ? h('span', { class: 'rv' }, '归属是 AI 建议的') : null, w.mp2 ? h('span', {}, '以需求管理平台为准，保存即回写') : null,
      w.mp2Dirty?.length ? h('span', { class: 'rv', title: w.mp2Error || '' }, '有改动待回写平台') : null, (w.locked || []).length ? h('span', {}, '人工确认过：' + w.locked.length + ' 项') : null),
    w.deadline_quote ? h('div', { class: 'note' }, `交期依据：「${w.deadline_quote}」${w.deadline_verified ? '' : '（原文里没找到，待确认）'}`) : null,
    h('div', { class: 'f' }, h('label', {}, '标题'), fld.title, h('label', {}, '说明'), fld.summary, h('label', {}, '层级'), fld.level, h('label', {}, '需求类型'), fld.type,
      h('label', {}, '上级'), fld.parentId, h('label', {}, '产品线'), fld.line, h('label', {}, '平台产品'), fld.product,
      h('label', {}, '状态'), fld.status, h('label', {}, '交期'), fld.deadline, h('label', {}, '优先级'), fld.priority),
    datalist('dl-lines', lines), datalist('dl-products', prods),
    mp2Box(w),
    h('div', { class: 'act' }, h('button', { class: 'pri', onclick: save }, '保存'), w.level === 'requirement' && !w.mp2 ? h('button', { title: '还没绑定：打开个人需求池', onclick: () => ipcRenderer.invoke('mp2:open-pool') }, '在需求管理平台查看') : null), m,
    w.children.length ? h('div', { class: 'sec' }, `下级 ${w.children.length}`) : null,
    ...w.children.map(c => h('div', { class: 'row', onclick: () => show(c.id) }, lvTag(c.level), h('span', { class: 'ti' }, c.title), h('span', { class: 'dl' }, STATUS[c.status]))),
    w.sources.length ? h('div', { class: 'sec' }, `来自 ${w.sources.length} 条线索`) : null,
    ...w.sources.map(s => h('div', { class: 'src', title: '在线索窗口里看原文', onclick: () => ipcRenderer.send('list:open', s.id) }, h('div', {}, `${s.sourceLabel} · ${s.title}`), h('small', {}, s.preview))),
    (w.history || []).length ? h('div', { class: 'sec' }, '变更记录') : null,
    h('div', { class: 'hist' }, ...(w.history || []).slice().reverse().map(x => h('div', {}, `${when(x.at)} · ${x.by === 'ai' ? 'AI' : x.by === 'me' ? '我' : '系统'} · ${(x.fields || []).join('、')}${x.note ? ' · ' + x.note : ''}`)))].filter(Boolean));
}

/* ---------- D86 / D87：需求管理平台（MP2）绑定、上传与进度。上传会在平台新建原始需求；绑定只改本机工作台 ---------- */
function suggestBox(w, msg, done, fail) {
  const s = w.mp2Suggest; if (!s || w.mp2) return null;
  const what = s.action === 'bind' ? `对应平台上已有的 ${s.code || '#' + s.mp2Id}「${s.title}」` : s.action === 'create' ? `在「${s.product}」下新建到需求管理平台` : `归到平台产品「${s.product}」`;
  return h('div', { class: 'sug' }, h('div', {}, h('b', {}, 'AI 建议：'), what, s.reason ? h('span', { class: 'sub' }, `（${s.reason}）`) : null),
    h('div', { class: 'row2' },
      h('button', { class: 'pri', onclick: async e => { e.target.disabled = true; try { const r = await call('work:mp2-apply', w.id);
        if (r.duplicate) { e.target.disabled = false; msg.replaceChildren(h('div', { class: 'err' }, r.message)); return; }
        await done(s.action === 'bind' ? '已对应到平台记录' : s.action === 'create' ? `已在需求管理平台新建 ${r.code || ''}` : '已归入'); } catch (er) { e.target.disabled = false; fail(er); } } }, '按建议'),
      h('button', { class: 'ghost', onclick: async () => { try { await call('work:mp2-dismiss', w.id); await done('已忽略这条建议，可以在下面手动选'); } catch (er) { fail(er); } } }, '不对，我自己选')));
}
function mp2Box(w) {
  const box = h('div', { class: 'mpbox' }), msg = h('div');
  const fail = e => msg.replaceChildren(h('div', { class: 'err' }, e.message));
  const done = async text => { msg.replaceChildren(h('div', { class: 'ok' }, text)); await load(); };
  if (w.level !== 'project' && w.level !== 'requirement') {
    const sb = suggestBox(w, msg, done, fail); if (!sb) return null;
    box.append(h('div', { class: 'hd' }, h('b', {}, '归入需求管理平台的平台产品')), sb, msg); return box;
  }
  if (w.mp2) {
    const st = w.mp2Status;
    // DOM 的 append 会把 null 当成文字「null」插进去，空的行要先滤掉（h() 自己会滤，这里直接用的是 box.append）
    box.append(...[
      h('div', { class: 'hd' }, h('b', {}, '需求管理平台'), h('span', {}, `${w.mp2.code || '#' + w.mp2.id} · ${w.mp2.title || ''}`),
        st ? h('span', { class: 'st' + (st.found === false ? ' miss' : '') }, st.label) : h('span', { class: 'st miss' }, '还没读取进度')),
      w.mp2.kind === 'project' && st?.start ? h('div', { class: 'sub' }, `项目周期 ${st.start} ~ ${st.end || '未定'}`) : null,
      st?.plans?.length ? h('ul', {}, ...st.plans.map(p => h('li', {}, `需求计划「${p.name || p.code}」：${p.label}${p.start ? `，排期 ${p.start} ~ ${p.end || '未定'}` : '，未排期'}`))) : null,
      w.mp2.kind === 'requirement' && st?.found && !st.plans?.length ? h('div', { class: 'sub' }, '还没进入需求计划') : null,
      st?.functions?.length ? h('div', { class: 'sub' }, '所属功能：' + st.functions.map(f => f.title + (f.via === 'direct' ? '（未进计划）' : '')).join('、')) : null,
      st?.at ? h('div', { class: 'sub' }, '读取于 ' + when(st.at)) : null,
      h('div', { class: 'row2' },
        h('button', { onclick: () => ipcRenderer.invoke('work:mp2-open', w.mp2) }, '在需求管理平台查看'),
        h('button', { onclick: async () => { try { const r = await call('work:mp2-refresh'); await done(`已刷新 ${r.updated} 条`); } catch (e) { fail(e); } } }, '刷新进度'),
        h('button', { class: 'ghost', onclick: async () => { try { await call('work:unbind', w.id); await done('已解除绑定'); } catch (e) { fail(e); } } }, '解除绑定')),
      msg].filter(Boolean));
    return box;
  }
  box.append(h('div', { class: 'hd' }, h('b', {}, '需求管理平台'), h('span', { class: 'st miss' }, '只在本地，待归入')));
  const sb = suggestBox(w, msg, done, fail); if (sb) box.append(sb);
  if (w.level === 'project') {
    // 在 MP2 新建项目：选平台产品（全部平台产品）
    const prods = T.taxonomy.products || [];
    const pick = h('select', { style: 'flex:1;min-width:0' }, h('option', { value: '' }, prods.length ? `建在哪个平台产品下？（${prods.length} 个）` : '先点右上角「从需求管理平台拉取」'),
      ...prods.map(p => h('option', { value: String(p.mp2Id), selected: p.name === w.product }, `${p.name}${p.path ? '　' + p.path : ''}`)));
    const mk = h('button', { class: 'pri', onclick: async () => {
      if (!pick.value) { fail(new Error('先选平台产品')); return; }
      mk.disabled = true;
      try { const r = await call('work:mp2-create-project', w.id, { productId: Number(pick.value) });
        if (r.duplicate) { mk.disabled = false; msg.replaceChildren(h('div', { class: 'err' }, r.message), ...r.candidates.map(c => h('div', { class: 'hit' }, h('span', {}, `${c.code || '#' + c.id} · ${c.name}`),
          h('button', { onclick: async () => { try { await call('work:bind', w.id, { id: c.id }); await done('已对应'); } catch (e) { fail(e); } } }, '对应它')))); return; }
        await done(`已在需求管理平台新建项目 ${r.code || ''}，并已对应`); } catch (e) { mk.disabled = false; fail(e); } } }, '在平台新建项目');
    box.append(h('div', { class: 'row2' }, pick, mk), h('div', { class: 'sub', style: 'margin-top:6px' }, '平台上已经有这个项目？选它对应：'));
    const projects = (T.taxonomy.projects || []), prod = (T.taxonomy.products || []).find(p => p.name === w.product);
    const list = prod ? projects.filter(p => p.productId === prod.id) : projects;
    if (!projects.length) box.append(h('div', { class: 'sub' }, '平台上这个产品下还没有项目。'));
    else {
      const sel = h('select', {}, h('option', { value: '' }, list.length ? `选择 ${prod ? '「' + prod.name + '」下的' : ''}项目（${list.length}）` : '这个平台产品下还没有项目'),
        ...list.map(p => h('option', { value: String(p.mp2Id) }, `${p.code ? p.code + ' · ' : ''}${p.name}`)));
      box.append(h('div', { class: 'row2' }, sel, h('button', { class: 'pri', onclick: async () => { if (!sel.value) return; try { await call('work:bind', w.id, { id: Number(sel.value) }); await done('已绑定，项目的产品线和平台产品已跟需求管理平台一致'); } catch (e) { fail(e); } } }, '绑定')));
    }
  } else {
    /* 上传：先选挂到哪个平台产品（只列关联负责范围内的），再上传 */
    const pick = h('select', { style: 'flex:1;min-width:0' }, h('option', { value: '' }, '读取可选的平台产品…'));
    const hint = h('div', { class: 'sub' });
    const up = h('button', { class: 'pri', disabled: true, onclick: async () => {
      if (!pick.value) { hint.textContent = '先选一个平台产品'; return; }
      up.disabled = true; up.textContent = '上传中…';
      try {
        const r = await call('work:upload', w.id, { productId: Number(pick.value) });
        if (r.duplicate) {
          up.disabled = false; up.textContent = '上传';
          msg.replaceChildren(h('div', { class: 'err' }, r.message), ...r.candidates.map(c => h('div', { class: 'hit' }, h('span', {}, `${c.code || '#' + c.id} · ${c.title}`), c.status ? h('small', { class: 'sub' }, c.status) : null,
            h('button', { onclick: async () => { try { await call('work:bind', w.id, c); await call('work:mp2-refresh').catch(() => null); await done('已绑定'); } catch (e) { fail(e); } } }, '绑定'))));
          return;
        }
        await done(`已上传为 ${r.code || '#' + r.id}${r.product ? `，挂在「${r.product}」下` : ''}，并已绑定`);
      } catch (e) { up.disabled = false; up.textContent = '上传'; fail(e); }
    } }, '上传');
    (async () => {
      try {
        const t = await call('work:mp2-targets');
        if (!t.synced) { pick.replaceChildren(h('option', { value: '' }, '先点右上角「从需求管理平台拉取」')); hint.textContent = '拉取后，这里列出你能上传到的平台产品。'; return; }
        if (!t.products.length) { pick.replaceChildren(h('option', { value: '' }, '没有可上传的平台产品')); hint.textContent = '这个关联的负责范围里没有平台产品：到需求管理平台「AI 接入」调整。'; return; }
        const cur = t.products.find(p => p.name === w.product);
        pick.replaceChildren(h('option', { value: '' }, `挂到哪个平台产品？（${t.products.length} 个可选）`),
          ...t.products.map(p => h('option', { value: String(p.mp2Id), selected: cur && p.mp2Id === cur.mp2Id }, `${p.name}${p.path ? '　' + p.path : ''}`)));
        up.disabled = false;
        hint.textContent = t.scoped ? '只列出这个关联负责范围内的平台产品。上传为原始需求（来源 JM Desk），之后进度自动回到这里。'
          : '上传为原始需求（来源 JM Desk），之后进度自动回到这里。';
      } catch (e) { pick.replaceChildren(h('option', { value: '' }, '读取失败')); fail(e); }
    })();
    box.append(h('div', { class: 'row2' }, pick, up), hint);
    box.append(h('div', { class: 'sub', style: 'margin-top:6px' }, '平台上已经有了？搜索后绑定：'));
    const q = h('input', { value: w.title || '', placeholder: '按编号或标题搜索平台需求', style: 'flex:1;min-width:0' }), hits = h('div');
    const search = async () => { hits.replaceChildren(h('div', { class: 'sub' }, '搜索中…')); try {
      const list = await call('work:mp2-search', q.value);
      hits.replaceChildren(...(list.length ? list.map(r => h('div', { class: 'hit' }, h('span', { title: r.title }, `${r.code || '#' + r.id} · ${r.title}`), r.status ? h('small', { class: 'sub' }, r.status) : null,
        h('button', { onclick: async () => { try { await call('work:bind', w.id, r); await call('work:mp2-refresh').catch(() => null); await done('已绑定'); } catch (e) { fail(e); } } }, '绑定'))) : [h('div', { class: 'sub' }, '没有找到。需求先在需求管理平台录入，或用「收集」送进个人需求池。')]));
    } catch (e) { hits.replaceChildren(); fail(e); } };
    q.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
    box.append(h('div', { class: 'row2' }, q, h('button', { onclick: search }, '搜索')), hits);
  }
  box.append(h('div', { class: 'sub' }, w.level === 'requirement' ? '上传会在需求管理平台新建一条原始需求；绑定只改本机工作台。助手也能做：对它说「把这条需求上传到需求管理平台」。' : '绑定只改本机工作台，不改需求管理平台的数据；助手和本机 AI 也能做同样的绑定。'), msg);
  return box;
}

$('#q').addEventListener('input', e => { f.q = e.target.value; draw(); });
$('#summ').onclick = async e => {
  const b = e.target; b.disabled = true; b.textContent = '汇总中…'; say('');
  try {
    const r = await call('svc:summary-run', 'all'), n = {};
    for (const it of r.items || []) n[it.level || 'todo'] = (n[it.level || 'todo'] || 0) + 1;
    const got = ['program', 'project', 'requirement', 'todo'].filter(k => n[k]).map(k => `${T?.levels?.[k]?.label || k} ${n[k]}`).join('、');
    say(`${r.overview || '汇总完成'}${got ? '：整理出 ' + got : '（没有新的工作）'}${r.fyi?.length ? `；另有 ${r.fyi.length} 条只需知道一下` : ''}`); await load();
  } catch (er) { say(er.message, 'err'); }
  b.disabled = false; b.textContent = '汇总新线索';
};
$('#reorg').onclick = async e => {
  const b = e.target; b.disabled = true; b.textContent = 'AI 整理中…'; say('');
  try { const r = await call('work:reorg'); say(`${r.summary || 'AI 整理完成'}${r.log.length ? '：' + r.log.slice(0, 6).join('；') + (r.log.length > 6 ? ` 等 ${r.log.length} 处` : '') : '（没有需要调整的）'}`); await load(); }
  catch (er) { say(er.message, 'err'); }
  b.disabled = false; b.textContent = 'AI 整理';
};
$('#sync').onclick = async e => {
  const b = e.target; b.disabled = true; b.textContent = '拉取中…'; say('');
  try {
    const r = await call('work:sync-taxonomy');
    const parts = [`${r.products} 个平台产品、${r.projects} 个项目` + (r.requirements != null ? `、${r.requirements} 条需求` : '')];
    if (r.added || r.updated) parts.push(`新增 ${r.added}、更新 ${r.updated}`);
    if (r.pushed) parts.push(`回写了 ${r.pushed} 条本地改动`);
    if (r.pushFailed) parts.push(`${r.pushFailed} 条改动回写失败，仍标「待回写」`);
    if (r.missing) parts.push(`${r.missing} 条在平台上已找不到`);
    if (r.pending) parts.push(`本地还有 ${r.pending} 条待归入${r.suggested ? `，AI 给了 ${r.suggested} 条建议` : ''}`);
    const warn = [r.fallback && `平台暂不支持产品项目计划的树（${r.fallback}），没有项目`, r.reqError && `需求没拉到：${r.reqError}`, r.suggestError && `AI 归入建议没生成：${r.suggestError}`].filter(Boolean);
    say('已从需求管理平台拉取：' + parts.join('；') + (warn.length ? '。' + warn.join('；') : ''), warn.length || r.pushFailed ? 'err' : 'ok');
    await load();
  } catch (er) { say(er.message, 'err'); }
  b.disabled = false; b.textContent = '从需求管理平台拉取';
};
ipcRenderer.on('list:focus', (_e, id) => { if (id) current = id; load(); });
// 打开工作台时顺带刷新一次已绑定工作的 MP2 进度（没关联平台或没有绑定时静默跳过）
load().then(() => call('work:mp2-refresh').then(r => { if (r?.updated) load(); }).catch(() => null));
