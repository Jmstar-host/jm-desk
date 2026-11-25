/* JM Desk 精灵窗口（原悬浮精灵）：窗口只有精灵泡泡那么大（170×170），透明角落鼠标穿透；
 * 弹气泡时临时把窗口向上（或向下，看当前屏幕剩余空间）撑大；
 * 拖动由本窗口直接移动自己，按鼠标所在屏幕限制边界，支持多屏自由摆放。 */
import { createSprite } from './engine.mjs';
const { ipcRenderer } = require('electron');
let remote = null;
try { remote = require('@electron/remote'); } catch (e) {
  try { remote = require(require('path').join(new URLSearchParams(location.search).get('rp') || '', 'node_modules', '@electron', 'remote')); } catch (e2) { console.warn('float: remote unavailable', e2); }
}
const win = remote?.getCurrentWindow();
const $ = id => document.getElementById(id);
const send = (type, data = {}) => ipcRenderer.send('jm-buddy-float', JSON.stringify({ type, ...data }));
const MEW = 220; // 精灵窗口 = 舞台本身，只移动不改大小
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const character = ipcRenderer.sendSync('jm:character'); // { id, params }
let FXURL = {}; try { FXURL = ipcRenderer.sendSync('jm:fx') || {}; } catch (e) {} // 技能特效素材包（DATA/extensions/fx/）
const mew = createSprite($('stage'), { camZ: 4.7 * MEW / 170, roam: 0.22, followPointer: false, palette: character && character.params, pack: character && character.pack, fx: FXURL });
window.__mew = mew;
mew.fps(60);

let anchor = { x: window.screenX, y: window.screenY }; // 精灵方块左上角（屏幕坐标）
let bubbleOn = false, bubbleTimer = null, bubbleAction = null, drag = null, raf = 0;
let menuOn = false, menuLevel = 'root', clickTimer = null, lastClickAt = 0; // 点击精灵弹出的气泡菜单
const counts = { unread: 0, tasks: 0 };
/* 1.7.0：电脑忙闲（主进程每 2 秒推一次）和精灵的动作设置 */
let LOAD = { cpu: null, mem: null, tempo: 1 }, BOOST = 1, CFG = { hoverMenu: true, flyCast: true, motion: 'cpu' };
ipcRenderer.invoke('sprite:cfg').then(c => { if (c) CFG = c; }).catch(() => {});
let hoverT = null, menuByHover = false, menuOpenedAt = 0;

/* 显示器信息由主进程推过来（启动时取一次，显示器变化时更新），这里只在本地算。
 * 以前每一帧都经 remote 同步问主进程「这个点在哪块屏幕」「把窗口挪到这」：主进程一忙（读文件、连接入、汇总），精灵就卡住，忙完又跳一下。 */
let DISPLAYS = [], PRIMARY = null;
function setDisplays(v) { DISPLAYS = (v && v.all) || []; PRIMARY = DISPLAYS.find(d => d.id === v.primary) || DISPLAYS[0] || null; }
try { setDisplays(ipcRenderer.sendSync('jm:displays')); } catch (e) {}
ipcRenderer.on('jm:displays', (_e, v) => setDisplays(v));
function displayAt(x, y) {
  let best = null, bd = Infinity;
  for (const d of DISPLAYS) { const b = d.bounds, dx = Math.max(b.x - x, 0, x - (b.x + b.width)), dy = Math.max(b.y - y, 0, y - (b.y + b.height)), q = dx * dx + dy * dy; if (q < bd) { bd = q; best = d; } }
  return best;
}
/* 挪窗口：单向消息，不等主进程回话 */
const moveTo = (x, y) => ipcRenderer.send('jm:move', x, y);
/* 泡泡始终完整在屏幕内。窗口本身只允许伸到「外面没有别的显示器」的左 / 右 / 下边：
 * 顶边会被系统压回菜单栏下面，跨到相邻显示器（缩放不同）时系统会把窗口挪走，所以这两种都不允许。 */
let dispCache = null, dispAt = 0;
function allDisplays() { return DISPLAYS; }
function sideFree(d, side) {
  const b = d.bounds;
  return !allDisplays().some(o => {
    if (o.id === d.id) return false; const q = o.bounds;
    const vOv = q.y < b.y + b.height && q.y + q.height > b.y, hOv = q.x < b.x + b.width && q.x + q.width > b.x;
    if (side === 'left') return Math.abs(q.x + q.width - b.x) < 2 && vOv;
    if (side === 'right') return Math.abs(q.x - b.x - b.width) < 2 && vOv;
    return Math.abs(q.y - b.y - b.height) < 2 && hOv;
  });
}
function clampAnchor(a, px, py) {
  const d = displayAt(px ?? a.x + MEW / 2, py ?? a.y + MEW / 2); if (!d) return a;
  const wa = d.workArea, hc = mew.hitCircle(true);
  const l = hc.x - hc.r, r = MEW - (hc.x + hc.r), bt = MEW - (hc.y + hc.r);
  const minX = wa.x - (sideFree(d, 'left') ? l : 0), maxX = wa.x + wa.width - MEW + (sideFree(d, 'right') ? r : 0);
  const minY = wa.y, maxY = wa.y + wa.height - MEW + (sideFree(d, 'bottom') ? bt : 0);
  return { x: clamp(a.x, minX, maxX), y: clamp(a.y, minY, maxY) };
}
function setBounds(x, y, w, h) {
  moveTo(Math.round(x), Math.round(y));
}
function place(el, x, y) { el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px'; }

/* 角标：贴在泡泡右上 45° 的边上（用泡泡静止位置，不随精灵飘动而跳），
 * 并保证整个角标落在窗口和当前屏幕可见区域内；被右/上边挡住时换到左上或贴进泡泡里。 */
let win0 = { x: 0, y: 0 }, stage0 = { x: 0, y: 0 };
function placeBadge() {
  const b = $('badge'); if (b.style.display === 'none') return;
  const hc = mew.hitCircle(true), bw = b.offsetWidth || 24, bh = b.offsetHeight || 20, k = Math.SQRT1_2 * hc.r * 0.92;
  const winW = window.innerWidth, winH = window.innerHeight;
  const d = displayAt(win0.x + stage0.x + hc.x, win0.y + stage0.y + hc.y);
  const wa = d ? d.workArea : { x: -1e5, y: -1e5, width: 2e5, height: 2e5 };
  // 可用范围 = 窗口 ∩ 屏幕（换算到窗口坐标）
  const minX = Math.max(0, wa.x - win0.x), maxX = Math.min(winW, wa.x + wa.width - win0.x) - bw;
  const minY = Math.max(0, wa.y - win0.y), maxY = Math.min(winH, wa.y + wa.height - win0.y) - bh;
  const cx = stage0.x + hc.x, cy = stage0.y + hc.y;
  const spots = [[cx + k, cy - k], [cx - k, cy - k], [cx + k, cy + k], [cx - k, cy + k]]; // 右上 → 左上 → 右下 → 左下
  let x, y;
  for (const [px, py] of spots) { x = px - bw / 2; y = py - bh / 2; if (x >= minX && x <= maxX && y >= minY && y <= maxY) break; }
  place(b, clamp(x, minX, Math.max(minX, maxX)), clamp(y, minY, Math.max(minY, maxY)));
}
function layout() { try { layoutInner(); } catch (e) { window.__floatErr = String(e.stack || e); } }
function layoutInner() {
  setBounds(anchor.x, anchor.y, MEW, MEW);
  win0 = { x: Math.round(anchor.x), y: Math.round(anchor.y) }; stage0 = { x: 0, y: 0 }; placeBadge();
}
/* 说话气泡画在以精灵为中心的提示层里（float/menu.html），精灵窗口不变 */
function hudGeo() {
  const hc = mew.hitCircle(true), cx = anchor.x + hc.x, cy = anchor.y + hc.y, d = displayAt(cx, cy);
  return { mew: { cx: Math.round(cx), cy: Math.round(cy), r: Math.round(hc.r) }, wa: d ? d.workArea : { x: -1e5, y: -1e5, width: 2e5, height: 2e5 } };
}
function say(title, sub, { ms = 9000, action = null } = {}) {
  bubbleAction = action;
  if (drag) return;
  if (menuOn) closeMenu(null, true);
  bubbleOn = true; sendOv({ type: 'say', title, sub: sub || '', ms, action, ...hudGeo() });
}
function closeBubble() { if (!bubbleOn) return; bubbleOn = false; sendOv({ type: 'unsay' }); }

/* 鼠标穿透：只有泡泡圆形和气泡接收鼠标 */
let ignoring = null;
function setIgnore(v) { if (v === ignoring || !win) return; ignoring = v; win.setIgnoreMouseEvents(v, { forward: true }); }
function overMew(e) {
  const r = $('stage').getBoundingClientRect(), hc = mew.hitCircle();
  return Math.hypot(e.clientX - (r.left + hc.x), e.clientY - (r.top + hc.y)) <= hc.r;
}
let hovering = false;
document.addEventListener('mousemove', e => {
  mew.pointer(e.clientX, e.clientY); B.lastUser = performance.now();
  if (drag) return;
  const om = overMew(e);
  setIgnore(!om);
  if (om !== hovering) {
    hovering = om; mew.hover(om); clearTimeout(hoverT);
    // 1.8.1：鼠标放在精灵上不再打开气泡，点击才打开（悬停展开改在气泡层：停在分组气泡上自动展开下一级）
  }
});
document.addEventListener('mouseleave', () => { clearTimeout(hoverT); if (!drag) { setIgnore(true); if (hovering) { hovering = false; mew.hover(false); } } });

/* 拖动：按住泡泡拖；移动不到 4 像素算点击 */
$('stage').addEventListener('pointerdown', e => {
  if (e.button !== 0 || !overMew(e)) return;
  clearTimeout(hoverT);
  drag = { sx: e.screenX, sy: e.screenY, ax: anchor.x, ay: anchor.y, lx: e.screenX, ly: e.screenY, moved: false, id: e.pointerId };
  try { $('stage').setPointerCapture(e.pointerId); } catch (err) {}
});
$('stage').addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  if (e.buttons === 0) return endDrag(e); // 松开事件丢失时兜底
  const dx = e.screenX - drag.sx, dy = e.screenY - drag.sy;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 4) return;
    drag.moved = true; document.body.classList.add('dragging');
    if (menuOn) closeMenu(null, true);
    if (bubbleOn) closeBubble();
  }
  mew.nudge(e.screenX - drag.lx, e.screenY - drag.ly); drag.lx = e.screenX; drag.ly = e.screenY;
  anchor = clampAnchor({ x: drag.ax + dx, y: drag.ay + dy }, e.screenX, e.screenY); // 按鼠标所在的屏幕限制
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; layout(); });
});
const endDrag = e => {
  if (!drag || e.pointerId !== drag.id) return;
  const moved = drag.moved; drag = null; document.body.classList.remove('dragging');
  if (moved) { anchor = clampAnchor(anchor); layout(); send('savePos', anchor); brainStay(45000); return; }
  // 气泡里有新邮件提醒时，点精灵直接打开那封邮件；否则立刻弹出气泡菜单（不再等双击判定，双击时再收起）
  if (bubbleOn && bubbleAction) { closeBubble(); send('action', bubbleAction); return; }
  const now = performance.now(); if (now - lastClickAt < 320) { lastClickAt = 0; return; } lastClickAt = now; // 双击的第二下交给 dblclick
  if (!menuOn) openMenu('root'); else if (menuLevel !== 'root') switchLevel('root'); else if (menuByHover && now - menuOpenedAt < 1500) return; else closeMenu(); // 刚因为悬停打开的，点一下不要又收起来
};
$('stage').addEventListener('pointerup', endDrag);
$('stage').addEventListener('pointercancel', endDrag);
function resetCorner() {
  if (!PRIMARY) return;
  const wa = PRIMARY.workArea; const c = clampAnchor({ x: 1e7, y: 1e7 }, wa.x + wa.width / 2, wa.y + wa.height / 2);
  anchor = { x: c.x - 10, y: c.y - 10 }; layout(); send('savePos', anchor); mew.trick('loop'); brainStay(30000);
}
$('stage').addEventListener('dblclick', () => { clearTimeout(clickTimer); if (menuOn) closeMenu(null, true); resetCorner(); });

ipcRenderer.on('jm', (_e, json) => {
  const m = JSON.parse(json);
  if (m.type === 'mail') { mew.trick('loop'); say(m.title, m.sub, { ms: 15000, action: m.action }); }
  else if (m.type === 'ticker') { if (drag) return; if (menuOn) closeMenu(null, true); bubbleOn = true; bubbleAction = m.action; mew.trick('wave'); sendOv({ type: 'ticker', title: m.title, items: m.items || [], tail: m.tail, action: m.action, ...hudGeo() }); }
  else if (m.type === 'say') { mew.trick(m.trick || 'wave'); say(m.title, m.sub, { ms: m.ms ?? 9000, action: m.action }); }
  else if (m.type === 'badge') { const b = $('badge'); b.textContent = m.n > 999 ? '999+' : String(m.n); b.style.display = m.n ? 'block' : 'none'; placeBadge(); }
  else if (m.type === 'cast') mew.cast(!!m.on);
  else if (m.type === 'trip') { if (m.phase === 'leave') tripLeave(); else tripReturn(!!m.carry); }
  else if (m.type === 'corner') resetCorner(); // 托盘「回到右下角」：精灵跑到看不见的地方时用
  else if (m.type === 'fps') mew.fps(m.v);
  else if (m.type === 'shown') { anchor = clampAnchor({ x: window.screenX, y: window.screenY }); layout(); brainReset(); }
  else if (m.type === 'cfg') { cfgMode = m.mode || cfgMode; }
  else if (m.type === 'counts') { counts.unread = m.unread || 0; counts.tasks = m.tasks || 0; }
  else if (m.type === 'spriteCfg') { CFG = { hoverMenu: m.hoverMenu, flyCast: m.flyCast, motion: m.motion }; }
  else if (m.type === 'load') {
    LOAD = { cpu: m.cpu, mem: m.mem, tempo: m.tempo }; BOOST = REDUCED ? 1 : Math.max(1, m.tempo || 1); mew.tempo && mew.tempo(BOOST);
    if (menuOn) { const it = curItems.find(x => x.id === 'sys.load'); if (it) { curItems = menuItems(menuLevel); sendOv({ type: 'update', items: curItems.filter(x => x.id === 'sys.load').map(wire) }); } }
  }
});
/* ================= 桌面小精灵：自由活动 =================
 * 自己在桌面上飞：随机闲逛、趴在屏幕底边、从屏幕边探头、偶尔去别的显示器；
 * 鼠标凑近时会跟着你、或者害羞躲开；太久没人理会放技能（瞬移 / 念力爆发 / 绕圈 / 冲刺）。
 * 被拖动、弹气泡、鼠标停在它身上时暂停。右键菜单可关闭自由活动。 */
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
let roamOn = localStorage.getItem('jmRoam') !== '0';
let cfgMode = 'minimized';
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const B = { mode: 'idle', until: 0, target: null, speed: 380, wiggle: 0, pos: null, vel: { x: 0, y: 0 }, orbit: null, follow: false,
  cursor: null, cursorMovedAt: 0, lastUser: performance.now(), reactCd: 0, lastPoll: 0, fps: 60, lastSet: null, after: null };

function displays() { return DISPLAYS; }
function curDisplay() { return displayAt(B.pos.x + MEW / 2, B.pos.y + MEW / 2); }
function center(p = B.pos) { const hc = mew.hitCircle(true); return { x: p.x + hc.x, y: p.y + hc.y }; }
function randomAnchor(d) {
  const wa = d.workArea, a = { x: rand(wa.x, wa.x + wa.width - MEW), y: rand(wa.y, wa.y + wa.height - MEW) };
  return clampAnchor(a, wa.x + wa.width / 2, wa.y + wa.height / 2);
}
function pickDisplay() { const all = displays(), cur = curDisplay(); return all.length > 1 && Math.random() < 0.15 ? pick(all.filter(d => d.id !== cur?.id)) || cur : cur; }

function brainReset() { B.pos = { ...anchor }; B.vel = { x: 0, y: 0 }; B.target = null; B.mode = 'idle'; B.until = performance.now() + rand(2000, 5000); }
function brainStay(ms) { brainReset(); B.mode = 'stay'; B.until = performance.now() + ms; }
function idle(ms) { B.target = null; B.mode = 'idle'; B.until = performance.now() + ms / Math.min(2, BOOST); B.after = null; } // 电脑越忙，歇得越短（最多短一半）
function flyTo(a, mode = 'fly', speed = 380, wiggle = 40, after = null) { B.target = a; B.mode = mode; B.speed = speed; B.wiggle = wiggle; B.until = performance.now() + 15000; B.after = after; }

function perch() {
  const d = curDisplay(); if (!d) return idle(3000);
  const a = clampAnchor({ x: B.pos.x + rand(-300, 300), y: 1e7 }, d.workArea.x + d.workArea.width / 2, d.workArea.y + d.workArea.height / 2);
  flyTo(a, 'perch', 260, 25, () => { mew.trick('stretch'); idle(rand(10000, 20000)); });
}
function peekEdge() {
  const d = curDisplay(); if (!d) return idle(3000);
  const wa = d.workArea, left = Math.random() < 0.5;
  const a = clampAnchor({ x: left ? -1e7 : 1e7, y: B.pos.y + rand(-200, 200) }, wa.x + wa.width / 2, wa.y + wa.height / 2);
  flyTo(a, 'peek', 320, 15, () => { mew.trick('peek'); idle(rand(3500, 6000)); });
}
/* 1.8.0：边飞边放。这些技能只放特效，不打断飞行；飞着的时候 burst / sparkle 也不停下来 */
const AIR = ['psywave', 'orb', 'meteor', 'spark', 'swirl'];
const flying = () => !!B.target && Math.hypot(B.vel.x, B.vel.y) > 60;
function airCast(name) { mew.skill(name); }
/* 连招：满屏快飞，路上隔一会放一个技能，最后翻个跟头 */
function combo() {
  const d = curDisplay(); if (!d || REDUCED) return airCast('psywave');
  const seq = [...AIR].sort(() => Math.random() - 0.5); let i = 0;
  const hop = () => { if (i >= seq.length) { mew.trick('loop'); return idle(rand(1500, 3000)); } const n = seq[i++]; mew.trick('dash'); flyTo(randomAnchor(d), 'zoom', rand(900, 1300), rand(30, 70), hop); setTimeout(() => airCast(n), 180); };
  B.lastUser = performance.now(); hop();
}
let nextAir = 0;
function castSkill(name) {
  B.lastUser = performance.now();
  if (AIR.includes(name)) return airCast(name);
  if (name === 'combo') return combo();
  if ((name === 'burst' || name === 'sparkle') && flying()) { mew.skill(name); return; } // 飞着就边飞边放
  if (REDUCED) { mew.skill('sparkle'); return idle(3000); }
  if (name === 'teleport') {
    B.mode = 'skill'; B.target = null; B.vel = { x: 0, y: 0 }; B.until = performance.now() + 2000;
    mew.skill('vanish');
    setTimeout(() => {
      const a = randomAnchor(pickDisplay() || curDisplay());
      B.pos = { ...a }; anchor = { ...a }; moveWin(true);
      mew.skill('appear'); idle(rand(2500, 4500));
    }, 450);
  } else if (name === 'burst') { B.mode = 'skill'; B.target = null; B.until = performance.now() + 2600; mew.skill('burst'); }
  else if (name === 'orbit') { B.mode = 'orbit'; B.orbit = { c: center(), t0: performance.now(), r: rand(70, 110), dir: Math.random() < 0.5 ? 1 : -1 }; B.until = performance.now() + 3600; B.speed = 900; B.wiggle = 0; mew.trick('giggle'); }
  else if (name === 'zoom') {
    const d = curDisplay(); if (!d) return;
    const wa = d.workArea, left = center().x > wa.x + wa.width / 2;
    const a = clampAnchor({ x: left ? wa.x : wa.x + wa.width, y: B.pos.y + rand(-150, 150) }, wa.x + wa.width / 2, wa.y + wa.height / 2);
    mew.trick('dash'); flyTo(a, 'zoom', 1700, 0, () => { mew.trick('loop'); idle(rand(2000, 4000)); });
  } else if (name === 'sparkle') { mew.skill('sparkle'); idle(2500); }
}
function decide(now) {
  const bored = now - B.lastUser > 60000, r = Math.random();
  // 电脑很忙（倍速 2 以上）：多半直接满屏快飞，夸夸飞
  if (BOOST > 2 && r < 0.45) { const d = curDisplay(); if (d) { mew.trick(Math.random() < 0.5 ? 'dash' : 'barrel'); return flyTo(randomAnchor(d), 'zoom', rand(800, 1300), rand(40, 90), () => idle(rand(600, 1500))); } }
  if (bored && r < 0.3) return castSkill(pick(['teleport', 'burst', 'orbit', 'zoom', 'sparkle']));
  if (r < 0.08) return castSkill(pick(['burst', 'orbit', 'sparkle', 'teleport', 'zoom']));
  if (r < 0.48) { const d = curDisplay(); return d ? flyTo(randomAnchor(d), 'fly', rand(300, 480), rand(20, 60), () => idle(rand(2500, 6000))) : idle(4000); }
  if (r < 0.60) return perch();
  if (r < 0.68) return peekEdge();
  idle(rand(3000, 8000));
}

/* 鼠标凑近：跟着走 / 害羞躲开 / 探头看 */
function reactToCursor(now, c, dist) {
  B.reactCd = now + 15000; B.lastUser = now;
  const r = Math.random();
  if (r < 0.5) { B.follow = true; B.mode = 'follow'; B.until = now + 6000; B.speed = 700; B.wiggle = 10; mew.trick('wave'); }
  else if (r < 0.78) {
    const me = center(), dx = me.x - c.x, dy = me.y - c.y, k = 300 / (Math.hypot(dx, dy) || 1), hc = mew.hitCircle(true);
    const a = clampAnchor({ x: me.x + dx * k - hc.x, y: me.y + dy * k - hc.y }, c.x, c.y);
    mew.trick('barrel'); flyTo(a, 'flee', 950, 0, () => { mew.trick('giggle'); idle(rand(3000, 5000)); });
  } else { mew.trick('peek'); idle(3000); }
}
function pollCursor(now) {
  return; // 不再轮询鼠标位置：精灵不对鼠标做反应，这个查询以前每 90 毫秒同步问一次主进程，是卡顿来源之一
  let c;
  if (B.cursor && Math.hypot(c.x - B.cursor.x, c.y - B.cursor.y) > 3) { B.cursorMovedAt = now; B.lastUser = now; mew.wake(); }
  B.cursor = c;
  const me = center(), dist = Math.hypot(c.x - me.x, c.y - me.y);
  return; // 只自由活动，不对鼠标做反应（不跟随、不躲开）
  if (B.mode === 'follow') {
    if (dist > 700 || now > B.until) { B.mode = 'idle'; B.follow = false; mew.trick('wave'); idle(rand(2000, 4000)); return; }
    const hc = mew.hitCircle(true), side = me.x < c.x ? -1 : 1; // 待在鼠标旁边，不挡住它
    B.target = clampAnchor({ x: c.x + side * (hc.r + 40) - hc.x, y: c.y - 30 - hc.y }, c.x, c.y);
    return;
  }
  if (roamOn && dist < 230 && dist > 10 && now - B.cursorMovedAt < 700 && now > B.reactCd && ['idle', 'fly', 'perch'].includes(B.mode)) reactToCursor(now, c, dist);
}

function moveWin(force) {
  const c = clampAnchor(B.pos);
  if (c.x !== B.pos.x) { B.pos.x = c.x; B.vel.x = 0; } if (c.y !== B.pos.y) { B.pos.y = c.y; B.vel.y = 0; }
  const x = Math.round(B.pos.x), y = Math.round(B.pos.y);
  if (!force && B.lastSet && B.lastSet.x === x && B.lastSet.y === y) return;
  B.lastSet = { x, y }; anchor = { x: B.pos.x, y: B.pos.y };
  moveTo(x, y);
  win0 = { x, y }; placeBadge();
}
let lastT = performance.now(), saveT = 0;
function brainTick() {
  requestAnimationFrame(brainTick);
  const now = performance.now(), dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  if (!B.pos) brainReset();
  if (tripping || drag || bubbleOn || menuOn || hovering || !roamOn || REDUCED || document.hidden) {
    B.vel = { x: 0, y: 0 }; mew.travel(0, 0); if (!drag && !bubbleOn && !menuOn) B.pos = { ...anchor };
    setFps(hovering || drag ? 60 : 30); return;
  }
  pollCursor(now);
  if (B.mode === 'orbit' && B.orbit) {
    const o = B.orbit, a = (now - o.t0) / 1000 * 2.4 * o.dir, hc = mew.hitCircle(true);
    B.target = clampAnchor({ x: o.c.x + Math.cos(a) * o.r - o.r - hc.x, y: o.c.y + Math.sin(a) * o.r * 0.6 - hc.y }, o.c.x, o.c.y);
    if (now > B.until) { B.orbit = null; mew.trick('loop'); idle(rand(2000, 3500)); }
  }
  if ((B.mode === 'idle' || B.mode === 'stay' || B.mode === 'skill') && now > B.until) decide(now);
  if (B.target) {
    const dx = B.target.x - B.pos.x, dy = B.target.y - B.pos.y, dist = Math.hypot(dx, dy);
    const sp = Math.min(B.speed * BOOST, dist * 2.4 * Math.max(1, BOOST * 0.8)), ux = dx / (dist || 1), uy = dy / (dist || 1);
    const w = B.wiggle * Math.sin(now / 380) * Math.min(1, dist / 120); // 飞行路线带一点波浪
    const tx = ux * sp - uy * w, ty = uy * sp + ux * w;
    const k = Math.min(1, dt * (B.mode === 'zoom' || B.mode === 'flee' ? 5 : 3.2));
    B.vel.x += (tx - B.vel.x) * k; B.vel.y += (ty - B.vel.y) * k;
    if (dist < 3 && Math.hypot(B.vel.x, B.vel.y) < 25 && B.mode !== 'follow' && B.mode !== 'orbit') {
      B.target = null; const f = B.after; B.after = null;
      if (f) f(); else idle(rand(2500, 6000));
    } else if (now > B.until && B.mode !== 'follow' && B.mode !== 'orbit') { B.target = null; idle(3000); }
  } else { const d = Math.exp(-dt * 6); B.vel.x *= d; B.vel.y *= d; }
  B.pos.x += B.vel.x * dt; B.pos.y += B.vel.y * dt;
  const speed = Math.hypot(B.vel.x, B.vel.y);
  mew.travel(B.vel.x, B.vel.y);
  // 飞得快的时候顺手放技能：电脑越忙放得越勤（设置里可以关）
  if (CFG.flyCast && speed > 250 && now > nextAir && !REDUCED) { nextAir = now + rand(2500, 6000) / BOOST; if (Math.random() < 0.35 + 0.15 * BOOST) airCast(pick(AIR)); }
  if (speed > 0.5) moveWin(false);
  setFps(speed > 1 || B.mode === 'skill' || B.mode === 'orbit' ? 60 : 30);
  if (speed < 0.5 && now - saveT > 20000 && B.lastSet) { saveT = now; send('savePos', B.lastSet); }
}
/* ---------- 串门：出门（飞到屏幕边上消失）和回来（从边上抱着星光包裹飞回原位） ---------- */
let tripping = false, tripHome = null;
const nap = ms => new Promise(r => setTimeout(r, ms));
function tween(to, ms) {
  const from = { ...anchor }, t0 = performance.now();
  return new Promise(res => {
    let last = { ...from }, lt = t0;
    const step = now => {
      const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const p = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e + Math.sin(k * Math.PI) * -30 };
      const dt = Math.max(1, now - lt) / 1000; mew.travel((p.x - last.x) / dt, (p.y - last.y) / dt); last = p; lt = now;
      B.pos = { ...p }; anchor = { ...p };
      moveTo(Math.round(p.x), Math.round(p.y));
      placeBadge();
      if (k < 1) requestAnimationFrame(step); else { mew.travel(0, 0); res(); }
    };
    requestAnimationFrame(step);
  });
}
async function tripLeave() {
  if (tripping) return; tripping = true;
  if (menuOn) closeMenu(null, true); if (bubbleOn) closeBubble();
  tripHome = { ...anchor };
  const d = curDisplay(); if (!d) return;
  const wa = d.workArea, goLeft = center().x < wa.x + wa.width / 2;
  const edge = clampAnchor({ x: goLeft ? -1e7 : 1e7, y: anchor.y - 80 }, wa.x + wa.width / 2, wa.y + wa.height / 2);
  mew.trick('wave'); await nap(REDUCED ? 0 : 600);
  mew.trick('dash'); await tween(edge, REDUCED ? 200 : 1100);
  mew.skill('vanish'); await nap(420);
  try { win && win.hide(); } catch (e) {}
}
async function tripReturn(carry) {
  if (!tripping) { tripHome = tripHome || { ...anchor }; }
  try { win && win.showInactive(); } catch (e) {}
  mew.skill('appear'); if (carry) $('parcel').classList.add('on');
  await nap(300); mew.trick('dash');
  await tween(tripHome || anchor, REDUCED ? 200 : 1300);
  if (carry) { mew.skill('sparkle'); await nap(1200); $('parcel').classList.remove('on'); } else mew.trick('wave');
  tripping = false; brainReset(); send('savePos', { x: Math.round(anchor.x), y: Math.round(anchor.y) });
}
window.__trip = { tripLeave, tripReturn, get tripping() { return tripping; } };

function setFps(v) { if (B.fps !== v) { B.fps = v; mew.fps(v); } }
function setRoam(on) { roamOn = on; localStorage.setItem('jmRoam', on ? '1' : '0'); if (on) { brainReset(); mew.trick('loop'); } else { mew.trick('wave'); send('savePos', anchor); } }

/* 右键菜单：只放应用级入口，功能都在气泡里 */
$('stage').addEventListener('contextmenu', e => {
  e.preventDefault(); if (!remote || !overMew(e)) return;
  // 不用系统原生菜单（样式改不了）：在提示层里画一张和面板同风格的卡片
  if (bubbleOn) closeBubble();
  let info = {}; try { info = ipcRenderer.sendSync('jm:theme') || {}; } catch (er) {}
  sendOv({ type: 'ctx', x: e.screenX, y: e.screenY, theme: info.theme, name: info.name, sub: `JM Desk ${info.version || ''}`.trim(), ...hudGeo(),
    items: [
      { id: 'roam', icon: 'wing', label: '自由活动', toggle: roamOn },
      { id: 'app.desk', icon: 'chart', label: '打开 JM Desk' },
      { id: 'app.reminders', icon: 'bell', label: '提醒' },
      { id: 'app.settings', icon: 'sliders', label: '设置' },
      { id: 'app.update', icon: 'inbox', label: '检查更新' },
      { id: 'corner', icon: 'corner', label: '回到右下角' },
      { sep: true },
      { id: 'quit', icon: 'moon', label: '退出 JM Desk', danger: true, confirm: '再点一次退出' },
    ] });
});
function onCtx(id) {
  if (id === 'roam') return setRoam(!roamOn);
  if (id === 'corner') return resetCorner();
  if (id === 'quit') return send('quit');
  send('action', { id });
}
requestAnimationFrame(brainTick);

/* ================= 气泡菜单（由布局配置 layout.json 生成） =================
 * 内圈 = 分组；点一个分组，内圈缩小保留、外圈展开该分组的功能。再点同一分组收回外圈。 */
const SKILLS = {
  'skill.teleport': () => castSkill('teleport'), 'skill.burst': () => castSkill('burst'), 'skill.orbit': () => castSkill('orbit'),
  'skill.zoom': () => castSkill('zoom'), 'skill.sparkle': () => castSkill('sparkle'),
  'skill.loop': () => { mew.trick('loop'); brainStay(4000); },
  'skill.combo': () => closeMenu(() => castSkill('combo'), true), // 气泡开着时精灵不飞，先收起 'skill.psywave': () => castSkill('psywave'), 'skill.orb': () => castSkill('orb'), 'skill.meteor': () => castSkill('meteor'), 'skill.spark': () => castSkill('spark'), 'skill.swirl': () => castSkill('swirl'), 'skill.wave': () => { mew.trick('wave'); brainStay(4000); },
  'toggle.roam': () => setRoam(!roamOn), 'place.corner': () => resetCorner(),
};
let menuLayout = ipcRenderer.sendSync('jm:layout');
ipcRenderer.on('jm:layout', (_e, l) => { menuLayout = l; if (menuOn) showLevel(menuLevel, 'switch'); });
function groupOf(id) { return menuLayout.groups.find(g => g.id === id); }
function dyn(it) { // 运行时状态：开关、计数
  const o = { ...it };
  if (it.id === 'toggle.roam') { o.on = roamOn; o.icon = roamOn ? 'wing' : 'moon'; o.label = roamOn ? '自由飞' : '已停飞'; }
  if (it.count && counts[it.count]) o.n = counts[it.count];
  return o;
}
/* 「占用」气泡：中间是 CPU 百分比，下面是内存；越忙颜色越暖（绿 → 橙 → 红，色板里的颜色） */
const pct = v => v == null ? '—' : Math.round(v * 100) + '%';
function loadItem(it) {
  if (it.id !== 'sys.load') return it;
  const cpu = LOAD.cpu, c = cpu == null ? it.c : cpu > 0.85 ? ['#e11d48', '#ea580c'] : cpu > 0.6 ? ['#ea580c', '#ec4899'] : ['#16a34a', '#3b82f6'];
  return { ...it, c, meter: pct(cpu), label: '内存 ' + pct(LOAD.mem),
    tip: `CPU ${pct(cpu)} · 内存 ${pct(LOAD.mem)}${BOOST > 1.05 ? ` · 精灵现在 ${BOOST.toFixed(1)} 倍速` : ''}\n点一下打开${navigator.platform.startsWith('Mac') ? '活动监视器' : '任务管理器'}` };
}
function menuItems(level) {
  const groups = menuLayout.groups.map(g => g.action ? loadItem({ id: g.action, act: true, icon: g.icon, label: g.label, tip: g.tip, c: g.color, ring: 0, mini: level !== 'root' })
    : { id: 'g:' + g.id, icon: g.icon, label: g.label, tip: g.tip, c: g.color, go: g.id, ring: 0, mini: level !== 'root', on: level === g.id ? true : undefined });
  if (level === 'root') return groups;
  const g = groupOf(level); if (!g) return groups;
  return [...groups, ...g.items.map(it => ({ ...dyn(it), c: it.color || g.color, ring: 1 }))];
}
const kindOf = it => (it.go || it.act ? 'cat' : 'item');
const wire = it => ({ id: it.id, icon: it.icon, label: it.label, tip: it.tip, c: it.c, n: it.n || 0, on: it.on, stay: !!it.stay, kind: kindOf(it), mini: !!it.mini, go: !!it.go, ...(it.meter ? { meter: it.meter } : {}) });
let ov = null, ovReady = false, ovPending = null, curItems = [];
function overlayWin() {
  if (!remote || !win) return null;
  if (ov && !ov.isDestroyed()) return ov;
  ovReady = false;
  ov = new remote.BrowserWindow({
    x: Math.round(anchor.x), y: Math.round(anchor.y), width: 200, height: 200, frame: false, transparent: true, hasShadow: false,
    resizable: true, movable: false, alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, minimizable: false, maximizable: false,
    show: false, type: 'panel', backgroundColor: '#00000000', title: 'JM Desk 菜单',
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  ov.setAlwaysOnTop(true, 'floating');
  try { ov.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
  try { remote.require('@electron/remote/main').enable(ov.webContents); } catch (e) { console.warn('menu remote enable failed', e); }
  const u = new URL('./hud.html', location.href);
  u.searchParams.set('rp', new URLSearchParams(location.search).get('rp') || ''); u.searchParams.set('host', String(win.id));
  ov.loadURL(u.href);
  return ov;
}
function sendOv(msg) {
  const w = overlayWin(); if (!w) return;
  if (!ovReady) { ovPending = msg; return; }
  try { w.webContents.send('menu', JSON.stringify(msg)); } catch (e) {}
}
ipcRenderer.on('jm-menu', (_e, json) => {
  const m = JSON.parse(json);
  if (m.type === 'ready') { ovReady = true; if (ovPending) { const p = ovPending; ovPending = null; sendOv(p); } }
  else if (m.type === 'click') onMenuClick(m.id);
  else if (m.type === 'expand') { const it = curItems.find(x => x.id === m.id); if (menuOn && it?.go && menuLevel !== it.go) switchLevel(it.go); } // 鼠标停在分组气泡上：展开它的下一级（只展开，不收回）
  else if (m.type === 'ctx') onCtx(m.id);
  else if (m.type === 'closed') menuOn = false;
  else if (m.type === 'say-closed') bubbleOn = false;
  else if (m.type === 'say-click') { bubbleOn = false; if (m.action) send('action', m.action); }
});
window.addEventListener('beforeunload', () => { try { ov && !ov.isDestroyed() && ov.destroy(); } catch (e) {} });

/* 两圈：内圈分组、外圈功能，沿同一方向展开；优先上方，靠边时转向屏幕内侧（屏幕坐标） */
function menuGeometry(list) {
  const g = hudGeo(), { cx, cy, r } = g.mew, wa = g.wa, M = 8;
  const size = it => (kindOf(it) === 'cat' ? (it.mini ? 54 : 74) : 64);
  const rings = [list.filter(it => !it.ring), list.filter(it => it.ring)];
  const R = rings[1].length ? [r + 38, r + 38 + 84] : [r + 54, 0];
  // 内圈收紧在正上方，外圈在更大的半径上铺开，层次更清楚
  const arc = (n, rad) => (n > 1 ? (rad === R[0] && rings[1].length ? Math.min(40, 130 / (n - 1)) : rad === R[0] ? Math.min(52, 170 / (n - 1)) : Math.min(34, 300 / (n - 1))) * Math.PI / 180 : 0);
  const posFor = dir => {
    const out = new Map();
    rings.forEach((items, k) => { const n = items.length, st = arc(n, R[k]); items.forEach((it, i) => { const a = dir + (i - (n - 1) / 2) * st; out.set(it, { x: cx + Math.cos(a) * R[k], y: cy + Math.sin(a) * R[k] }); }); });
    return list.map(it => out.get(it));
  };
  const fits = (p, i) => { const h = size(list[i]) / 2 + M; return p.x - h >= wa.x && p.x + h <= wa.x + wa.width && p.y - h >= wa.y && p.y + h <= wa.y + wa.height; };
  const inward = Math.atan2(wa.y + wa.height / 2 - cy, wa.x + wa.width / 2 - cx);
  let pts = null;
  for (const dir of [-Math.PI / 2, inward, Math.PI, 0, Math.PI / 2]) { const p = posFor(dir); if (p.every(fits)) { pts = p; break; } }
  if (!pts) pts = posFor(inward).map((p, i) => { const h = size(list[i]) / 2 + M; return { x: clamp(p.x, wa.x + h, wa.x + wa.width - h), y: clamp(p.y, wa.y + h, wa.y + wa.height - h) }; });
  return { ...g, pts: pts.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })), angles: pts.filter((_, i) => list[i].ring || rings[1].length === 0).map(p => Math.atan2(p.y - cy, p.x - cx)) };
}
function showLevel(level, transition) {
  menuLevel = level; curItems = menuItems(level);
  const g = menuGeometry(curItems);
  sendOv({ type: 'open', transition, hover: menuByHover, expand: CFG.hoverMenu !== false, mew: g.mew, wa: g.wa, items: curItems.map((it, i) => ({ ...wire(it), sx: g.pts[i].x, sy: g.pts[i].y })) });
  mew.puff && mew.puff(g.angles);
}
function openMenu(level = 'root', viaHover = false) {
  if (bubbleOn) closeBubble();
  menuByHover = !!viaHover; menuOpenedAt = performance.now();
  menuOn = true; mew.trick('wave'); showLevel(level, 'open');
}
function switchLevel(level) { if (menuOn) showLevel(level, 'switch'); }
function closeMenu(after, instant) {
  if (!menuOn) { if (after) after(); return; }
  menuOn = false; sendOv({ type: 'close', instant: !!instant });
  if (after) setTimeout(after, instant ? 0 : 260);
}
function onMenuClick(id) {
  const it = curItems.find(x => x.id === id); if (!it) return;
  if (it.go) return switchLevel(menuLevel === it.go ? 'root' : it.go);
  if (it.act) return closeMenu(() => send('action', { id })); // 第一层的直接动作（如「会议」）
  if (it.stay) { (SKILLS[id] || (() => send('action', { id })))(); curItems = menuItems(menuLevel); return sendOv({ type: 'update', items: curItems.map(wire) }); }
  menuOn = false;
  setTimeout(() => (SKILLS[id] ? SKILLS[id]() : send('action', { id })), 280);
}
setTimeout(overlayWin, 1500); // 提前建好，第一次点开也不卡

window.__float = { combo, airCast, get load() { return { ...LOAD, boost: BOOST }; }, get cfg() { return CFG; }, openMenu, closeMenu, get menuOn() { return menuOn; }, get menuLevel() { return menuLevel; }, brain: B, castSkill, setRoam, get roamOn() { return roamOn; }, remote: !!remote, win: !!win, layout, say, get anchor() { return anchor; }, get bubbleOn() { return bubbleOn; } };
setIgnore(true);
setTimeout(layout, 300);
send('ready');
