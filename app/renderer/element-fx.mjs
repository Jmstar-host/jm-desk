// Screen-space accents follow the pet inside its transparent desktop window.
const TAU = Math.PI * 2;
const clamp01 = x => Math.max(0, Math.min(1, x));

function path(g, points, color, width) {
  g.beginPath();
  points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
  g.strokeStyle = color;
  g.lineWidth = width;
  g.stroke();
}

function ellipse(g, x, y, rx, ry, color, width = 0) {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, TAU);
  if (width) { g.strokeStyle = color; g.lineWidth = width; g.stroke(); }
  else { g.fillStyle = color; g.fill(); }
}

function fireflies(g, t) {
  for (let i = 0; i < 3; i++) {
    const u = clamp01((t - i * 0.09) / 0.8);
    if (u <= 0 || u >= 1) continue;
    const pos = s => [s * 115 - 40, -8 - 25 * Math.sin(s * Math.PI * 1.45 + i * 0.52) + 9 * Math.sin(s * 9 + i)];
    const trail = Array.from({ length: 12 }, (_, j) => pos(Math.max(0, u - (11 - j) * 0.016)));
    path(g, trail, '#c03e38', 6);
    path(g, trail.slice(3), '#ff973c', 3);
    const [x, y] = pos(u);
    ellipse(g, x, y, 3.4, 2.8, '#fff2a6');
    const [sx, sy] = trail[2];
    ellipse(g, sx - 1, sy + 5, 1.7, 1.7, '#ffad47');
  }
}

function tide(g, t) {
  for (let i = 0; i < 3; i++) {
    const u = (t - i * 0.12) / 0.75;
    if (u <= 0 || u >= 1) continue;
    const r = 8 + u * 67;
    g.save(); g.globalAlpha *= (1 - u);
    ellipse(g, 0, 19, r, r * 0.32, '#056b97', 5);
    ellipse(g, 0, 18, r, r * 0.32, '#81efff', 2);
    g.restore();
  }
  for (let i = 0; i < 10; i++) {
    const u = clamp01((t - (i % 3) * 0.08) / 0.84), a = i * 2.4;
    const x = Math.cos(a) * (16 + u * 39), y = 11 + Math.sin(a) * 8 - u * (24 + i % 4 * 6);
    const r = 2 + (1 - u) * 3;
    ellipse(g, x, y, r, r, '#168db6', 2);
    ellipse(g, x - r * 0.35, y - r * 0.4, 1.1, 1.1, '#dcfcff');
  }
}

function forks(g, t) {
  const span = Math.sin(Math.PI * t) * 66;
  for (const side of [-1, 1]) {
    const stem = Array.from({ length: 10 }, (_, j) =>
      [side * (7 + span * j / 9), -8 + Math.sin(j * 3.7 + side + t * 7) * (3 + j * 0.7)]);
    path(g, stem, '#7240bb', 5);
    path(g, stem, '#f2cfff', 2);
    for (const j of [4, 7]) {
      const [x, y] = stem[j], h = j === 4 ? -1 : 1;
      const branch = [[x, y], [x + side * 4, y + h * 7], [x + side * 3, y + h * 11], [x + side * 12, y + h * 17]];
      path(g, branch, '#ab6bdd', 3);
      path(g, branch, '#f8defd', 1);
    }
  }
}

function leaves(g, t) {
  for (let i = 0; i < 8; i++) {
    const a = i * TAU / 8 + t * TAU * 1.1;
    const orbit = s => [Math.cos(s) * (36 + 22 * Math.sin(t * Math.PI)), Math.sin(s) * 23 - 8 * Math.cos(2 * s)];
    const [x, y] = orbit(a);
    path(g, [orbit(a - 0.38), orbit(a - 0.19), [x, y]], '#3e9875', 1.6);
    g.save(); g.translate(x, y); g.rotate(a + 1.05);
    g.fillStyle = i % 2 ? '#95d45d' : '#33ba87';
    g.strokeStyle = '#26674d'; g.lineWidth = 1.3;
    g.beginPath(); g.moveTo(-8, 0); g.quadraticCurveTo(-1, -7, 9, 0);
    g.quadraticCurveTo(0, 7, -8, 0); g.fill(); g.stroke();
    path(g, [[-5, 0], [5, 0]], '#d3ed8e', 1);
    g.restore();
  }
}

function crystals(g, t) {
  const bloom = Math.sin(Math.PI * t) ** 1.5;
  for (let i = 0; i < 8; i++) {
    const a = i * TAU / 8 + t * 0.22, r = 11 + 44 * bloom;
    g.save();
    g.translate(Math.cos(a) * r, Math.sin(a) * r * 0.82);
    g.rotate(a);
    const s = 5 + 6 * bloom;
    g.beginPath(); g.moveTo(-s, 0); g.lineTo(0, -s * 0.43); g.lineTo(s, 0); g.lineTo(0, s * 0.43); g.closePath();
    g.fillStyle = '#88d9ec'; g.fill(); g.strokeStyle = '#367eaa'; g.lineWidth = 1.4; g.stroke();
    path(g, [[-s * 0.6, 0], [0, -s * 0.28], [s * 0.8, 0]], '#edffff', 1.7);
    g.restore();
  }
}

const effects = { fireflies, tide, forks, leaves, crystals };
export const elementSkillNames = Object.freeze(Object.keys(effects));

export function createElementFx(host, reducedMotion) {
  let canvas, ctx;
  const active = [];
  function play(name, direction) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      ctx = canvas.getContext('2d');
      host.appendChild(canvas);
    }
    if (active.length === 3) active.shift();
    active.push({ name, direction, start: performance.now() });
  }
  function draw(now, centerX, centerY) {
    if (!active.length) return;
    const w = host.clientWidth, h = host.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(w * dpr), py = Math.round(h * dpr);
    if (canvas.width !== px || canvas.height !== py) { canvas.width = px; canvas.height = py; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, py);
    const scale = dpr * Math.min(w, h) / 205;
    for (let i = active.length - 1; i >= 0; i--) {
      const cast = active[i], t = Math.max(0, now - cast.start) / (reducedMotion ? 550 : 1550);
      if (t >= 1) { active.splice(i, 1); continue; }
      const facing = cast.name === 'fireflies' ? cast.direction : 1;
      ctx.setTransform(scale * facing, 0, 0, scale, centerX * dpr, centerY * dpr);
      ctx.globalAlpha = Math.min(1, (1 - t) * 5, t * 16);
      ctx.lineCap = ctx.lineJoin = 'round';
      effects[cast.name](ctx, reducedMotion ? 0.5 : t);
    }
  }
  return { play, draw, get active() { return active.length > 0; }, dispose() { active.length = 0; canvas?.remove(); } };
}
