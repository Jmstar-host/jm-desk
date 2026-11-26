/* 访客精灵：好友的精灵飞到我的桌面上，落在我的精灵旁边；问我要不要帮它找，找到后抱着星光包裹飞走。
 * 窗口 300×380（上面气泡、下面舞台），只移动不改大小；除了气泡，鼠标都穿透。 */
import { createSprite } from './engine.mjs';
const { ipcRenderer } = require('electron');
const q = new URLSearchParams(location.search);
const remote = require(require('path').join(q.get('rp') || '', 'node_modules', '@electron', 'remote'));
const win = remote.getCurrentWindow();
const $ = id => document.getElementById(id);
const V = JSON.parse(q.get('v') || '{}'); // { id, name, ask, trusted, look: { palette, theme }, home: { x, y }, wa: { x, y, width, height } }
const W = 300, SX = 150, SY = 260; // 舞台中心在窗口里的位置
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1.3.1 起界面颜色统一用 tokens.css，不再跟着对方形象的主色变
const mew = createSprite($('stage'), { camZ: 4.7 * 220 / 170, roam: 0.22, followPointer: false, palette: V.look?.palette || {} });
mew.fps(60); window.__visitor = { mew, V };
$('tag').textContent = `${V.name} 的精灵`;

/* 鼠标：只有气泡接收，其余穿透 */
let ignoring = null;
const setIgnore = v => { if (v !== ignoring) { ignoring = v; win.setIgnoreMouseEvents(v, { forward: true }); } };
setIgnore(true);
document.addEventListener('mousemove', e => { const s = $('say'), r = s.getBoundingClientRect(); setIgnore(!(s.classList.contains('show') && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)); });

function say(title, text, buttons = []) {
  $('st').textContent = title; $('sp').textContent = text || '';
  $('btns').replaceChildren(...buttons.map(([label, cls, fn]) => { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.onclick = fn; return b; }));
  $('btns').style.display = buttons.length ? '' : 'none'; $('say').classList.add('show');
}
const unsay = () => $('say').classList.remove('show');

/* 飞到 (x, y)（窗口左上角，屏幕坐标），带缓动；边飞边告诉引擎速度，身体会朝前倾 */
let pos = { x: 0, y: 0 }, gen = 0;
function fly(x, y, ms) {
  const from = { ...pos }, t0 = performance.now(), my = ++gen; // 新的飞行会打断旧的
  return new Promise(res => {
    let last = { ...from }, lt = t0;
    const step = now => {
      if (my !== gen) return res();
      const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const hop = Math.sin(k * Math.PI) * -40; // 弧线飞行
      pos = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e + hop };
      const dt = Math.max(1, now - lt) / 1000; mew.travel((pos.x - last.x) / dt, (pos.y - last.y) / dt); last = { ...pos }; lt = now;
      try { win.setPosition(Math.round(pos.x), Math.round(pos.y)); } catch {}
      if (k < 1) requestAnimationFrame(step); else { mew.travel(0, 0); res(); }
    };
    requestAnimationFrame(step);
  });
}

/* 落点：在我的精灵旁边（左边放得下就左边，否则右边），从屏幕的远侧飞进来 */
const wa = V.wa || { x: 0, y: 0, width: screen.width, height: screen.height };
const home = V.home || { x: wa.x + wa.width - 260, y: wa.y + wa.height - 260 };
const hc = { x: home.x + 110, y: home.y + 110 };
const left = hc.x - 200 - SX >= wa.x;
const land = { x: Math.round(hc.x + (left ? -200 : 200) - SX), y: Math.round(Math.max(wa.y, Math.min(wa.y + wa.height - 380, hc.y - SY + 6))) };
const entry = { x: left ? wa.x - W + 60 : wa.x + wa.width - 60, y: land.y - 120 };

async function arrive() {
  pos = { ...entry }; win.setPosition(entry.x, entry.y); win.showInactive();
  mew.skill('appear'); mew.trick('dash');
  await fly(land.x, land.y, REDUCED ? 300 : 1500);
  document.body.classList.add('landed'); mew.trick('wave');
  ipcRenderer.send('visitor:landed', V.id);
  await sleep(500);
  // 让主人一眼看清：谁来的、想找哪一块、具体要什么
  const want = V.scope ? `想从「${V.scope}」里找：${V.ask}` : `想找：${V.ask}`;
  if (V.trusted) say(`${V.name} 的精灵来串门`, `${want}（已信任，直接帮它找）`);
  else say(`${V.name} 的精灵来串门`, want, [['帮它找', 'pri', () => decide(true)], ['请它回去', '', () => decide(false)]]);
}
function decide(ok) { $('btns').replaceChildren(); ipcRenderer.send('visitor:decide', V.id, ok); }

async function search() {
  say(V.scope ? `正在「${V.scope}」里找…` : '正在你这儿找…', V.ask, [['请它回去', '', () => { $('btns').replaceChildren(); ipcRenderer.send('visitor:dismiss', V.id); }]]); $('seek').classList.add('on'); mew.cast(true);
  // 找东西时在原地附近转一转
  const c = { ...land };
  for (let i = 0; i < 2 && !leaving; i++) { await fly(c.x + (left ? -40 : 40), c.y - 20, 900); if (leaving) break; await fly(c.x, c.y, 900); }
}
let leaving = false;
async function leave(carry) {
  leaving = true; $('seek').classList.remove('on'); mew.cast(false);
  if (carry) { say('找到啦，带回去～', '谢谢主人'); $('parcel').classList.add('on'); mew.trick('loop'); }
  else { say('那我先回去啦', '下次再来玩'); mew.trick('wave'); }
  await sleep(1500); unsay(); document.body.classList.remove('landed');
  mew.trick('dash'); await fly(entry.x, entry.y - 60, REDUCED ? 300 : 1300);
  mew.skill('vanish'); await sleep(450);
  ipcRenderer.send('visitor:gone', V.id);
}

ipcRenderer.on('visitor', (_e, m) => { if (m.type === 'search') search(); else if (m.type === 'leave') leave(!!m.carry); });
arrive();
