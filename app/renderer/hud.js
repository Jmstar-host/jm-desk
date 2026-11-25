/* 精灵的气泡菜单：独立的透明面板窗口（不抢焦点、不改动精灵窗口），由悬浮精灵窗口控制。 */
const { ipcRenderer } = require('electron');
const qs = new URLSearchParams(location.search);
let remote = null;
try { remote = require('@electron/remote'); } catch (e) { try { remote = require(require('path').join(qs.get('rp') || '', 'node_modules', '@electron', 'remote')); } catch (e2) { console.warn('menu: remote unavailable', e2); } }
const me = remote.getCurrentWindow();
const tell = (type, data = {}) => { try { const h = remote.BrowserWindow.fromId(+qs.get('host')); if (h && !h.isDestroyed()) h.webContents.send('jm-menu', JSON.stringify({ type, ...data })); } catch (e) {} };
const box = document.getElementById('box');
const wait = ms => new Promise(r => setTimeout(r, ms));
const frames = n => new Promise(r => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });

/* 一套风格统一的线性图标（24 网格，圆头圆角，渐变描边） */
const ICONS = {
  magic: '<path d="M4.5 19.5 13.2 10.8"/><path d="M15.6 3.6l1.1 2.5 2.5 1.1-2.5 1.1-1.1 2.5-1.1-2.5-2.5-1.1 2.5-1.1z"/><path d="M19.6 13.2l.6 1.3 1.3.6-1.3.6-.6 1.3-.6-1.3-1.3-.6 1.3-.6z"/><path d="M7.5 5.2h.01"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="M4.2 7.3 12 12.6l7.8-5.3"/>',
  sliders: '<path d="M4 7.5h8.5M16.5 7.5H20M4 16.5h3.5M11.5 16.5H20"/><circle cx="14.5" cy="7.5" r="2"/><circle cx="9.5" cy="16.5" r="2"/>',
  portal: '<path d="M12 12a1.4 1.4 0 0 1 2.8 0 2.8 2.8 0 0 1-5.6 0 4.2 4.2 0 0 1 8.4 0 5.6 5.6 0 0 1-11.2 0"/><path d="M19.5 4.5h.01M4.5 5.5h.01"/>',
  burst: '<circle cx="12" cy="12" r="2.6"/><path d="M12 3.2v3M12 17.8v3M3.2 12h3M17.8 12h3M5.8 5.8 7.9 7.9M16.1 16.1l2.1 2.1M5.8 18.2l2.1-2.1M16.1 7.9l2.1-2.1"/>',
  orbit: '<ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(-24 12 12)"/><circle cx="12" cy="12" r="2.4"/><path d="M19.3 7.6h.01"/>',
  dash: '<path d="M3 8.2h7.5M2.5 12h10.5M4 15.8h6.5"/><path d="M14.5 6.5 20 12l-5.5 5.5"/>',
  heart: '<path d="M12 19.8s-7.2-4.4-7.2-9.9a4 4 0 0 1 7.2-2.5 4 4 0 0 1 7.2 2.5c0 5.5-7.2 9.9-7.2 9.9z"/><path d="M19.5 2.8v2.6M18.2 4.1h2.6"/>',
  loop: '<path d="M19.8 12A7.8 7.8 0 1 1 17.5 6.5"/><path d="M18.3 3v4h-4"/>',
  smile: '<circle cx="12" cy="12" r="8.2"/><path d="M9 13.8c1.6 1.7 4.4 1.7 6 0M9.4 9.8h.01M14.6 9.8h.01"/>',
  doc: '<path d="M7 3.5h6.8l4.2 4.2V19A1.5 1.5 0 0 1 16.5 20.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.8V8h4.2M8.8 12.5h6.4M8.8 16h4"/>',
  check: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="M3.6 6.4l1.4 1.4L7.4 5.2M3.6 11.9l1.4 1.4 2.4-2.6M3.6 17.4l1.4 1.4 2.4-2.6"/>',
  chart: '<path d="M3.5 20.5h17"/><path d="M6.5 17V12M11 17V6.5M15.5 17V10M20 17V8"/>',
  inbox: '<path d="M4 13.5v4.6A1.9 1.9 0 0 0 5.9 20h12.2a1.9 1.9 0 0 0 1.9-1.9v-4.6"/><path d="M12 3.8v10.4M8 10.3l4 4 4-4"/>',
  quill: '<path d="M4 20l4.3-1 10.4-10.4a2 2 0 0 0-2.9-2.9L5.4 16.1z"/><path d="M13.8 7.2l3 3M13.5 20.2h6.5"/>',
  box: '<path d="M4 8.2 12 4.2l8 4v7.6l-8 4-8-4z"/><path d="M4 8.2l8 4 8-4M12 12.2v7.6"/>',
  wing: '<path d="M12 7.2v11.6"/><path d="M12 9.6C9.4 4.6 4 5.3 4.4 9.6c.4 4.4 4.9 4.4 7.6 2.6M12 9.6c2.6-5 8-4.3 7.6 0-.4 4.4-4.9 4.4-7.6 2.6"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 1 1 9.5 5 6 6 0 0 0 19 14.5z"/><path d="M17.2 3.6v2.2M16.1 4.7h2.2"/>',
  pin: '<path d="M12 21v-5.6M7 15.4h10l-1.6-3.2V5.6A1.6 1.6 0 0 0 13.8 4h-3.6a1.6 1.6 0 0 0-1.6 1.6v6.6z"/>',
  corner: '<path d="M6 6l11 11M17 10.2V17h-6.8"/><path d="M4 4h.01"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2.1H4.4z"/><path d="M10 20.6a2 2 0 0 0 4 0"/><path d="M12 3v1.6"/>',
  back: '<path d="M9.2 14.2 5 10l4.2-4.2"/><path d="M5.5 10H14a5 5 0 0 1 0 10h-2"/>',
};
const STAR = '<svg viewBox="0 0 10 10"><path d="M5 0 6 4 10 5 6 6 5 10 4 6 0 5 4 4z" fill="#fff"/></svg>';
let uid = 0;
function icon(name, c1, c2) {
  const id = 'g' + (++uid);
  return `<svg class="ic" viewBox="0 0 24 24"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="3" y1="3" x2="21" y2="21"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><g fill="none" stroke="url(#${id})" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.magic}</g></svg>`;
}

/* ================= 以精灵为中心的提示层 =================
 * 一个透明面板窗口：以精灵为中心、半径 H 的正方形，再和精灵所在屏幕的可用区域取交集，
 * 所以窗口永远不跨屏、不伸出屏幕；菜单气泡、悬停说明、说话气泡都画在这里。 */
const H = 300;
const $ = id => document.getElementById(id);
const root = $('root'), sayEl = $('say'), tipEl = $('tip');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let frame = null, mewL = { x: 0, y: 0, r: 0 }, menuOpen = false, sayOn = false, busy = false, idleT = null, leaveT = null, ignoring = null, items = [];
let sayTimer = null, tickTimer = null, sayAction = null, ctxOpen = false;
const ctxEl = $('ctx');
function setIgnore(v) { if (v === ignoring) return; ignoring = v; try { me.setIgnoreMouseEvents(v, { forward: true }); } catch (e) {} }
function armIdle() { clearTimeout(idleT); idleT = setTimeout(() => enqueue(() => closeMenu()), 15000); }
function frameFor(m, wa) {
  const L = Math.max(m.cx - H, wa.x), T = Math.max(m.cy - H, wa.y), R = Math.min(m.cx + H, wa.x + wa.width), Bt = Math.min(m.cy + H, wa.y + wa.height);
  return { x: Math.round(L), y: Math.round(T), width: Math.round(R - L), height: Math.round(Bt - T) };
}
async function placeFrame(m, wa) {
  const f = frameFor(m, wa);
  const same = frame && f.x === frame.x && f.y === frame.y && f.width === frame.width && f.height === frame.height;
  if (!same) {
    const vis = me.isVisible();
    if (vis) { root.style.opacity = '0'; await wait(130); }
    me.setBounds(f); frame = f; await wait(34);
    root.style.opacity = '';
  }
  mewL = { x: m.cx - frame.x, y: m.cy - frame.y, r: m.r };
}
function showWin() { if (!me.isVisible()) me.showInactive(); }
function maybeHide() { if (!menuOpen && !sayOn && !ctxOpen) { hideTip(); setIgnore(true); try { me.hide(); } catch (e) {} } }

/* 悬停说明：依次尝试 下 → 上 → 外侧 → 内侧，选第一个完整放得下的位置 */
function showTip(el, text) {
  if (!text) return;
  tipEl.textContent = text; tipEl.style.left = '-999px'; tipEl.classList.add('show');
  const b = el.querySelector('.orb').getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight, iw = innerWidth, ih = innerHeight, M = 6, G = 8;
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2, out = cx >= mewL.x ? 1 : -1;
  const cands = [[cx - w / 2, b.bottom + G], [cx - w / 2, b.top - G - h], [out > 0 ? b.right + G : b.left - G - w, cy - h / 2], [out > 0 ? b.left - G - w : b.right + G, cy - h / 2]];
  const fits = ([x, y]) => x >= M && y >= M && x + w <= iw - M && y + h <= ih - M;
  const p = cands.find(fits) || [clamp(cands[0][0], M, iw - w - M), clamp(cands[0][1], M, ih - h - M)];
  tipEl.style.left = Math.round(p[0]) + 'px'; tipEl.style.top = Math.round(p[1]) + 'px';
}
function hideTip() { tipEl.classList.remove('show'); }

function fill(el, it) {
  el.className = `mb ${it.kind}${it.mini ? ' mini' : ''}${it.on === true ? ' on' : it.on === false ? ' off' : ''}${el.classList.contains('in') ? ' in' : ''}`;
  el.querySelector('.orb').innerHTML = icon(it.icon, it.c[0], it.c[1]) + '<span class="lb"></span><i class="glint"></i>';
  el.querySelector('.lb').textContent = it.label;
  el.dataset.tip = it.tip || '';
  const n = el.querySelector('.n'); if (it.n) { n.textContent = it.n > 99 ? '99+' : String(it.n); n.style.display = ''; } else n.style.display = 'none';
}
function build(list) {
  items = list; box.replaceChildren(); hideTip();
  list.forEach((it, i) => {
    const x = it.sx - frame.x, y = it.sy - frame.y;
    const el = document.createElement('div');
    el.dataset.id = it.id;
    el.style.cssText = `left:${x}px;top:${y}px;--fx:${Math.round(mewL.x - x)}px;--fy:${Math.round(mewL.y - y)}px;--c1:${it.c[0]};--c2:${it.c[1]};--d:${(i * 0.43).toFixed(2)}s;--i:${i}`;
    el.innerHTML = '<i class="ring"></i><div class="orb"></div><b class="n"></b>';
    for (const [l, t, d] of [['8%', '6%', 0.2], ['84%', '22%', 1.3], ['70%', '86%', 2.1]].slice(0, it.kind === 'back' ? 0 : 2 + (i % 2))) {
      const st = document.createElement('i'); st.className = 'tw'; st.innerHTML = STAR;
      st.style.cssText = `left:${l};top:${t};--td:${(d + i * 0.37) % 2.8}s`; el.append(st);
    }
    fill(el, it);
    el.addEventListener('mouseenter', () => { if (el.classList.contains('in')) showTip(el, el.dataset.tip); });
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('click', e => { e.stopPropagation(); hideTip(); pick(it, el); });
    box.append(el);
  });
}
async function animIn() {
  const els = [...box.children];
  els.forEach((el, i) => { el.style.transitionDelay = i * 40 + 'ms'; el.classList.add('in'); });
  await wait(520 + els.length * 40);
  els.forEach(el => { el.style.transitionDelay = ''; });
}
async function animOut(fast) {
  hideTip();
  const els = [...box.children].filter(el => !el.classList.contains('picked'));
  if (!els.length) return;
  if (fast) { box.replaceChildren(); return; }
  els.reverse().forEach((el, i) => { el.style.transitionDelay = i * 22 + 'ms'; el.classList.remove('in'); el.classList.add('out'); });
  await wait(250 + els.length * 22);
}
async function closeMenu(fast, silent) {
  if (!menuOpen) return;
  await animOut(fast); box.replaceChildren(); menuOpen = false; busy = false;
  clearTimeout(idleT); clearTimeout(leaveT); maybeHide();
  if (!silent) tell('closed');
}
function pick(it, el) {
  if (busy) return; armIdle();
  if (it.kind === 'cat' || it.kind === 'back' || it.stay) { tell('click', { id: it.id }); return; }
  busy = true; el.classList.add('picked'); tell('click', { id: it.id });
  enqueue(async () => { await Promise.all([animOut(), wait(320)]); await closeMenu(true); });
}

/* 说话气泡 */
function positionSay() {
  const w = sayEl.offsetWidth, h = sayEl.offsetHeight, iw = innerWidth, ih = innerHeight, M = 6, G = 10;
  let top = mewL.y - mewL.r - G - h, below = false;
  if (top < M) { top = mewL.y + mewL.r + G; below = true; }
  top = clamp(top, M, ih - h - M);
  const left = clamp(mewL.x - w / 2, M, iw - w - M);
  sayEl.style.left = Math.round(left) + 'px'; sayEl.style.top = Math.round(top) + 'px';
  sayEl.classList.toggle('below', below);
  sayEl.style.setProperty('--tx', Math.round(clamp(mewL.x - left, 20, w - 20)) + 'px');
}
async function openSay(m) {
  if (menuOpen) await closeMenu(true, true);
  clearInterval(tickTimer); clearTimeout(sayTimer);
  await placeFrame(m.mew, m.wa);
  $('st').textContent = m.title || ''; $('ss').textContent = m.sub || ''; sayAction = m.action || null;
  positionSay(); showWin(); sayOn = true; sayEl.classList.add('show');
}
function hideSay(silent) {
  clearInterval(tickTimer); clearTimeout(sayTimer);
  if (!sayOn) return;
  sayOn = false; sayEl.classList.remove('show');
  setTimeout(maybeHide, 220);
  if (!silent) tell('say-closed');
}
$('sx').addEventListener('click', e => { e.stopPropagation(); hideSay(); });
sayEl.addEventListener('click', () => { const a = sayAction; hideSay(true); tell('say-click', { action: a }); });

/* 右键卡片：在鼠标位置弹出，优先右下，放不下就翻到左 / 上 */
function openCtx(m) {
  // 界面颜色统一用 tokens.css（1.3.1），不再跟着形象变
  const hd = document.createElement('div'); hd.className = 'hd';
  hd.innerHTML = '<div class="morb"></div><div><b></b><small></small></div>';
  hd.querySelector('b').textContent = m.name || 'JM Desk'; hd.querySelector('small').textContent = m.sub || '';
  ctxEl.replaceChildren(hd);
  for (const it of m.items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; ctxEl.append(s); continue; }
    const el = document.createElement('div'); el.className = 'ci' + (it.danger ? ' danger' : '');
    el.innerHTML = icon(it.icon, ...(it.danger ? ['#e11d48', '#e11d48'] : ['#ec4899', '#3b82f6'])) /* tokens.css 的 --red / --pink / --blue（innerHTML 里的 SVG 渐变要写具体色值） */ + '<span></span>' + (it.toggle != null ? `<i class="tg${it.toggle ? ' on' : ''}"></i>` : '');
    el.querySelector('span').textContent = it.label;
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (it.confirm && !el.classList.contains('armed')) { el.classList.add('armed'); el.querySelector('span').textContent = it.confirm; return; }
      if (it.toggle != null) { el.querySelector('.tg').classList.toggle('on'); tell('ctx', { id: it.id }); setTimeout(() => closeCtx(), 380); return; }
      tell('ctx', { id: it.id }); closeCtx();
    });
    ctxEl.append(el);
  }
  const w = ctxEl.offsetWidth, h = ctxEl.offsetHeight, iw = innerWidth, ih = innerHeight, M = 6;
  const px = m.x - frame.x, py = m.y - frame.y;
  const left = px + w + M <= iw ? px : Math.max(M, px - w), top = py + h + M <= ih ? py : Math.max(M, py - h);
  ctxEl.style.left = Math.round(clamp(left, M, iw - w - M)) + 'px'; ctxEl.style.top = Math.round(clamp(top, M, ih - h - M)) + 'px';
  ctxEl.style.setProperty('--ox', (left < px ? w : 0) + 'px'); ctxEl.style.setProperty('--oy', (top < py ? h : 0) + 'px');
  showWin(); ctxOpen = true; setIgnore(false);
  requestAnimationFrame(() => ctxEl.classList.add('show'));
}
function closeCtx() { if (!ctxOpen) return; ctxOpen = false; ctxEl.classList.remove('show'); clearTimeout(leaveT); setTimeout(maybeHide, 200); }

/* 消息按顺序处理，避免打开/关闭/说话交错 */
let queue = Promise.resolve();
function enqueue(fn) { queue = queue.then(fn).catch(e => console.warn('hud', e)); return queue; }
ipcRenderer.on('menu', (_e, json) => {
  const m = JSON.parse(json);
  enqueue(async () => {
    if (m.type !== 'update' && m.type !== 'ctx') closeCtx();
    if (m.type === 'open') {
      if (menuOpen) await animOut(m.transition !== 'switch');
      if (sayOn) hideSay(true);
      await placeFrame(m.mew, m.wa);
      build(m.items); showWin(); menuOpen = true; busy = false; setIgnore(false);
      await wait(34); armIdle(); animIn();
    } else if (m.type === 'update') {
      for (const it of m.items) { const el = box.querySelector(`[data-id="${it.id}"]`); if (el) fill(el, { ...items.find(x => x.id === it.id), ...it }); }
    } else if (m.type === 'close') { await closeMenu(m.instant, true); }
    else if (m.type === 'say') {
      await openSay(m);
      if (m.ms) sayTimer = setTimeout(() => hideSay(), m.ms);
    } else if (m.type === 'ticker') {
      const list = (m.items || []).slice(-12); let i = 0;
      await openSay({ ...m, sub: list[0] || m.tail || '' });
      tickTimer = setInterval(() => {
        i++; const ss = $('ss');
        if (i < list.length) { ss.classList.remove('roll'); void ss.offsetWidth; ss.textContent = list[i]; ss.classList.add('roll'); return; }
        clearInterval(tickTimer); ss.textContent = m.tail || `共 ${(m.items || []).length} 条`;
        clearTimeout(sayTimer); sayTimer = setTimeout(() => hideSay(), 8000);
      }, 2400);
    } else if (m.type === 'unsay') hideSay(true);
    else if (m.type === 'ctx') {
      if (menuOpen) await closeMenu(true, true);
      if (sayOn) hideSay(true);
      await placeFrame(m.mew, m.wa); openCtx(m);
    } else if (m.type === 'unctx') closeCtx();
  });
});

/* 鼠标：菜单打开时，除了精灵本体（穿透给精灵窗口）都由提示层接收，点空白处收起；
 * 只有说话气泡时，只有气泡本身接收鼠标，其余全部穿透 */
function inEl(e, el) { const r = el.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; }
document.addEventListener('mousemove', e => {
  const overMew = Math.hypot(e.clientX - mewL.x, e.clientY - mewL.y) <= mewL.r;
  if (ctxOpen) { clearTimeout(leaveT); setIgnore(overMew && !inEl(e, ctxEl)); }
  else if (menuOpen) { clearTimeout(leaveT); armIdle(); setIgnore(overMew); }
  else if (sayOn) setIgnore(!inEl(e, sayEl));
  else setIgnore(true);
});
document.addEventListener('mouseleave', () => { hideTip(); if (ctxOpen) { clearTimeout(leaveT); leaveT = setTimeout(closeCtx, 1800); } if (menuOpen) { clearTimeout(leaveT); leaveT = setTimeout(() => enqueue(() => closeMenu()), 2200); } });
document.addEventListener('pointerdown', e => { if (ctxOpen && !e.target.closest('#ctx')) closeCtx(); if (menuOpen && !e.target.closest('.mb') && !e.target.closest('#say')) enqueue(() => closeMenu()); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCtx(); enqueue(() => closeMenu()); } });
setIgnore(true);
tell('ready');
