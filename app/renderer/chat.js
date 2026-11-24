/* 对话工作台：左边是会话，右边是多轮对话。每个会话可以限定用哪些接入的工具；会改数据的调用在对话里问一次。 */
const { ipcRenderer } = require('electron');
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== false && v !== null) e.setAttribute(k, v === true ? '' : v); } kids.flat().filter(x => x != null && x !== false).forEach(k => e.append(k.nodeType ? k : document.createTextNode(k))); return e; };
const qs = new URLSearchParams(location.search);
for (const k of ['a1', 'a2']) if (/^#[0-9a-f]{6}$/i.test(qs.get(k) || '')) document.documentElement.style.setProperty('--' + k, qs.get(k));
if (process.platform !== 'darwin' || qs.get('embedded')) document.body.classList.add('win'); // 嵌在主窗口里时左边没有红绿灯，不用留空
const call = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (r && r.ok === false) throw new Error(r.error); return r && 'data' in r ? r.data : r; };
const when = t => { const d = new Date(t); if (isNaN(d)) return ''; const today = new Date().toDateString() === d.toDateString(); return d.toLocaleString('zh-CN', today ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };
const secs = ms => ms >= 60000 ? `${Math.floor(ms / 60000)} 分 ${Math.round(ms % 60000 / 1000)} 秒` : `${(ms / 1000).toFixed(1)} 秒`;

let META = { models: [], integrations: [], running: [], exec: { kinds: [], projects: [], modes: {} } }, LIST = [], cur = null;   // cur：当前会话（完整内容）；null = 还没发过第一句的新对话
let draftScope = { integrations: null }, draftTarget = { kind: 'assistant' };   // 新对话的对象：助手，或某个执行项目（本机 Codex / DSH）
const targetOf = () => (cur ? cur.target : draftTarget) || { kind: 'assistant' };
const projectOf = t => t?.kind === 'project' ? META.exec.projects.find(p => p.id === t.id) || { id: t.id, name: '（已取消登记的项目）', gone: true } : null;
const execLabel = k => META.exec.kinds.find(x => x.kind === k)?.label || k;
const live = new Map();   // 会话 id → 正在进行的一轮 { q, steps, confirm }

/* ---------- 回答里的简单排版：标题、列表、代码块、加粗、行内代码。只生成节点，不拼 HTML ---------- */
function inline(text) {
  const out = [], re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g; let i = 0, m;
  // 链接：网页地址可以点开；本机文件路径只显示名字，完整路径放在悬停提示里
  const link = (label, to) => /^https?:\/\//i.test(to) ? h('a', { href: '#', title: to, onclick: e => { e.preventDefault(); ipcRenderer.invoke('svc:open-url', to); } }, label) : h('code', { title: to }, label);
  while ((m = re.exec(text))) { if (m.index > i) out.push(text.slice(i, m.index)); out.push(m[1] != null ? h('b', {}, m[1]) : m[2] != null ? h('code', {}, m[2]) : link(m[3], m[4])); i = re.lastIndex; }
  if (i < text.length) out.push(text.slice(i));
  return out;
}
function rich(text) {
  const box = h('div', {}), parts = String(text || '').split(/```[^\n]*\n?/);
  parts.forEach((part, k) => {
    if (k % 2) { if (part.trim()) box.append(h('pre', {}, part.replace(/\n$/, ''))); return; }
    let list = null, para = [];
    const flush = () => { if (para.length) { const p = h('p', {}); para.forEach((l, i) => { if (i) p.append(h('br')); p.append(...inline(l)); }); box.append(p); para = []; } };
    for (const raw of part.split('\n')) {
      const line = raw.trimEnd(), li = line.match(/^\s*(?:[-*•]|(\d+)[.、)])\s+(.*)$/), hd = line.match(/^#{1,6}\s+(.*)$/);
      if (li) { flush(); const tag = li[1] ? 'ol' : 'ul'; if (!list || list.tagName.toLowerCase() !== tag) { list = h(tag, {}); box.append(list); } list.append(h('li', {}, ...inline(li[2]))); continue; }
      list = null;
      if (hd) { flush(); box.append(h('h4', {}, ...inline(hd[1]))); continue; }
      if (!line.trim()) { flush(); continue; }
      para.push(line);
    }
    flush();
  });
  return box;
}

/* ---------- 一轮 ---------- */
const STEP = { call: '调用', denied: '已拒绝', error: '提示', find: '找工具', say: '说明' };
const integName = id => META.integrations.find(i => i.id === id)?.name || id;
function stepRow(s) {
  const [integ, ...rest] = String(s.tool || '').split('__'), name = rest.length ? rest.join('__') : integ;
  const cls = s.kind === 'call' ? (s.ok ? ' ok' : ' warn') : s.kind === 'denied' || s.kind === 'error' ? ' warn' : '';
  const detail = [s.args && Object.keys(s.args).length ? '参数\n' + JSON.stringify(s.args, null, 1) : '', s.result ? '返回\n' + s.result : ''].filter(Boolean).join('\n\n');
  return h('div', { class: 'step' },
    h('span', { class: 'tag' + cls }, s.kind === 'call' && !s.ok ? '调用失败' : STEP[s.kind] || s.kind),
    name ? h('span', { class: 'nm', title: s.tool }, name) : null,
    rest.length ? h('span', { class: 'tag' }, s.integration || integName(integ)) : null,
    h('span', { class: 'why', title: s.error || s.why || '' }, ...(s.kind === 'say' ? inline(s.why || '') : [s.error || s.why || ''])),
    s.ms ? h('span', { class: 'muted' }, secs(s.ms)) : null,
    detail ? h('details', {}, h('summary', {}, '看参数和返回'), h('pre', { class: 'args' }, detail)) : null);
}
function confirmCard(threadId, c) {
  const reply = ok => { ipcRenderer.invoke('agent:confirm-reply', c.id, ok); const l = live.get(threadId); if (l) l.confirm = null; draw(); };
  return h('div', { class: 'confirm' },
    h('div', {}, '允许这个操作吗？ ', h('b', {}, c.title || c.tool), h('span', { class: 'muted' }, ` · ${c.integration || ''}`)),
    c.why ? h('div', { class: 'muted', style: 'margin-top:4px' }, '助手的理由：' + c.why) : null,
    h('pre', { class: 'args' }, c.args),
    h('div', { class: 'row' }, h('button', { onclick: () => reply(false) }, '拒绝'), h('button', { class: 'pri', onclick: () => reply(true) }, '允许')));
}
function turnNode(t, { pending = false, threadId } = {}) {
  const body = h('div', { class: 'body' });
  if (t.steps?.length) body.append(h('div', { class: 'steps' }, t.steps.map(stepRow)));
  if (pending) { if (t.confirm) body.append(confirmCard(threadId, t.confirm)); else body.append(h('div', { class: 'loading' }, h('i'), h('i'), h('i'))); }
  else {
    body.append(t.a ? h('div', { class: 'ans' + (t.incomplete ? ' bad' : '') }, rich(t.a)) : h('div', { class: 'ans bad' }, '这一轮没有完成：' + (t.error || '未知原因')));
    const n = (t.steps || []).filter(s => s.kind === 'call').length;
    body.append(h('div', { class: 'meta' }, h('span', {}, when(t.at)), t.provider ? h('span', {}, String(t.provider).startsWith('exec:') ? '执行者 ' + execLabel(t.provider.slice(5)) : '模型 ' + (META.models.find(m => m.id === t.provider)?.name || t.provider)) : null, n ? h('span', {}, `调用了 ${n} 次工具`) : null, t.ms ? h('span', {}, '用时 ' + secs(t.ms)) : null));
  }
  return h('div', { class: 'turn' }, h('div', { class: 'u' }, h('div', { class: 'bb' }, t.q)), h('div', { class: 'a' }, h('div', { class: 'orb' }), body));
}

/* ---------- 画面 ---------- */
const EXAMPLES = ['我还有哪些需求跟进的待办？按截止时间排一下', '最近的线索里，有哪些是需要我回复的？', '需求池里还没归到项目的需求有哪些？'];
const EXEC_EXAMPLES = ['看一下 inbox 里的资料，整理成一页要点放到 output', '把上周的待办和进展写成一份周报草稿', '检查 output 里的文档，列出还缺什么'];
function hello() {
  const proj = projectOf(targetOf());
  if (proj) return h('div', { id: 'hello' }, h('div', { class: 'orb' }), h('h3', {}, `交给 ${execLabel(proj.executor)} 去做`),
    h('div', { class: 'muted' }, `说清楚要什么产出，${execLabel(proj.executor) || '执行者'}会在「${proj.name}」的文件夹里做完再告诉你。资料放进 inbox，产出在 output。`),
    proj.gone || proj.missing ? h('div', { class: 'need' }, h('span', {}, proj.gone ? '这个执行项目已经取消登记，不能再派任务。' : '项目文件夹不见了：' + proj.dir)) : null,
    !proj.gone && !META.exec.kinds.find(k => k.kind === proj.executor)?.path ? h('div', { class: 'need' }, h('span', {}, `本机没有找到 ${execLabel(proj.executor)} 命令：先安装并登录。`)) : null,
    h('div', { class: 'eg' }, EXEC_EXAMPLES.map(e => h('button', { onclick: () => { $('#q').value = e; grow(); $('#q').focus(); } }, e))));
  const toolCount = META.integrations.reduce((n, i) => n + (i.tools || 0), 0);
  return h('div', { id: 'hello' }, h('div', { class: 'orb' }), h('h3', {}, '要办什么？'),
    h('div', { class: 'muted' }, '说一件事，助手会用已接入的平台和工具去查、去办；可以接着往下问。'),
    !META.models.length ? h('div', { class: 'need' }, h('span', {}, '还没有可用的模型：先添加一个 API，或选择本机已登录的 Claude Code / Codex。'), h('button', { class: 'pri', onclick: () => ipcRenderer.send('panel:action', 'app.models') }, '去设置')) : null,
    META.models.length && !toolCount && META.integrations.every(i => i.tools != null) ? h('div', { class: 'need' }, h('span', {}, '现在没有可用的工具：到「接入」里启用或添加平台 API、MCP。'), h('button', { onclick: () => ipcRenderer.send('panel:action', 'app.integrations') }, '去接入')) : null,
    h('div', { class: 'eg' }, EXAMPLES.map(e => h('button', { onclick: () => { $('#q').value = e; grow(); $('#q').focus(); } }, e))));
}
function drawThreads() {
  $('#threads').replaceChildren(...(LIST.length ? LIST.map(t => h('div', { class: 'th' + (cur?.id === t.id ? ' on' : ''), onclick: () => open(t.id) },
    h('div', { class: 't', title: t.title }, live.has(t.id) ? h('span', { class: 'run' }) : null, t.title),
    h('div', { class: 'm' }, `${when(t.updatedAt)} · ${t.turns} 轮${t.target?.kind === 'project' ? ' · ' + (projectOf(t.target)?.name || '执行项目') : ''}`),
    h('div', { class: 'ops' }, h('button', { title: '改名', onclick: e => { e.stopPropagation(); rename(t); } }, '改名'), h('button', { title: '删除这个对话', onclick: e => { e.stopPropagation(); removeThread(t); } }, '删除')))) : [h('div', { class: 'muted', style: 'padding:10px 4px' }, '还没有对话。在右边说第一句就开始了。')]));
}
/* 对象：新对话可以选「助手」或某个执行项目；说过第一句之后就固定了 */
function drawTarget() {
  const t = targetOf(), proj = projectOf(t), fixed = !!cur, box = $('#target');
  $('#scope').style.display = proj ? 'none' : '';
  const info = proj && !proj.gone ? [h('span', { class: 'tag' }, execLabel(proj.executor)), h('span', { class: 'tag' + (proj.mode === 'read-only' ? ' warn' : ' ok') }, proj.mode === 'read-only' ? '只读' : '可读写'),
    h('span', { class: 'path', title: proj.dir }, proj.dir), h('span', { class: 'sp' }), h('button', { onclick: () => call('exec:open', proj.id).catch(e => note(e.message, true)) }, '打开文件夹'),
    fixed ? null : h('button', { class: 'ghost', title: '只取消登记，不删除文件夹', onclick: () => removeProject(proj) }, '移除')].filter(Boolean) : [];
  if (fixed) return box.replaceChildren(h('span', { class: 'lb' }, '对象'), h('span', { class: 'tag' }, proj ? `执行项目 · ${proj.name}` : '助手'), ...info);
  const sel = h('select', { onchange: () => { const v = sel.value; if (v === '+') { sel.value = proj ? 'p:' + proj.id : 'a'; return projectDialog(); } draftTarget = v === 'a' ? { kind: 'assistant' } : { kind: 'project', id: v.slice(2) }; draw(); } },
    h('option', { value: 'a' }, '助手 · 用已接入的平台和工具'),
    ...META.exec.projects.map(p => h('option', { value: 'p:' + p.id }, `执行项目 · ${p.name}（${execLabel(p.executor)}）`)),
    h('option', { value: '+' }, '＋ 新建执行项目…'));
  sel.value = proj ? 'p:' + proj.id : 'a';
  box.replaceChildren(h('span', { class: 'lb' }, '对象'), sel, ...info);
}
function projectDialog() {
  const found = META.exec.kinds.filter(k => k.path), msg = h('div');
  const name = h('input', { placeholder: '例如：周报整理', maxlength: 30 }), exe = h('select', {}, META.exec.kinds.map(k => h('option', { value: k.kind, disabled: !k.path }, k.label + (k.path ? '' : '（本机没有找到）'))));
  const mode = h('select', {}, Object.entries(META.exec.modes).map(([k, v]) => h('option', { value: k }, v)));
  let dir = null; const where = h('span', {}, '在 JM Desk 数据目录里新建一个'), pick = h('button', { onclick: async () => { try { const d = await call('exec:pick-dir'); if (d) { dir = d; where.textContent = d; where.title = d; } } catch (e) { msg.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '选已有文件夹');
  if (found.length) exe.value = found[0].kind;
  const box = h('div', { class: 'modal' }, h('div', { class: 'dlg' }, h('h3', {}, '新建执行项目'),
    h('div', { class: 'muted' }, '一个独立的文件夹，交给本机的 Codex 或 DSH 在里面干活；它只在这个文件夹里读写。'),
    h('div', { class: 'f' }, h('label', {}, '名称'), name, h('label', {}, '执行者'), exe, h('label', {}, '权限'), mode, h('label', {}, '文件夹'), h('div', { class: 'pick' }, where, pick)),
    found.length ? null : h('div', { class: 'err' }, '本机没有找到 Codex 或 DSH：先安装并登录其中一个。'), msg,
    h('div', { class: 'acts' }, h('button', { onclick: () => box.remove() }, '取消'), h('button', { class: 'pri', onclick: async () => {
      try { const p = await call('exec:create', { name: name.value, executor: exe.value, mode: mode.value, dir }); box.remove(); await loadMeta(); draftTarget = { kind: 'project', id: p.id }; cur = null; draw(); $('#q').focus(); }
      catch (e) { msg.replaceChildren(h('div', { class: 'err' }, e.message)); }
    } }, '创建'))));
  document.body.append(box); name.focus();
}
function removeProject(p) {
  const box = h('div', { class: 'modal' }, h('div', { class: 'dlg' }, h('h3', {}, '移除这个执行项目？'), h('div', { class: 'muted' }, `「${p.name}」只是从 JM Desk 里取消登记，文件夹和里面的产出都留着。`),
    h('div', { class: 'acts' }, h('button', { onclick: () => box.remove() }, '取消'), h('button', { class: 'danger', onclick: async () => { box.remove(); try { await call('exec:remove', p.id); draftTarget = { kind: 'assistant' }; } catch (e) { note(e.message, true); } await loadMeta(); draw(); } }, '移除'))));
  document.body.append(box);
}
function drawScope() {
  const scope = cur ? cur.scope : draftScope, only = Array.isArray(scope?.integrations) ? new Set(scope.integrations) : null;
  const set = async next => {
    const s = { integrations: next && next.length ? next : null };
    if (cur) { try { await call('chat:scope', cur.id, s); cur.scope = s; } catch (e) { return note(e.message, true); } } else draftScope = s;
    drawScope(); drawSum();
  };
  $('#chips').replaceChildren(
    h('b', { class: only ? '' : 'on', onclick: () => set(null), title: '所有已启用的接入' }, '全部'),
    ...META.integrations.map(i => h('b', { class: only?.has(i.id) ? 'on' : '', title: `${i.kind}${i.tools == null ? ' · 还没连接过' : ''}`,
      onclick: () => { const nx = new Set(only || []); nx.has(i.id) ? nx.delete(i.id) : nx.add(i.id); set([...nx]); } }, i.name, i.tools != null ? h('i', {}, String(i.tools)) : null)));
}
function drawSum() {
  const proj = projectOf(targetOf());
  if (proj) { $('#sum').textContent = proj.gone ? '执行项目已取消登记' : `执行者 ${execLabel(proj.executor)} · 项目「${proj.name}」${META.exec.mcp && proj.executor === 'codex' ? ' · 可以读写 JM Desk 工作区' : ''}`; return; }
  const scope = cur ? cur.scope : draftScope, only = Array.isArray(scope?.integrations) ? new Set(scope.integrations) : null;
  const ints = META.integrations.filter(i => !only || only.has(i.id)), tools = ints.reduce((n, i) => n + (i.tools || 0), 0);
  $('#sum').textContent = META.models.length ? `模型 ${META.models[0].name}${META.models.length > 1 ? ` 等 ${META.models.length} 个` : ''} · ${ints.length} 个接入${tools ? `、${tools} 个工具` : ''}` : '还没有可用的模型';
}
function draw() {
  $('#title').textContent = cur?.title || '新对话';
  const l = cur && live.get(cur.id), nodes = (cur?.turns || []).map(t => turnNode(t));
  if (l) nodes.push(turnNode(l, { pending: true, threadId: cur.id }));
  const box = $('#log'), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  $('#turns').replaceChildren(...(nodes.length ? nodes : [hello()]));
  if (stick || l) box.scrollTop = box.scrollHeight;
  const go = $('#go'); go.textContent = l ? '停止' : '发送'; go.classList.toggle('pri', !l);
  drawThreads(); drawTarget(); drawScope(); drawSum();
  if ($('#note').style.color === '') note('');
  $('#q').placeholder = projectOf(targetOf()) ? '要它做什么？说清楚要什么产出，可以接着上一次往下说' : '要办什么？直接说，可以接着上一句往下问';
}
function note(text, bad) { const n = $('#note'); n.textContent = text || (projectOf(targetOf()) ? '执行者只在项目文件夹里读写' : '改数据前会先问你'); n.style.color = bad ? '#c2410c' : ''; }
function grow() { const q = $('#q'); q.style.height = '24px'; q.style.height = Math.min(168, q.scrollHeight) + 'px'; q.style.overflowY = q.scrollHeight > 168 ? 'auto' : 'hidden'; }

/* ---------- 动作 ---------- */
async function refresh() { LIST = await call('chat:list').catch(() => LIST); drawThreads(); }
async function open(id) {
  try { cur = await call('chat:get', id); } catch (e) { note(e.message, true); cur = null; }
  note(''); draw(); $('#log').scrollTop = $('#log').scrollHeight; $('#q').focus();
}
function fresh() { cur = null; draftScope = { integrations: null }; draftTarget = { kind: 'assistant' }; note(''); draw(); $('#q').focus(); }
async function rename(t) {
  const row = [...document.querySelectorAll('.th')][LIST.indexOf(t)]; if (!row) return;
  const inp = h('input', { value: t.title, maxlength: 40, style: 'width:100%' }), done = async save => {
    if (save && inp.value.trim() && inp.value.trim() !== t.title) { try { const s = await call('chat:rename', t.id, inp.value); if (cur?.id === t.id) cur.title = s.title; } catch (e) { note(e.message, true); } }
    await refresh(); draw();
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) done(true); if (e.key === 'Escape') done(false); });
  inp.addEventListener('blur', () => done(true)); inp.addEventListener('click', e => e.stopPropagation());
  row.querySelector('.t').replaceChildren(inp); inp.focus(); inp.select();
}
function removeThread(t) {
  const box = h('div', { class: 'modal' }, h('div', { class: 'dlg' }, h('h3', {}, '删除这个对话？'), h('div', { class: 'muted' }, `「${t.title}」的 ${t.turns} 轮对话会从本机删除，不能恢复。`),
    h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px' }, h('button', { onclick: () => box.remove() }, '取消'),
      h('button', { class: 'danger', onclick: async () => { box.remove(); try { await call('chat:remove', t.id); } catch (e) { note(e.message, true); } live.delete(t.id); if (cur?.id === t.id) cur = null; await refresh(); draw(); } }, '删除'))));
  document.body.append(box);
}
async function send() {
  if (cur && live.has(cur.id)) { call('chat:stop', cur.id).catch(() => {}); note('正在停止…'); return; }
  const q = $('#q').value.trim(); if (!q) return;
  const proj = projectOf(targetOf());
  if (proj?.gone) return note('这个执行项目已经取消登记，不能再派任务', true);
  if (!proj && !META.models.length) return note('还没有可用的模型：点右上角「模型」添加', true);
  try { if (!cur) { cur = await call('chat:new', { scope: draftScope, target: draftTarget }); } } catch (e) { return note(e.message, true); }
  const id = cur.id; $('#q').value = ''; grow(); note('');
  live.set(id, { q, steps: [], confirm: null }); await refresh(); draw();
  try {
    const r = await call('chat:send', id, q);
    note(r.problems?.length ? '部分接入没连上：' + r.problems.join('；') : '', !!r.problems?.length);
  } catch (e) { note(e.message, true); if (cur?.id === id && !cur.turns.length) $('#q').value = q; }
  live.delete(id);
  if (cur?.id === id) cur = await call('chat:get', id).catch(() => cur);
  await refresh(); draw(); loadMeta();
}
async function loadMeta() { try { META = await call('chat:meta'); } catch {} drawTarget(); drawScope(); drawSum(); if (!cur?.turns?.length && !(cur && live.has(cur.id))) draw(); }

ipcRenderer.on('chat:step', (_e, s) => { const l = live.get(s.threadId); if (!l) return; if (s.kind === 'confirm') return; l.steps.push(s); if (cur?.id === s.threadId) draw(); });
ipcRenderer.on('chat:confirm', (_e, c) => { const l = live.get(c.threadId); if (!l) return ipcRenderer.invoke('agent:confirm-reply', c.id, false); l.confirm = c; if (cur?.id !== c.threadId) open(c.threadId); else draw(); });
ipcRenderer.on('list:focus', (_e, id) => { if (id) open(id); });

$('#q').addEventListener('input', grow);
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); } });
$('#go').addEventListener('click', send);
$('#new').addEventListener('click', fresh);
$('#integ').addEventListener('click', () => ipcRenderer.send('panel:action', 'app.integrations'));
$('#models').addEventListener('click', () => ipcRenderer.send('panel:action', 'app.models'));
window.addEventListener('focus', loadMeta);   // 从设置回来：模型、接入可能变了

(async () => {
  await loadMeta(); await refresh(); const f = qs.get('focus'); if (f) await open(f); else draw(); $('#q').focus();
  // 没连接过的接入在后台连一遍，拿到各自的工具数；连不上的在右下角提示
  call('chat:warm').then(p => { if (p?.length) note('部分接入没连上：' + p.join('；'), true); return loadMeta(); }).catch(() => {});
})();
