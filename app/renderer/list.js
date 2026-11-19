/* 线索大窗口：搜索、筛选、看详情、标记不搬运、立即搬运 */
const { ipcRenderer } = require('electron');
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== false && v !== null) e.setAttribute(k, v === true ? '' : v); } kids.flat().filter(x => x != null && x !== false).forEach(k => e.append(k.nodeType ? k : document.createTextNode(k))); return e; };
const qs = new URLSearchParams(location.search);
for (const k of ['a1', 'a2']) if (/^#[0-9a-f]{6}$/i.test(qs.get(k) || '')) document.documentElement.style.setProperty('--' + k, qs.get(k));
if (process.platform !== 'darwin') document.body.classList.add('win');
const call = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (r && r.ok === false) throw new Error(r.error); return r && 'data' in r ? r.data : r; };
const when = t => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };
const ST = [['all', '全部'], ['queued', '待搬运'], ['submitted', '已送达'], ['failed', '失败'], ['ignored', '不搬运']];
const SRCS = [[null, '全部来源'], ['feishu_im', '飞书'], ['mail', '邮件'], ['feishu_meeting', '会议']];
const LV = { program: '专项', project: '项目', requirement: '需求', todo: '待办' };
const derivedText = d => { const n = {}; for (const x of d || []) n[x.level] = (n[x.level] || 0) + 1; return ['requirement', 'todo', 'project'].filter(k => n[k]).map(k => `${LV[k]} ${n[k]}`).join(' · '); };
const STATUS_TEXT = { queued: '待搬运', submitted: '已送达', failed: '失败', ignored: '不搬运' };
let f = { status: 'all', source: null, q: '' }, current = qs.get('focus') || null, items = [];

function chips(box, list, key, counts) {
  box.replaceChildren(...list.map(([v, n]) => {
    const c = key === 'status' ? counts[v === 'all' ? 'all' : v] : v ? counts['src:' + v] : counts.all;
    return h('b', { class: f[key] === v ? 'on' : '', onclick: () => { f[key] = v; load(); } }, n, c ? h('i', {}, String(c)) : null);
  }));
}
async function load() {
  let r; try { r = await call('svc:signals', f); } catch (e) { $('#items').replaceChildren(h('div', { class: 'err' }, e.message)); return; }
  items = r.items;
  chips($('#st'), ST, 'status', r.counts); chips($('#src'), SRCS, 'source', r.counts);
  $('#sum').textContent = `共 ${r.counts.all || 0} 条 · 待搬运 ${r.counts.queued || 0}`;
  $('#items').replaceChildren(...(items.length ? items.map(row) : [h('div', { class: 'empty' }, f.q ? '没有找到' : '这里还没有线索')]));
  if (current && items.some(x => x.id === current)) show(current); else if (!current && items[0]) show(items[0].id);
}
function row(x) {
  return h('div', { class: `it ${x.id === current ? 'on' : ''} ${x.status}`, 'data-id': x.id, onclick: () => show(x.id) },
    h('div', { class: 't' }, h('span', {}, x.title), h('em', { class: 'tag ' + x.status, style: 'font-style:normal' }, STATUS_TEXT[x.status] || x.status)),
    h('div', { class: 'p' }, x.preview),
    h('div', { class: 'm' }, h('span', { class: 'tag' }, `${x.sourceLabel}${x.kind && x.kind !== x.sourceLabel ? ' · ' + x.kind : ''}`), x.people.length ? h('span', {}, x.people.slice(0, 3).join('、') + (x.people.length > 3 ? ' 等' : '')) : null,
      h('span', {}, when(x.at)), x.count > 1 ? h('span', {}, `${x.count} 条消息`) : null, x.derived?.length ? h('span', { class: 'tag drv' }, '→ ' + derivedText(x.derived)) : null));
}
async function show(id) {
  current = id;
  document.querySelectorAll('.it').forEach(e => e.classList.toggle('on', e.dataset.id === id));
  let d; try { d = await call('svc:signal', id); } catch (e) { $('#detail').replaceChildren(h('div', { class: 'err' }, e.message)); return; }
  if (current !== id) return;
  const act = h('div', { class: 'act' });
  if (d.status === 'queued') act.append(h('button', { onclick: () => setIgnore(id, true) }, '不搬运这条'));
  if (d.status === 'ignored') act.append(h('button', { onclick: () => setIgnore(id, false) }, '恢复搬运'));
  if (d.url) act.append(h('button', { onclick: () => ipcRenderer.invoke('svc:open-url', d.url) }, '打开原文'));
  const body = [];
  if (d.messages) {
    for (const m of d.messages) {
      const ph = /^[（(][^）)]{1,8}[）)]$/.test(m.text);
      body.push(h('div', { class: 'msg' }, h('div', { class: 'av' }, (m.who || '?').slice(-2)), h('div', { class: 'bb' + (ph ? ' ph' : '') }, h('small', {}, `${m.who} · ${m.at.slice(5)}`), m.text)));
    }
  } else if (d.mail) {
    if (d.mail.from) body.push(h('div', { class: 'm' }, '发件人：' + d.mail.from));
    body.push(h('div', { class: 'mail' }, d.mail.body || '（正文为空）'));
  } else body.push(h('div', { class: 'mail' }, d.text || ''));
  $('#detail').replaceChildren(h('h2', {}, d.title),
    h('div', { class: 'm' }, h('span', { class: 'tag ' + d.status }, STATUS_TEXT[d.status] || d.status), h('span', { class: 'tag' }, d.sourceLabel + (d.kind && d.kind !== d.sourceLabel ? ' · ' + d.kind : '')),
      h('span', {}, when(d.at)), d.people.length ? h('span', {}, d.people.join('、')) : null),
    act,
    d.derived?.length ? h('div', { class: 'drvbox' }, h('div', { class: 'dh' }, '从这条线索整理出'), ...d.derived.map(w => h('div', { class: 'dw', onclick: () => ipcRenderer.send('work:open', w.id) }, h('span', { class: 'lv ' + w.level }, LV[w.level]), h('span', {}, w.title), w.status !== 'open' ? h('small', {}, w.status === 'done' ? '已完成' : '不做了') : null)))
      : h('div', { class: 'drvbox none' }, '还没从这条线索整理出待办或需求（汇总时 AI 会判断；纯通知、闲聊不会生成工作）'),
    ...body);
  $('#detail').scrollTop = 0;
}
async function setIgnore(id, on) { try { await call('svc:signal-ignore', id, on); await load(); } catch (e) { $('#detail').prepend(h('div', { class: 'err' }, e.message)); } }

let qt = null;
$('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { f.q = e.target.value; load(); }, 200); });
$('#run').onclick = async e => {
  const b = e.target; b.disabled = true; b.textContent = '搬运中…';
  try { const r = await call('svc:collect'); b.textContent = r.submit.skipped ? '已收集（未关联平台）' : `送达 ${r.submit.sent} 条`; await load(); }
  catch (err) { b.textContent = '失败：' + err.message.slice(0, 20); }
  setTimeout(() => { b.disabled = false; b.textContent = '立即搬运'; }, 2500);
};
$('#mp2').onclick = async () => { const ok = await ipcRenderer.invoke('mp2:open-pool'); if (!ok) $('#mp2').textContent = '还没关联需求管理平台'; };
ipcRenderer.on('list:focus', (_e, id) => { if (id) { current = id; f = { status: 'all', source: null, q: '' }; $('#q').value = ''; } load(); });
document.addEventListener('keydown', e => {
  if (!['ArrowDown', 'ArrowUp'].includes(e.key) || document.activeElement === $('#q') || !items.length) return;
  const i = Math.max(0, items.findIndex(x => x.id === current)), n = items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  e.preventDefault(); show(n.id); document.querySelector(`.it[data-id="${n.id}"]`)?.scrollIntoView({ block: 'nearest' });
});
load();
