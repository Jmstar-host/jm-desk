/* JM Desk 应用面板：设置（形象 / 气泡 / 模型）和各个应用页。 */
const { ipcRenderer } = require('electron');
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v); } kids.flat().filter(x => x != null).forEach(k => e.append(k.nodeType ? k : document.createTextNode(k))); return e; };
let S = null, page = location.hash.slice(1) || 'app.settings', tab = null;
const PAGES = {
  'app.settings': { title: '设置', tabs: [['character', '形象'], ['layout', '气泡'], ['account', '需求管理平台'], ['integrations', '接入'], ['model', '模型'], ['about', '关于']] },
};
/* 打开 / 收起：主进程先发 panel:go（带页面、精灵在哪一侧、主色），面板换好内容、摆好起始姿态后回 panel:ready，主进程再显示，
 * 这样不会先闪一下上一页的内容；显示后泡泡从精灵那一侧弹出来。 */
const body0 = document.body;
function closeAnimated() { body0.classList.add('enter'); setTimeout(() => ipcRenderer.send('panel:close'), 170); }
$('#x').onclick = closeAnimated;
function applyGo(g) {
  if (typeof g === 'string') g = { page: g };
  body0.classList.add('enter');
  body0.classList.toggle('right', g.side === 'right');
  if (g.ty != null) document.documentElement.style.setProperty('--ty', g.ty + 'px');
  if (g.theme) { document.documentElement.style.setProperty('--a1', g.theme[0]); document.documentElement.style.setProperty('--a2', g.theme[1]); }
  $('#sub').textContent = g.sub || ''; delete $('#sub').dataset.base;
  ipcRenderer.invoke('panel:pin-state').then(showPinned);
  if (g.page && g.page !== page) { page = g.page; tab = null; $('#body').replaceChildren(h('div', { class: 'loading' }, h('i'), h('i'), h('i'))); $('#tabs').replaceChildren(); }
  if (g.tab && PAGES[page]?.tabs.some(([id]) => id === g.tab)) tab = g.tab; // 直接打开设置里的某一页（接入、模型、需求管理平台、形象）
  setTimeout(() => { ipcRenderer.send('panel:ready'); setTimeout(() => body0.classList.remove('enter'), 30); }, 16);
  render();
}
ipcRenderer.on('panel:go', (_e, g) => applyGo(g));
ipcRenderer.on('panel:hiding', () => body0.classList.add('enter'));
/* 钉住：点别处不收起，换页面时也留在原位（可拖动标题栏挪到顺手的地方）；收起时自动取消钉住 */
const pinBtn = $('#pin');
function showPinned(on) { pinBtn.classList.toggle('pri', on); pinBtn.title = on ? '已钉住：点别处不会收起（再点取消）' : '钉住（点别处时不收起）'; document.body.classList.toggle('pinned', on); }
pinBtn.onclick = async () => {
  const on = await ipcRenderer.invoke('panel:pin', !pinBtn.classList.contains('pri')); showPinned(on);
  // 明显的反馈：副标题临时提示一下，按钮轻轻弹一下
  const sub = $('#sub'), old = sub.dataset.base ?? sub.textContent; sub.dataset.base = old; sub.textContent = on ? '已钉住 · 点别处不会收起' : '已取消钉住';
  pinBtn.classList.remove('bump'); void pinBtn.offsetWidth; pinBtn.classList.add('bump');
  clearTimeout(pinBtn.__t); pinBtn.__t = setTimeout(() => { sub.textContent = sub.dataset.base; delete sub.dataset.base; }, 1800);
};
ipcRenderer.on('panel:pinned', (_e, on) => showPinned(!!on));
ipcRenderer.on('mp2:link', () => { if (tab === 'account') render(); });
/* 多行输入框随内容变高（最多 240px），长问题不用在小框里滚动 */
document.addEventListener('input', e => { const t = e.target; if (t.tagName !== 'TEXTAREA') return; t.style.height = 'auto'; t.style.height = Math.min(240, t.scrollHeight + 2) + 'px'; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAnimated(); });

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  S = await ipcRenderer.invoke('panel:state');
  if (seq !== renderSeq) return; // 已经切到别的页面
  const def = PAGES[page], live = $('#body');
  // 先在看不见的容器里排好，再一次换上去：等数据时一直显示加载动画，不会出现空白或上一页的残影
  const body = h('div');
  const done = () => { if (seq !== renderSeq) return; live.replaceChildren(...body.childNodes); };
  $('#tabs').replaceChildren();
  if (!def) {
    const app = APPS[page];
    if (app) { $('#title').textContent = app[0]; try { await app[1](body); } catch (e) { body.append(h('div', { class: 'err' }, e.message)); } return done(); }
    const a = S.catalog[page] || { label: page }; $('#title').textContent = a.label; body.append(h('div', { class: 'card todo' }, h('h3', {}, a.label), h('div', { class: 'muted' }, '这个功能还没有面板。'))); return done();
  }
  $('#title').textContent = def.title; tab = tab || def.tabs[0][0];
  if (def.tabs.length > 1) def.tabs.forEach(([id, n]) => $('#tabs').append(h('b', { class: id === tab ? 'on' : '', onclick: () => { tab = id; render(); } }, n)));
  await ({ character: tabCharacter, layout: tabLayout, account: tabAccount, integrations: tabIntegrations, model: tabModel, about: tabAbout })[tab](body);
  done();
}

/* ---------- 形象 ---------- */
const COLOR_LABELS = { body: '身体', body2: '渐变', belly: '肚皮', cheek: '腮红', eye: '眼睛', star: '星星灯' };
const DEF = { body: '#b9a6ff', body2: '#8fd8ff', belly: '#fff6fb', cheek: '#ff9ccf', eye: '#2a1f3d', star: '#ffe27a', antenna: 'star', tail: true, size: 1 };
async function tabCharacter(body) {
  const cur = { ...DEF, ...S.character.params };
  const G = await ipcRenderer.invoke('char:gallery'), msg = h('div');
  const run = async (btn, ch, ...a) => {
    msg.replaceChildren(); const t = btn.textContent; btn.disabled = true; btn.textContent = '处理中…';
    const r = await ipcRenderer.invoke(ch, ...a);
    if (!r.ok) { btn.disabled = false; btn.textContent = t; msg.append(h('div', { class: 'err' }, r.error)); return; }
    render();
  };
  // 我的形象：已安装的形象包，点一下就换
  body.append(h('div', { class: 'card' }, h('h3', {}, '我的形象'),
    h('div', { class: 'gal' }, ...G.packs.map(p => h('div', { class: 'gi' + (p.id === G.current ? ' on' : '') },
      h('div', { class: 'gn' }, p.name), h('div', { class: 'muted' }, p.builtin ? '内置 · 原创' : '本机形象包'),
      h('div', { class: 'row' }, p.id === G.current ? h('span', { class: 'tag ok' }, '使用中') : h('button', { class: 'pri', onclick: e => run(e.target, 'char:use', p.id) }, '使用'),
        p.builtin ? null : h('button', { class: 'ghost', onclick: e => { if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = '确认删除'; return; } run(e.target, 'char:remove', p.id); } }, '删除'))))),
    msg));
  // 形象库：可以下载的形象（内置原创 + 本机 / 企业自己维护的列表）
  const lib = G.sources.filter(x => !x.installed);
  body.append(h('div', { class: 'card' }, h('h3', {}, '形象库'),
    G.sources.length ? null : h('div', { class: 'muted' }, '形象库是空的：可以用下面的链接导入，或编辑形象列表。'),
    ...G.sources.map(x => h('div', { class: 'li' },
      h('div', { class: 'lt' }, x.name, h('span', { class: 'tag' }, x.origin === 'builtin' ? '内置' : '本机列表')),
      x.license ? h('div', { class: 'muted' }, x.license) : null,
      h('div', { class: 'row' }, x.installed ? h('span', { class: 'tag ok' }, '已下载') : h('button', { class: 'pri', onclick: e => run(e.target, 'char:install-source', x.id) }, '下载并使用'),
        x.page ? h('button', { class: 'ghost', onclick: () => ipcRenderer.invoke('char:open-page', x.page) }, '来源页面') : null))),
    h('div', { class: 'row' }, h('button', { class: 'ghost', onclick: () => ipcRenderer.invoke('char:open-sources') }, '编辑形象列表'), h('span', { class: 'muted' }, lib.length ? `还有 ${lib.length} 个可下载` : ''))));
  // 导入：链接或本机文件
  const url = h('input', { placeholder: 'https://…/model.glb', style: 'flex:1' }), nm = h('input', { placeholder: '名字（可选）', style: 'width:96px' });
  body.append(h('div', { class: 'card' }, h('h3', {}, '导入模型'),
    h('div', { class: 'muted' }, '支持 .glb 模型，只存在本机；请用有权使用的模型。'),
    h('div', { class: 'row' }, url, nm),
    h('div', { class: 'row' }, h('button', { class: 'pri', onclick: e => { if (url.value.trim()) run(e.target, 'char:install-url', url.value.trim(), nm.value.trim()); } }, '从链接导入'),
      h('button', { onclick: e => run(e.target, 'char:install-file', nm.value.trim()) }, '从文件导入…'))));
  if (S.character.id !== 'lumi') return; // 颜色、触角等定制只对内置星灵生效
  const form = h('div', { class: 'card' }, h('h3', {}, '定制'));
  for (const k of Object.keys(COLOR_LABELS)) form.append(h('div', { class: 'row' }, h('label', {}, COLOR_LABELS[k]), h('input', { type: 'color', class: 'sw', value: cur[k], oninput: e => { cur[k] = e.target.value; } })));
  form.append(h('div', { class: 'row' }, h('label', {}, '触角'), h('select', { onchange: e => { cur.antenna = e.target.value; } }, ...[['star', '星星灯'], ['leaf', '小叶子'], ['none', '不要']].map(([v, n]) => h('option', { value: v, selected: cur.antenna === v }, n)))));
  form.append(h('div', { class: 'row' }, h('label', {}, '尾巴'), h('input', { type: 'checkbox', checked: cur.tail, onchange: e => { cur.tail = e.target.checked; } }), h('label', { style: 'min-width:auto' }, '大小'), h('input', { type: 'range', min: 0.8, max: 1.3, step: 0.05, value: cur.size, oninput: e => { cur.size = +e.target.value; } })));
  const fmsg = h('div');
  form.append(h('div', { class: 'row' }, h('button', { class: 'pri', onclick: async () => { await ipcRenderer.invoke('panel:save-character', { id: 'lumi', params: cur }); fmsg.replaceChildren(h('div', { class: 'ok' }, '已应用，精灵会刷新一下。')); } }, '应用'),
    h('button', { class: 'ghost', onclick: async () => { await ipcRenderer.invoke('panel:save-character', { id: 'lumi', params: {} }); render(); } }, '恢复默认')), fmsg);
  body.append(form);
  body.append(aiBox('让 AI 定制形象', '例如：换成薄荷绿和奶油色，不要尾巴，触角用小叶子', async text => {
    const r = await ipcRenderer.invoke('panel:ai-character', text);
    if (!r.ok) return { error: r.errors.join('\n') };
    return { summary: r.summary, preview: h('div', { class: 'pv' }, ...Object.entries(r.params).map(([k, v]) => h('span', { class: 'chip' }, String(v).startsWith('#') ? h('span', { class: 'sw', style: `width:12px;height:12px;background:${v}` }) : null, `${COLOR_LABELS[k] || k}：${v}`))),
      apply: async () => { await ipcRenderer.invoke('panel:save-character', { id: 'lumi', params: { ...S.character.params, ...r.params } }); render(); } };
  }));
}

/* ---------- 气泡布局 ---------- */
function tabLayout(body) {
  const L = structuredClone(S.layout), msg = h('div');
  const usedIds = () => new Set(L.groups.flatMap(g => g.items));
  const draw = () => {
    list.replaceChildren(...L.groups.map((g, gi) => h('div', { class: 'grp' },
      h('div', { class: 'gh' },
        h('input', { value: g.label, maxlength: 5, oninput: e => { g.label = e.target.value; } }),
        h('select', { onchange: e => { g.icon = e.target.value; } }, ...S.icons.map(i => h('option', { value: i, selected: g.icon === i }, i))),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'ghost', title: '上移', disabled: gi === 0, onclick: () => { [L.groups[gi - 1], L.groups[gi]] = [L.groups[gi], L.groups[gi - 1]]; draw(); } }, '↑'),
        h('button', { class: 'ghost', title: '删除分组', onclick: () => { L.groups.splice(gi, 1); draw(); } }, '删除')),
      h('div', {}, ...g.items.map((id, ii) => h('span', { class: 'chip' },
        h('i', { title: '左移', onclick: () => { if (ii) { [g.items[ii - 1], g.items[ii]] = [g.items[ii], g.items[ii - 1]]; draw(); } } }, '‹'),
        (S.catalog[id] || {}).label || id, h('i', { title: '隐藏', onclick: () => { g.items.splice(ii, 1); draw(); } }, '×'))),
        h('select', { class: 'chip add', onchange: e => { if (e.target.value) { g.items.push(e.target.value); draw(); } } }, h('option', { value: '' }, '＋ 添加'),
          ...Object.entries(S.catalog).filter(([id]) => !usedIds().has(id)).map(([id, a]) => h('option', { value: id }, a.label)))))));
  };
  const list = h('div'); draw();
  body.append(h('div', { class: 'card' }, h('h3', {}, '展示哪些气泡'), h('div', { class: 'muted' }, '内圈是分组，外圈是功能；× 隐藏，‹ 调顺序。'), list,
    h('div', { class: 'row' },
      h('button', { onclick: () => { L.groups.push({ id: 'g' + Date.now().toString(36).slice(-5), label: '新分组', icon: 'magic', color: ['#ec4899', '#3b82f6'], tip: '', items: [] }); draw(); } }, '＋ 分组'),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'ghost', onclick: async () => { await ipcRenderer.invoke('panel:reset-layout'); render(); } }, '恢复默认'),
      h('button', { class: 'pri', onclick: async () => { const v = await ipcRenderer.invoke('panel:save-layout', L); msg.replaceChildren(v.ok ? h('div', { class: 'ok' }, '已保存，点精灵就能看到。') : h('div', { class: 'err' }, v.errors.join('\n'))); } }, '保存')), msg));
  body.append(aiBox('让 AI 改气泡', '例如：把邮箱分组挪到第一位，互动里只留瞬移和爱心，工作里加上平台', async text => {
    const r = await ipcRenderer.invoke('panel:ai-layout', text);
    if (!r.ok) return { error: r.errors.join('\n') };
    return { summary: r.summary, preview: h('div', {}, ...r.layout.groups.map(g => h('div', { class: 'muted' }, `${g.label}：${g.items.map(i => (S.catalog[i] || {}).label || i).join('、') || '（空）'}`))),
      apply: async () => { await ipcRenderer.invoke('panel:save-layout', r.layout); render(); } };
  }));
  body.append(h('div', { class: 'card' }, h('h3', {}, '给其他 AI 改'), h('div', { class: 'muted' }, '保存在 ', h('code', {}, 'layout.json'), '，AI 直接改文件也会生效（格式见 ', h('code', {}, 'AGENTS.md'), '）。')));
}

/* ---------- 关联需求管理平台（MP2）账号 ---------- */
async function tabAccount(body) {
  const v = await ipcRenderer.invoke('mp2:state'), a = v.account, L = v.linking, msg = h('div');
  const fmt = t => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '');
  if (a.linked && !L) {
    body.append(h('div', { class: 'card' }, h('h3', {}, '✅ 已关联'),
      h('div', { class: 'row' }, h('label', {}, '地址'), h('span', {}, a.baseUrl)),
      a.connectionId ? h('div', { class: 'row' }, h('label', {}, '连接'), h('code', {}, a.connectionId.slice(0, 8))) : null,
      a.linkedAt ? h('div', { class: 'row' }, h('label', {}, '关联时间'), h('span', {}, fmt(a.linkedAt))) : null,
      h('div', { class: 'muted' }, '搬运会送进你在 MP2 的个人需求池；凭据只存在本机。'),
      h('div', { class: 'row' },
        h('button', { onclick: async e => { if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = '再点一次确认断开'; return; } await ipcRenderer.invoke('mp2:unlink'); render(); } }, '断开（删除本机凭据）'),
        h('button', { class: 'ghost', onclick: () => ipcRenderer.invoke('mp2:open-revoke') }, '去 MP2 撤销授权')),
      h('div', { class: 'muted' }, '断开只删本机凭据；彻底失效请到 MP2 撤销。'),
      v.prefill && v.prefill.base !== a.baseUrl ? h('div', { class: 'err' }, `网页请求关联 ${v.prefill.base}；当前已关联 ${a.baseUrl}。要换平台，先断开再重新关联。`) : null));
    return;
  }
  if (L && L.phase === 'waiting') {
    const left = Math.max(0, Math.round((Date.parse(L.expires_at) - Date.now()) / 60000));
    body.append(h('div', { class: 'card' }, h('h3', {}, '在需求管理平台确认'),
      h('div', { class: 'muted' }, '已打开确认页：登录 MP2，核对代码后点「允许」。'),
      h('div', { class: 'code' }, L.user_code),
      h('div', { class: 'muted' }, `约 ${left} 分钟内有效 · 每 5 秒自动查一次结果${L.note ? ' · ' + L.note : ''}`),
      h('div', { class: 'row' }, h('button', { onclick: () => ipcRenderer.invoke('mp2:link-reopen') }, '重新打开确认页'), h('button', { class: 'ghost', onclick: async () => { await ipcRenderer.invoke('mp2:link-cancel'); render(); } }, '取消'))));
    return;
  }
  const done = L && { denied: '你在 MP2 上点了「拒绝」，这次没有关联。', expired: '代码已过期或已失效，请重新发起。', error: L.message || '关联失败。' }[L.phase];
  const url = h('input', { value: v.lastUrl || '', placeholder: 'https://需求管理平台地址', style: 'flex:1' });
  const go = h('button', { class: 'pri' }, done ? '重新发起' : '申请关联代码');
  go.onclick = async () => {
    msg.replaceChildren(); if (!url.value.trim()) { msg.append(h('div', { class: 'err' }, '请先填写 MP2 地址')); return; }
    go.disabled = true; go.textContent = '申请中…';
    const r = await ipcRenderer.invoke('mp2:link-start', url.value);
    if (!r.ok) { go.disabled = false; go.textContent = '申请关联代码'; msg.append(h('div', { class: 'err' }, r.error)); return; }
    render();
  };
  // 从需求管理平台网页唤起（jmdesk://connect）：只预填地址，用户核对后自己发起
  const pre = v.prefill && !done ? h('div', { class: 'muted' },
    '从需求管理平台网页打开，地址已填好。请核对是你要关联的平台，再点「申请关联代码」。',
    v.prefill.loopback || /^https:/i.test(v.prefill.base) ? null : h('div', { class: 'err' }, '这个地址不是 https，也不是本机地址；确认是公司内网平台再继续。')) : null;
  body.append(h('div', { class: 'card' }, h('h3', {}, '关联需求管理平台账号'),
    done ? h('div', { class: 'err' }, done) : null, pre,
    h('div', { class: 'muted' }, '关联后，搬运会送进你在 MP2 的个人需求池；随时可断开。'),
    h('div', { class: 'row' }, h('label', {}, 'MP2 地址'), url), h('div', { class: 'row' }, go), msg));
}

/* ---------- 让本机 AI 控制 JM Desk（D86）：本机 MCP 端点，默认关闭 ---------- */
async function localAiCard() {
  const v = await ipcRenderer.invoke('localai:state'), msg = h('div');
  const inv = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (r && r.ok === false) throw new Error(r.error); return r && 'data' in r ? r.data : r; };
  const toggle = h('button', { class: v.enabled ? '' : 'pri', onclick: async () => { toggle.disabled = true; try { await inv('localai:set', !v.enabled); render(); } catch (e) { toggle.disabled = false; msg.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, v.enabled ? '关闭' : '打开');
  return h('div', { class: 'card' }, h('h3', {}, '让本机 AI 控制 JM Desk'),
    h('div', { class: 'muted' }, '打开后，本机的 AI（Claude Code、Codex 等）可以通过 MCP 查看和整理工作台：从需求管理平台拉取、绑定和回写平台记录、刷新进度、改工作和待办。只在本机可用；会改数据的操作每次都会在这里弹窗问你。'),
    v.enabled && v.url ? h('div', { class: 'row' }, h('label', {}, '地址'), h('code', {}, v.url)) : null,
    v.enabled ? h('div', { class: 'muted' }, '配置（含令牌，只给本机用户读）：', h('code', {}, v.file)) : null,
    h('div', { class: 'row' }, toggle,
      v.enabled ? h('button', { onclick: async () => { try { await inv('localai:copy-config'); msg.replaceChildren(h('div', { class: 'ok' }, '已复制。把其中的 mcpServers 加进本机 AI 的 MCP 配置。')); } catch (e) { msg.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '复制 MCP 配置') : null,
      v.enabled ? h('button', { class: 'ghost', onclick: async () => { try { await inv('localai:rotate'); msg.replaceChildren(h('div', { class: 'ok' }, '已换新令牌；本机 AI 需要重新复制配置。')); } catch (e) { msg.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '换令牌') : null),
    msg);
}

/* ---------- 接入：平台 API 与 MCP ---------- */
/* 一行内说清连到哪里：命令只留程序名和脚本名，网址只留域名和路径；完整内容放在悬停提示里 */
const base = x => String(x || '').split(/[\\/]/).pop();
function shortWhere(it, where) {
  if (it.kind === 'mcp-stdio') { const args = (it.args || []).filter(a => !/^-/.test(a)); return [base(it.command), args.length ? base(args[args.length - 1]) : ''].filter(Boolean).join(' · '); }
  const u = it.kind === 'mcp-http' ? it.url : it.baseUrl || it.openapi;
  try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname) + (it.urls?.length > 1 ? `（另有 ${it.urls.length - 1} 个备用地址）` : ''); } catch { return where; }
}
async function tabIntegrations(body) {
  const I = await ipcRenderer.invoke('integ:state');
  const inv = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (r && r.ok === false) throw new Error(r.error); return r && 'data' in r ? r.data : r; };
  const parseLines = (t, sep) => Object.fromEntries(String(t || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf(sep); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; }).filter(Boolean));
  const list = h('div', { class: 'card' }, h('h3', {}, '已接入'),
    h('div', { class: 'muted' }, '助手和问知识会调用这些工具；改数据前都会先问你。'));
  if (!I.list.length) list.append(h('div', { class: 'muted', style: 'margin:8px 0' }, I.mp2Linked ? '' : '还没有接入。关联需求管理平台后它会自动出现在这里；其他平台从下面添加。'));
  for (const it of I.list) {
    const out = h('div'), toolsBox = h('div', { style: 'display:none' });
    const where = it.kind === 'builtin' ? '不用配置：本机的线索、待办、需求池' : it.kind === 'mcp-stdio' ? [it.command, ...(it.args || [])].join(' ') : it.kind === 'mcp-http' ? it.url : [it.baseUrl, it.openapi ? 'OpenAPI：' + it.openapi : '通用请求'].filter(Boolean).join(' · ');
    const secrets = [...it.secretKeys.env.map(k => '变量 ' + k), ...it.secretKeys.headers.map(k => '请求头 ' + k), it.secretKeys.token ? '密钥' : null].filter(Boolean);
    toolsBox.append(...it.tools.map(t => h('div', { class: 'row', style: 'margin:4px 0' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', { style: 'font-weight:600;font-size:12.5px' }, t.title || t.name, t.write ? h('span', { class: 'tag warn', style: 'margin-left:4px;font-weight:400' }, '会改数据') : t.dynamic ? h('span', { class: 'tag', style: 'margin-left:4px;font-weight:400' }, '查询自动 / 修改确认') : null),
        h('div', { class: 'muted', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, t.description || t.name)),
      h('select', { onchange: async e => { try { await inv('integ:policy', it.id, t.name, e.target.value); } catch (er) { out.replaceChildren(h('div', { class: 'err' }, er.message)); } } },
        ...Object.entries(I.modes).map(([k, v]) => h('option', { value: k, selected: t.mode === k }, v))))));
    list.append(h('div', { class: 'gi', style: 'margin-top:8px' + (it.enabled === false ? ';opacity:.55' : '') },
      h('div', { class: 'lt' }, it.name, h('span', { class: 'tag' }, it.kindLabel), it.builtin ? h('span', { class: 'tag ok' }, '内置') : it.preset ? h('span', { class: 'tag ok' }, '预置') : null, it.cred && !it.cred.set ? h('span', { class: 'tag warn' }, '缺凭据') : null, it.importedFrom ? h('span', { class: 'tag' }, '来自 ' + it.importedFrom) : null),
      h('div', { class: 'muted one', title: where }, shortWhere(it, where)),
      secrets.length ? h('div', { class: 'muted' }, '已加密保存：' + secrets.join('、')) : null,
      it.cred ? credBox(it, out) : null,
      h('div', { class: 'muted' }, it.checkedAt ? `${it.tools.length} 个工具 · ${it.server?.name ? it.server.name + ' · ' : ''}上次测试 ${new Date(it.checkedAt).toLocaleString('zh-CN', { hour12: false })}` : '还没测试过：点「测试」连接并读取工具清单'),
      h('div', { class: 'row' },
        h('button', { class: 'pri', onclick: async e => { const b = e.target; b.disabled = true; b.textContent = '连接中…'; out.replaceChildren();
          try { const r = await inv('integ:test', it.id); out.append(h('div', { class: 'ok' }, `连上了 · ${r.tools} 个工具 · ${r.secs} 秒`)); setTimeout(render, 900); } catch (er) { out.append(h('div', { class: 'err' }, er.message)); }
          b.disabled = false; b.textContent = '测试'; } }, '测试'),
        it.tools.length ? h('button', { onclick: e => { const on = toolsBox.style.display === 'none'; toolsBox.style.display = on ? '' : 'none'; e.target.textContent = on ? '收起工具' : `工具权限（${it.tools.length}）`; } }, `工具权限（${it.tools.length}）`) : null,
        h('button', { onclick: async () => { await inv('integ:toggle', it.id, it.enabled === false); render(); } }, it.enabled === false ? '启用' : '停用'),
        it.builtin || it.preset ? null : h('button', { onclick: () => form(it.kind, it) }, '编辑'),
        it.builtin || it.preset ? null : h('button', { class: 'ghost', onclick: async e => { if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = '确认删除'; return; } await inv('integ:remove', it.id); render(); } }, '删除')),
      out, toolsBox));
  }
  body.append(list, await localAiCard());
  /* 需要个人凭据的预置接入：粘贴凭据，或填本机凭据文件路径（只引用） */
  function credBox(it, out) {
    const c = it.cred, tok = h('input', { type: 'password', placeholder: c.set && !c.file ? '已保存（留空不改）' : '粘贴' + c.label, style: 'flex:1' }), file = h('input', { value: c.file || '', placeholder: '或：本机凭据文件路径', style: 'flex:1' });
    return h('div', { class: 'cred' },
      h('div', { class: 'muted' }, c.set ? (c.file ? (c.fileOk ? `${c.label}：${c.inherited ? '已继承本机配置，' : ''}读取 ${c.file}` : `读不到凭据文件 ${c.file}，请检查路径`) : `${c.label}：已加密保存`) : `需要${c.label}才能连上`),
      h('div', { class: 'row' }, tok), h('div', { class: 'row' }, file),
      h('div', { class: 'row' }, h('button', { class: 'pri', onclick: async () => {
        try { await inv('integ:credential', it.id, tok.value.trim() ? { token: tok.value.trim() } : file.value.trim() ? { tokenFile: file.value.trim() } : {}); out.replaceChildren(h('div', { class: 'ok' }, '已保存，正在连接…'));
          const r = await inv('integ:test', it.id); out.replaceChildren(h('div', { class: 'ok' }, `连上了 · ${r.tools} 个工具`)); setTimeout(render, 900); } catch (e) { out.replaceChildren(h('div', { class: 'err' }, e.message)); }
      } }, '保存凭据并连接')));
  }
  const add = h('div', { class: 'card' }, h('h3', {}, '添加接入'));
  const addButtons = () => add.replaceChildren(h('h3', {}, '添加接入'),
    h('div', { class: 'row' }, h('button', { onclick: () => form('mcp-stdio') }, '＋ MCP（本机命令）'), h('button', { onclick: () => form('mcp-http') }, '＋ MCP（网址）'), h('button', { onclick: () => form('api') }, '＋ 平台 API')),
    h('div', { class: 'muted' }, '不确定选哪种？向平台要 MCP 地址或 OpenAPI 文档。'));
  addButtons(); body.append(add);
  const imp = h('div', { class: 'card' }, h('h3', {}, '从其他 AI 工具导入 MCP'),
    h('div', { class: 'muted' }, '从 Claude Code、Cursor、Codex 导入，密钥直接加密保存。'));
  const impBox = h('div'); imp.append(h('div', { class: 'row' }, h('button', { onclick: async () => {
    const found = await ipcRenderer.invoke('integ:detect');
    if (!found.length) { impBox.replaceChildren(h('div', { class: 'muted' }, '没有找到。')); return; }
    const picks = new Set();
    impBox.replaceChildren(...found.map(d => h('div', { class: 'row', style: 'margin:3px 0' + (d.exists ? ';opacity:.5' : '') },
      h('input', { type: 'checkbox', disabled: d.exists, onchange: e => { e.target.checked ? picks.add(d.n) : picks.delete(d.n); } }),
      h('div', { style: 'flex:1;min-width:0' }, h('div', { style: 'font-weight:600' }, d.name, ' ', h('span', { class: 'tag' }, d.from), d.exists ? h('span', { class: 'tag ok' }, '已接入') : null),
        h('div', { class: 'muted', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, d.url || [d.command, ...d.args].join(' ')),
        d.envKeys.length || d.headerKeys.length ? h('div', { class: 'muted' }, '带密钥：' + [...d.envKeys, ...d.headerKeys].join('、')) : null))),
      h('div', { class: 'row' }, h('button', { class: 'pri', onclick: async () => { try { const r = await inv('integ:import', [...picks]); impBox.replaceChildren(h('div', { class: 'ok' }, `已导入 ${r.length} 个：${r.join('、')}。逐个点「测试」确认能连上。`)); setTimeout(render, 1500); } catch (e) { impBox.append(h('div', { class: 'err' }, e.message)); } } }, '导入所选')));
  } }, '查找')), impBox);
  body.append(imp);

  function form(kind, it = null) {
    const f = { name: h('input', { value: it?.name || '', placeholder: '名字，例如 飞书 / ERP / GitLab', style: 'flex:1' }) }, m = h('div'), rows = [['名字', f.name]];
    if (kind === 'mcp-stdio') {
      f.command = h('input', { value: it?.command || '', placeholder: '命令，例如 npx', style: 'flex:1' }); f.args = h('input', { value: (it?.args || []).join(' '), placeholder: '参数，例如 -y @scope/mcp-server', style: 'flex:1' });
      f.env = h('textarea', { placeholder: it?.secretKeys?.env.length ? `已保存 ${it.secretKeys.env.join('、')}；留空不改，填写则整体替换` : '环境变量，一行一个：API_KEY=xxxx（加密保存）' });
      rows.push(['命令', f.command], ['参数', f.args], ['环境变量', f.env]);
    } else if (kind === 'mcp-http') {
      f.url = h('input', { value: it?.url || '', placeholder: 'https://…/mcp', style: 'flex:1' });
      f.headers = h('textarea', { placeholder: it?.secretKeys?.headers.length ? `已保存 ${it.secretKeys.headers.join('、')}；留空不改` : '请求头，一行一个：Authorization: Bearer xxxx（加密保存）' });
      rows.push(['网址', f.url], ['请求头', f.headers]);
    } else {
      f.baseUrl = h('input', { value: it?.baseUrl || '', placeholder: 'https://api.example.com', style: 'flex:1' }); f.openapi = h('input', { value: it?.openapi || '', placeholder: 'OpenAPI 文档网址或文件（可选）', style: 'flex:1' });
      f.authType = h('select', {}, ...[['none', '不需要'], ['bearer', 'Bearer Token'], ['header', '自定义请求头'], ['query', '查询参数']].map(([k, v]) => h('option', { value: k, selected: (it?.auth?.type || 'none') === k }, v)));
      f.authName = h('input', { value: it?.auth?.name || '', placeholder: '请求头或参数名，例如 X-API-Key', style: 'flex:1' }); f.token = h('input', { type: 'password', placeholder: it?.secretKeys?.token ? '已保存（留空不改）' : '密钥（加密保存）', style: 'flex:1' });
      rows.push(['接口地址', f.baseUrl], ['OpenAPI', f.openapi], ['鉴权', f.authType], ['名称', f.authName], ['密钥', f.token]);
    }
    add.replaceChildren(h('h3', {}, (it ? '修改 · ' : '添加 · ') + I.kinds[kind]), ...rows.map(([l, el]) => h('div', { class: 'row' }, h('label', {}, l), el)),
      h('div', { class: 'row' }, h('button', { class: 'pri', onclick: async () => {
        const x = { id: it?.id, kind, name: f.name.value, enabled: it?.enabled !== false, secret: {} };
        if (kind === 'mcp-stdio') { x.command = f.command.value; x.args = f.args.value; if (f.env.value.trim()) x.secret.env = parseLines(f.env.value, '='); }
        if (kind === 'mcp-http') { x.url = f.url.value; if (f.headers.value.trim()) x.secret.headers = parseLines(f.headers.value, ':'); }
        if (kind === 'api') { x.baseUrl = f.baseUrl.value.trim(); x.openapi = f.openapi.value.trim(); x.auth = { type: f.authType.value, name: f.authName.value }; x.secret.token = f.token.value; }
        try { const r = await inv('integ:save', x); m.replaceChildren(h('div', { class: 'ok' }, '已保存，正在测试连接…')); try { const t = await inv('integ:test', r.id); m.replaceChildren(h('div', { class: 'ok' }, `已保存并连上：${t.tools} 个工具`)); } catch (er) { m.replaceChildren(h('div', { class: 'err' }, '已保存，但连接失败：' + er.message)); } setTimeout(render, 1200); }
        catch (e) { m.replaceChildren(h('div', { class: 'err' }, e.message)); }
      } }, '保存并测试'), h('button', { class: 'ghost', onclick: addButtons }, '取消')), m);
    add.scrollIntoView({ behavior: 'smooth' });
  }
}

/* ---------- 模型 ---------- */
/* 模型：多个来源（API / 本机 Claude Code / 本机 Codex / 本机 Ollama / 自定义命令）+ 按任务分配 + 每日额度 + 隐私 */
async function tabModel(body) {
  const M = await ipcRenderer.invoke('models:state'), msg = h('div');
  const fmt = n => (n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n || 0));
  const inv = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (r && r.ok === false) throw new Error(r.error); return r && 'data' in r ? r.data : r; };
  // 已有来源
  const list = h('div', { class: 'card' }, h('h3', {}, '模型来源'),
    h('div', { class: 'muted' }, '可以用 API，也可以用本机的 Claude Code、Codex、Ollama。'));
  if (!M.providers.length) list.append(h('div', { class: 'muted', style: 'margin:8px 0' }, '还没有模型来源，从下面添加一个。'));
  for (const p of M.providers) {
    const u = M.usage[p.id] || {}, out = h('div');
    const daily = h('input', { type: 'number', min: 0, step: 10000, value: p.dailyTokens || '', placeholder: '不限', style: 'width:96px' });
    list.append(h('div', { class: 'gi', style: 'margin-top:8px' + (p.enabled === false ? ';opacity:.55' : '') },
      h('div', { class: 'lt' }, p.name, h('span', { class: 'tag' }, p.kindLabel), p.local ? h('span', { class: 'tag ok' }, '本机') : null, p.kind === 'api' && !p.hasKey && !p.local ? h('span', { class: 'tag warn' }, '缺 Key') : null),
      h('div', { class: 'muted' }, [p.model, p.baseUrl, p.command].filter(Boolean).join(' · ')),
      h('div', { class: 'muted' }, `今天 ${fmt(u.today)} · 30 天 ${fmt(u.month)} tokens${u.est ? '（估）' : ''}`),
      h('div', { class: 'row' }, h('label', {}, '每日上限'), daily, h('span', { class: 'muted' }, 'tokens'),
        h('button', { onclick: async () => { try { await inv('models:save', { ...p, dailyTokens: daily.value }); render(); } catch (e) { out.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '保存')),
      h('div', { class: 'row' },
        h('button', { class: 'pri', onclick: async e => { const b = e.target; b.disabled = true; b.textContent = '测试中…'; out.replaceChildren();
          try { const r = await inv('models:test', p.id); out.append(h('div', { class: r.ok ? 'ok' : 'err' }, r.ok ? `可用 · ${r.secs} 秒 · 用了 ${fmt(r.tokens)} tokens` : '有回应，但格式不对')); } catch (er) { out.append(h('div', { class: 'err' }, er.message)); }
          b.disabled = false; b.textContent = '测试'; } }, '测试'),
        h('button', { onclick: async () => { await inv('models:save', { ...p, enabled: p.enabled === false }); render(); } }, p.enabled === false ? '启用' : '停用'),
        p.kind === 'api' && !p.local ? h('button', { onclick: () => editApi(p) }, '改 Key / 地址') : null,
        h('button', { class: 'ghost', onclick: async e => { if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = '确认删除'; return; } await inv('models:remove', p.id); render(); } }, '删除')),
      out));
  }
  body.append(list);
  // 添加
  const add = h('div', { class: 'card' }, h('h3', {}, '添加模型来源'));
  const have = new Set(M.providers.map(p => p.kind + '|' + (p.model || p.command || '')));
  const det = M.detected.filter(d => !have.has(d.kind + '|' + (d.model || d.command || '')));
  if (det.length) add.append(h('div', { class: 'muted' }, '这台电脑上找到：'), ...det.map(d => h('div', { class: 'row' }, h('span', { style: 'flex:1' }, d.name),
    h('button', { class: 'pri', onclick: async () => { try { await inv('models:save', { kind: d.kind, name: d.name, command: d.command, baseUrl: d.baseUrl, model: d.model }); render(); } catch (e) { msg.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '加入'))));
  add.append(h('div', { class: 'row' }, h('button', { onclick: () => editApi(null) }, '＋ API（DeepSeek / OpenAI 兼容）'), h('button', { onclick: () => editCmd() }, '＋ 自定义本机命令')),
    h('div', { class: 'muted' }, 'Codex 每次约 1.5 万 tokens、几十秒，适合汇总等低频任务。'), msg);
  body.append(add);
  // 按任务分配 + 隐私
  const routing = structuredClone(M.routing), pol = { ...M.policy };
  const ids = M.providers.filter(p => p.enabled !== false);
  const route = h('div', { class: 'card' }, h('h3', {}, '哪个任务用哪个模型'), h('div', { class: 'muted' }, '首选不可用或额度用完，自动换备用。'));
  for (const [t, label] of Object.entries(M.tasks)) {
    const cur = routing[t] || [];
    route.append(h('div', { class: 'row' }, h('label', { style: 'min-width:120px' }, label),
      ...[0, 1].map(i => h('select', { onchange: e => { const v = [...(routing[t] || [])]; v[i] = e.target.value; routing[t] = v.filter(Boolean); } },
        h('option', { value: '' }, i ? '（备用：无）' : '（自动）'), ...ids.map(p => h('option', { value: p.id, selected: cur[i] === p.id }, p.name))))));
  }
  const rmsg = h('div');
  route.append(h('div', { class: 'row' }, h('input', { type: 'checkbox', checked: !!pol.privateLocalOnly, onchange: e => { pol.privateLocalOnly = e.target.checked; } }),
    h('span', {}, '邮件和聊天内容（汇总）只交给本机模型'), h('span', { class: 'muted' }, '（只用 Ollama 等本机模型）')),
    h('div', { class: 'row' }, h('button', { class: 'pri', onclick: async () => { try { await inv('models:routing', routing, pol); rmsg.replaceChildren(h('div', { class: 'ok' }, '已保存')); } catch (e) { rmsg.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '保存')), rmsg);
  body.append(route);

  function editApi(p) {
    const f = { id: p?.id || '', name: h('input', { value: p?.name || 'DeepSeek', style: 'flex:1' }), baseUrl: h('input', { value: p?.baseUrl || 'https://api.deepseek.com', style: 'flex:1' }),
      model: h('input', { value: p?.model || 'deepseek-flash', style: 'flex:1' }), key: h('input', { type: 'password', placeholder: p?.hasKey ? '已配置（留空不改）' : 'sk-…', style: 'flex:1' }) }, m = h('div');
    add.replaceChildren(h('h3', {}, p ? '修改 API' : '添加 API'), ...['name', 'baseUrl', 'model', 'key'].map(k => h('div', { class: 'row' }, h('label', {}, { name: '名字', baseUrl: '地址', model: '模型', key: 'Key' }[k]), f[k])),
      h('div', { class: 'muted' }, 'Key 加密存在本机；Ollama 填 127.0.0.1:11434/v1，不用 Key。'),
      h('div', { class: 'row' }, h('button', { class: 'pri', onclick: async () => { try { await inv('models:save', { ...(p || {}), kind: 'api', id: f.id, name: f.name.value, baseUrl: f.baseUrl.value, model: f.model.value, key: f.key.value }); render(); } catch (e) { m.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '保存'), h('button', { class: 'ghost', onclick: () => render() }, '取消')), m);
    add.scrollIntoView({ behavior: 'smooth' });
  }
  function editCmd() {
    const f = { name: h('input', { placeholder: '例如 Gemini CLI', style: 'flex:1' }), command: h('input', { placeholder: '命令，例如 gemini', style: 'flex:1' }), args: h('input', { placeholder: '参数，例如 -p', style: 'flex:1' }) }, local = h('input', { type: 'checkbox' }), m = h('div');
    add.replaceChildren(h('h3', {}, '添加本机命令'), ...['name', 'command', 'args'].map(k => h('div', { class: 'row' }, h('label', {}, { name: '名字', command: '命令', args: '参数' }[k]), f[k])),
      h('div', { class: 'row' }, local, h('span', {}, '完全在本机运行（不联网），可以处理邮件和聊天')),
      h('div', { class: 'muted' }, '提示词走标准输入，输出里要有 JSON。'),
      h('div', { class: 'row' }, h('button', { class: 'pri', onclick: async () => { try { await inv('models:save', { kind: 'cmd', name: f.name.value, command: f.command.value, args: f.args.value, local: local.checked }); render(); } catch (e) { m.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, '保存'), h('button', { class: 'ghost', onclick: () => render() }, '取消')), m);
    add.scrollIntoView({ behavior: 'smooth' });
  }
}
function tabAbout(body) {
  body.append(h('div', { class: 'card' }, h('h3', {}, 'JM Desk ' + S.version), h('div', { class: 'muted' }, '开源的本地 AI 桌面助手，形象、平台、知识库、模型都可扩展。'),
    h('div', { class: 'row' }, h('button', { class: 'pri', onclick: () => ipcRenderer.send('panel:action', 'app.update') }, '检查更新'), h('button', { onclick: () => ipcRenderer.invoke('panel:open-data-dir') }, '打开数据目录')), h('div', { class: 'muted' }, S.dataDir)));
}

/* 通用：让 AI 改，先预览再应用 */
function aiBox(title, ph, run) {
  const ta = h('textarea', { placeholder: ph }), out = h('div'), go = h('button', { class: 'pri' }, '生成预览');
  go.onclick = async () => {
    if (!ta.value.trim()) return; go.disabled = true; go.textContent = '生成中…'; out.replaceChildren();
    try { const r = await run(ta.value.trim()); if (r.error) out.append(h('div', { class: 'err' }, r.error)); else out.append(h('div', { class: 'ok' }, r.summary || '已生成'), r.preview, h('div', { class: 'row' }, h('button', { class: 'pri', onclick: r.apply }, '应用'), h('button', { class: 'ghost', onclick: () => out.replaceChildren() }, '不要'))); }
    finally { go.disabled = false; go.textContent = '生成预览'; }
  };
  return h('div', { class: 'card' }, h('h3', {}, title), ta, h('div', { class: 'row' }, go), out);
}
render();
