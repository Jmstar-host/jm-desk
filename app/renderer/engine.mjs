/* 精灵 3D：模型没有自带动画，全部用骨骼 + 程序动作实现
 * 自由飞行（带转弯侧倾）、随机小把戏（翻跟头/横滚/挥手/探头/咯咯笑/转圈/冲刺）、
 * 鼠标靠近会凑过来、悬停会挥手冒爱心、尾巴拖出星光、久不动会犯困。
 */
import * as THREE from './vendor/three.module.js';
import { buildLumi } from './lumi.mjs';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { DRACOLoader } from './vendor/DRACOLoader.js';

const PINK = new THREE.Color(0xff8fd0), VIOLET = new THREE.Color(0xa78bfa), CYAN = new THREE.Color(0x7dd3fc), WHITE = new THREE.Color(1, 1, 1);
const ease = k => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const bell = k => Math.sin(Math.PI * Math.min(1, Math.max(0, k)));
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

function spriteTexture(kind) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  if (kind === 'heart') {
    g.fillStyle = '#ff5fb0'; g.beginPath(); g.moveTo(32, 54);
    g.bezierCurveTo(4, 34, 10, 8, 32, 22); g.bezierCurveTo(54, 8, 60, 34, 32, 54); g.fill();
  } else {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.22, 'rgba(250,170,230,.9)'); r.addColorStop(1, 'rgba(190,120,250,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(236,72,153,.95)';
    g.beginPath(); g.moveTo(32, 2); g.lineTo(35, 29); g.lineTo(62, 32); g.lineTo(35, 35); g.lineTo(32, 62); g.lineTo(29, 35); g.lineTo(2, 32); g.lineTo(29, 29); g.closePath(); g.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* 粒子池：每个粒子有自己的位置、速度、寿命、大小、颜色、透明度 */
function particlePool(scene, max, tex, blending = THREE.NormalBlending) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3), col = new Float32Array(max * 3), alpha = new Float32Array(max), size = new Float32Array(max);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending, vertexColors: true,
    uniforms: { uMap: { value: tex }, uScale: { value: 300 } },
    vertexShader: `attribute float aAlpha; attribute float aSize; varying float vA; varying vec3 vC;
      uniform float uScale; void main(){ vA = aAlpha; vC = color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform sampler2D uMap; varying float vA; varying vec3 vC;
      void main(){ vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(t.rgb * vC, t.a * vA); if (gl_FragColor.a < 0.01) discard; }`,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; scene.add(pts);
  const P = Array.from({ length: max }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 0.1, c: WHITE, g: 0 }));
  let next = 0;
  return {
    emit(x, y, z, o = {}) {
      const p = P[next]; next = (next + 1) % max;
      Object.assign(p, { x, y, z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, life: o.life || 1, max: o.life || 1, s: o.size || 0.12, c: o.color || WHITE, g: o.gravity || 0 });
    },
    update(dt) {
      for (let i = 0; i < max; i++) {
        const p = P[i];
        if (p.life > 0) { p.life -= dt; p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; }
        const k = Math.max(0, p.life / p.max);
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
        col[i * 3] = p.c.r; col[i * 3 + 1] = p.c.g; col[i * 3 + 2] = p.c.b;
        alpha[i] = p.life > 0 ? Math.min(1, k * 1.6) : 0; size[i] = p.s * (0.4 + 0.6 * k);
      }
      for (const n of ['position', 'color', 'aAlpha', 'aSize']) geo.attributes[n].needsUpdate = true;
    },
  };
}

/* opts.camZ：镜头距离（越小精灵越大）；opts.roam：在泡泡里飞行的范围（0-1） */
export function createSprite(host, opts = {}) {
  const stat = { loaded: 0, failed: 0, frames: 0, tricks: 0 };
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setClearColor(0, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const W = () => host.clientWidth || 210, H = () => host.clientHeight || 200;
  renderer.setSize(W(), H());
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, W() / H(), 0.1, 50);
  camera.position.set(0, 1.0, opts.camZ || 6.6); camera.lookAt(0, 0.95, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xf0abfc, 1.05));
  const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(2, 3, 5); scene.add(key);
  const glow = new THREE.PointLight(0xff8fd0, 1.1, 6); glow.position.set(0, 1, 1.2); scene.add(glow);

  // root：飞行位置和朝向；pivot：绕身体中心做翻滚等把戏；holder：模型
  const root = new THREE.Group(); scene.add(root);
  const pivot = new THREE.Group(); pivot.position.y = 0.95; root.add(pivot);
  const holder = new THREE.Group(); pivot.add(holder);

  /* 念力泡泡：顶点轻微起伏的半透明球，边缘发光 */
  const bubbleMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uColor: { value: PINK.clone() }, uPower: { value: 0.55 }, uTime: { value: 0 }, uWobble: { value: 0.03 } },
    vertexShader: `uniform float uTime; uniform float uWobble; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ vec3 p = position * (1.0 + uWobble * sin(position.y*6.0 + uTime*3.0) * cos(position.x*5.0 - uTime*2.3));
        vec4 mv = modelViewMatrix*vec4(p,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); vP = position; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uPower; uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.6);
        float swirl = 0.5 + 0.5*sin(vP.y*7.0 + uTime*1.8 + vP.x*5.0);
        gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.15 + swirl*0.25), (f*0.85 + 0.05 + swirl*f*0.25) * uPower); }`,
  });
  const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.9, 48, 32), bubbleMat);
  bubble.position.y = 0.95; root.add(bubble);

  /* 环绕星光 */
  const N = 36, starGeo = new THREE.BufferGeometry(), sp = new Float32Array(N * 3), seeds = [];
  for (let i = 0; i < N; i++) seeds.push({ a: Math.random() * Math.PI * 2, r: 0.8 + Math.random() * 0.45, tilt: (Math.random() - 0.5) * 1.6, sp: 0.4 + Math.random() * 0.8, y: Math.random() });
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const starMat = new THREE.PointsMaterial({ map: spriteTexture('star'), size: 0.17, transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.85 });
  const stars = new THREE.Points(starGeo, starMat); root.add(stars);

  const trail = particlePool(scene, 180, spriteTexture('star'));
  const hearts = particlePool(scene, 16, spriteTexture('heart'));

  /* 施法魔法阵 */
  const ringTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    g.translate(128, 128); g.strokeStyle = 'rgba(255,255,255,.95)';
    g.lineWidth = 6; g.beginPath(); g.arc(0, 0, 118, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 2.5; g.beginPath(); g.arc(0, 0, 96, 0, Math.PI * 2); g.stroke();
    for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; g.beginPath(); g.moveTo(Math.cos(a) * 96, Math.sin(a) * 96); g.lineTo(Math.cos(a + 2 * Math.PI / 3) * 96, Math.sin(a + 2 * Math.PI / 3) * 96); g.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const rings = [];
  for (let k = 0; k < 3; k++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, color: VIOLET.clone(), opacity: 0 }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.02; m.userData.t = k / 3; scene.add(m); rings.push(m);
  }

  // 原创精灵：程序化建模（星灵 Lumi），骨骼命名与动作接口一致
  /* 形象：默认内置星灵 Lumi；也可以是数据目录里的形象包（opts.pack）：
   *   gltf：模型文件 + boneMap（模型骨骼名 → 统一骨骼名），按最大边长归一化
   *   procedural：入口模块导出 build(THREE, params) → { root, bones, update } */
  const pack = opts.pack || null;
  const bones = {}, rest = {};
  /* 动作幅度：内置形象按原样（tail 为空）；tail 是整条尾巴的总摆幅系数（按节数平分）；导入的 glTF 模型更收敛。形象包的 manifest 可以写 motion: { tail, speed, ear, curl } 覆盖 */
  const gltfPack = pack && pack.kind === 'gltf';
  const MOTION = { tail: gltfPack ? 2.2 : null, speed: gltfPack ? 0.7 : 1, ear: gltfPack ? 0 : 1, curl: gltfPack ? 0 : 1, ...(pack && pack.motion || {}) };
  let tailBones = 7;
  let lumi = null;
  const adopt = (map, root, name) => {
    for (const [k, o] of Object.entries(map)) { bones[k] = o; rest[k] = o.quaternion.clone(); }
    tailBones = Object.keys(bones).filter(k => /^Tail\d$/.test(k)).length || 7;
    holder.add(root); stat.loaded = 1; stat.bones = Object.keys(bones).length; stat.character = name;
  };
  const useLumi = () => { lumi = buildLumi(THREE, opts.palette); lumi.root.scale.multiplyScalar(1.25); adopt(lumi.bones, lumi.root, 'lumi'); };
  if (pack && pack.kind === 'gltf') {
    const draco = new DRACOLoader(); draco.setDecoderPath(new URL('./vendor/draco/', import.meta.url).href);
    const loader = new GLTFLoader(); loader.setDRACOLoader(draco);
    loader.load(pack.url, gltf => {
      const m = gltf.scene, map = {}, bm = pack.boneMap || {};
      m.traverse(o => { if (o.isBone) map[bm[o.name] || o.name] = o; if (o.isMesh) o.frustumCulled = false; });
      m.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(m, true), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      const sc = (+pack.size || 1.5) / (Math.max(size.x, size.y, size.z) || 1);
      m.scale.multiplyScalar(sc); m.position.set((m.position.x - c.x) * sc, (m.position.y - c.y) * sc, (m.position.z - c.z) * sc);
      adopt(map, m, pack.id); draco.dispose();
    }, undefined, e => { stat.failed++; stat.error = String(e); useLumi(); });
  } else if (pack && pack.kind === 'procedural') {
    import(pack.url).then(mod => { const r = mod.build(THREE, { ...(pack.params || {}), ...(opts.palette || {}) }); lumi = r; adopt(r.bones || {}, r.root, pack.id); })
      .catch(e => { stat.failed++; stat.error = String(e); useLumi(); });
  } else useLumi();

  const ptr = { x: -1e4, y: -1e4, t: 0 };
  const st = {
    cast: 0, castTarget: 0, burst: 0, hover: false,
    pos: new THREE.Vector2(0, 0), vel: new THREE.Vector2(0, 0), target: new THREE.Vector2(0, 0), retarget: 0,
    ext: new THREE.Vector2(0, 0), sk: null, hidden: false, trick: null, nextTrick: 3 + Math.random() * 3, sleepy: 0, face: 0, lean: 0,
  };
  const roam = opts.roam ?? 1;
  const BOUND = { x: 0.42 * roam, y: 0.22 * roam };
  const q = new THREE.Quaternion(), e = new THREE.Euler(), tmp = new THREE.Vector3();
  function pose(name, x, y, z) { const b = bones[name]; if (!b) return; e.set(x, y, z); q.setFromEuler(e); b.quaternion.copy(rest[name]).multiply(q); }

  const TRICKS = {
    loop: 1.25, barrel: 1.0, wave: 1.6, peek: 1.8, giggle: 1.1, spin: 0.9, dash: 1.4, stretch: 1.5,
  };
  function startTrick(name) {
    if (REDUCED || !TRICKS[name]) return;
    st.trick = { name, t: 0, dur: TRICKS[name], dir: Math.random() < 0.5 ? -1 : 1 };
    stat.tricks++; st.sleepy = 0;
    if (name === 'dash') st.target.set(st.trick.dir * BOUND.x, (Math.random() - 0.3) * BOUND.y), st.retarget = 1.6;
    if (name === 'loop' || name === 'spin') st.burst = Math.max(st.burst, 0.6);
  }
  function screenToLocal(x, y) {
    const r = host.getBoundingClientRect();
    return { dx: (x - (r.left + r.width / 2)) / r.width, dy: (y - (r.top + r.height * 0.45)) / r.height, dist: Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) };
  }

  let gap = 1 / 60, last = 0, stopped = false;
  // 容器尺寸变化时自动调整画布
  const ro = new ResizeObserver(() => { camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); });
  ro.observe(host);
  const clock = new THREE.Clock();
  function frame(ms) {
    if (stopped) return;
    requestAnimationFrame(frame);
    if ((ms - last) / 1000 < gap - 0.002) return;
    last = ms;
    const dt = Math.min(0.1, clock.getDelta() || 0.016), t = clock.elapsedTime;
    st.cast += (st.castTarget - st.cast) * Math.min(1, dt * 3);
    const c = st.cast;
    const p = screenToLocal(ptr.x, ptr.y);
    const near = opts.followPointer !== false && p.dist < 260 && t - ptr.t < 3; // followPointer=false：不往鼠标那边凑、不转头看鼠标
    if (t - ptr.t > 60 && !c) st.sleepy = Math.min(1, st.sleepy + dt * 0.15); else st.sleepy = Math.max(0, st.sleepy - dt * 2);
    const zz = st.sleepy;

    // ---- 飞行：随机找目标点，鼠标靠近就往鼠标那边凑；施法时回到中间 ----
    st.retarget -= dt;
    if (c > 0.3) st.target.set(0, 0.08);
    else if (near) st.target.set(THREE.MathUtils.clamp(p.dx * 1.2, -BOUND.x, BOUND.x), THREE.MathUtils.clamp(-p.dy * 0.6, -BOUND.y, BOUND.y));
    else if (st.retarget <= 0) { st.target.set((Math.random() * 2 - 1) * BOUND.x * (1 - zz), (Math.random() * 2 - 1) * BOUND.y * (1 - zz) - zz * 0.15); st.retarget = 2.5 + Math.random() * 3; }
    const stiff = (st.trick?.name === 'dash' ? 9 : near ? 4 : 1.6) * (1 - zz * 0.7);
    st.vel.x += ((st.target.x - st.pos.x) * stiff - st.vel.x * 2.6) * dt;
    st.vel.y += ((st.target.y - st.pos.y) * stiff - st.vel.y * 2.6) * dt;
    st.pos.x += st.vel.x * dt; st.pos.y += st.vel.y * dt;
    const bob = Math.sin(t * (1.7 - zz)) * (0.07 - zz * 0.04);
    root.position.set(st.pos.x, 0.06 + st.pos.y + bob + c * 0.1, 0);

    // 朝向：飞行方向 + 看鼠标；转弯侧倾
    const look = near ? THREE.MathUtils.clamp(p.dx * 1.4, -0.8, 0.8) : 0;
    const wantFace = THREE.MathUtils.clamp(st.vel.x * 1.6 + st.ext.x / 300, -1.1, 1.1) * 0.7 + look * 0.6 + Math.sin(t * 0.5) * 0.12 * (1 - zz);
    st.face += (wantFace - st.face) * Math.min(1, dt * 4);
    st.lean += (THREE.MathUtils.clamp(-st.vel.x * 0.9 - st.ext.x / 900, -0.5, 0.5) - st.lean) * Math.min(1, dt * 5);
    root.rotation.y = st.face;
    root.rotation.x = THREE.MathUtils.clamp(st.ext.y / 1500, -0.3, 0.3); // 上下飞时低头/抬头
    // 技能：瞬间移动的消失/出现
    let sc = st.hidden ? 0 : 1;
    if (st.sk) {
      st.sk.t += dt; const k = Math.min(1, st.sk.t / st.sk.dur);
      if (st.sk.name === 'vanish') { sc = 1 - ease(k); root.rotation.y += ease(k) * Math.PI * 4; }
      else if (st.sk.name === 'appear') { sc = k < 0.7 ? ease(k / 0.7) * 1.12 : 1.12 - 0.12 * ease((k - 0.7) / 0.3); root.rotation.y -= (1 - k) * Math.PI * 3; }
      if (k >= 1) { st.hidden = st.sk.name === 'vanish'; st.sk = null; }
    }
    root.scale.setScalar(Math.max(0.001, sc));

    // ---- 小把戏 ----
    st.nextTrick -= dt * (document.hasFocus() ? 1 : 0);
    if (!st.trick && st.nextTrick <= 0 && !c && zz < 0.5) { const names = ['loop', 'barrel', 'wave', 'peek', 'giggle', 'dash', 'stretch', 'wave', 'peek']; startTrick(names[Math.floor(Math.random() * names.length)]); st.nextTrick = 5 + Math.random() * 7; }
    let rx = 0, rz = st.lean + Math.sin(t * 1.1) * 0.04, ry = 0, sx = 1, sy = 1, lift = 0;
    let armL = 0.05 + Math.sin(t * 2) * 0.06, armR = -0.05 - Math.sin(t * 2) * 0.06, foreL = 0, foreR = 0, wave = 0, earUp = 0, headTilt = 0, tailCurl = 0;
    const tr = st.trick;
    if (tr) {
      tr.t += dt; const k = Math.min(1, tr.t / tr.dur), b = bell(k);
      switch (tr.name) {
        case 'loop': rx = -ease(k) * Math.PI * 2; lift = b * 0.28; tailCurl = b * 0.5; armL += b * 0.6; armR -= b * 0.6; break;
        case 'barrel': rz += tr.dir * ease(k) * Math.PI * 2; lift = b * 0.12; break;
        case 'spin': ry = ease(k) * Math.PI * 2; lift = b * 0.1; break;
        case 'wave': armR = -1.25 * b; foreR = Math.sin(k * Math.PI * 6) * 0.7 * b; headTilt = 0.25 * b; earUp = b; break;
        case 'peek': rz += tr.dir * 0.45 * b; headTilt = -tr.dir * 0.35 * b; earUp = b; break;
        case 'giggle': sy = 1 + Math.sin(k * Math.PI * 8) * 0.07 * (1 - k); sx = 2 - sy; earUp = b * 0.6; tailCurl = Math.sin(k * Math.PI * 4) * 0.4; break;
        case 'dash': rz += -tr.dir * 0.3 * b; tailCurl = b * 0.3; break;
        case 'stretch': sy = 1 + b * 0.1; sx = 1 - b * 0.05; armL = 1.1 * b; armR = -1.1 * b; earUp = b; break;
      }
      if (k >= 1) st.trick = null;
    }
    if (st.hover && !tr) { armR = -1.1; foreR = Math.sin(t * 12) * 0.5; earUp = 1; }
    pivot.rotation.set(rx, ry, rz);
    pivot.scale.set(sx, sy * (1 - zz * 0.05), sx);
    root.position.y += lift;

    // ---- 骨骼 ----
    /* 尾巴：每节的摆动是叠加的，节数越多尾巴甩得越大。内置 Lumi 按原样；导入的模型（尾巴往往又长又细）把整条尾巴的摆幅限制在 MOTION.tail 以内、
     * 睡着时不再往外卷、频率放慢，否则尾巴会在「藏在身后」和「甩到一边」之间来回，看上去像原地抽动 */
    const tailSpeed = (2.2 + c * 2 + (tr ? 1.5 : 0)) * (1 - zz * 0.6) * MOTION.speed;
    const tk = MOTION.tail == null ? 1 : MOTION.tail / (tailBones || 1);
    for (let n = 1; n <= 7; n++) pose('Tail' + n, (Math.sin(t * tailSpeed - n * 0.55) * (0.18 + c * 0.1) + tailCurl * 0.35 + zz * 0.25 * MOTION.curl) * tk, Math.cos(t * 1.6 * MOTION.speed - n * 0.5) * 0.14 * tk, 0);
    const twitch = Math.max(0, Math.sin(t * 0.9) - 0.94) * 6 * MOTION.ear;
    pose('LEar', -earUp * 0.2, 0, twitch * 0.25 - zz * 0.3); pose('REar', -earUp * 0.2, 0, -twitch * 0.25 + zz * 0.3);
    pose('LArm', 0, 0, armL + 0.35 * c); pose('RArm', 0, 0, armR - 0.35 * c);
    pose('LForeArm', 0, foreL - 0.5 * c, 0); pose('RForeArm', 0, foreR + 0.5 * c + wave, 0);
    pose('Head', (near ? THREE.MathUtils.clamp(-p.dy * 0.6, -0.3, 0.3) : 0) + zz * 0.35, look * 0.7, headTilt + Math.sin(t * 0.7) * 0.05);
    pose('Spine1', zz * 0.25, 0, 0);
    if (lumi && lumi.update) lumi.update(t, { sleepy: zz, cast: c });

    // ---- 泡泡 + 星光 ----
    bubbleMat.uniforms.uTime.value = t;
    bubbleMat.uniforms.uWobble.value = 0.012 + st.burst * 0.04 + (tr ? 0.01 : 0);
    bubbleMat.uniforms.uPower.value = (0.42 + c * 0.55 + st.burst * 0.8 + Math.sin(t * 2.4) * 0.06) * (1 - zz * 0.4);
    bubbleMat.uniforms.uColor.value.copy(PINK).lerp(VIOLET, c * 0.7);
    bubble.scale.setScalar(1 + Math.sin(t * 2.4) * 0.025 + st.burst * 0.22);
    st.burst = Math.max(0, st.burst - dt * 1.6);
    for (let i = 0; i < N; i++) {
      const s = seeds[i];
      s.a += dt * s.sp * (1 + c * 3 + st.burst * 4 + (tr ? 1 : 0)) * (1 - zz * 0.7);
      const rr = s.r * (1 - c * 0.25) + st.burst * 0.5;
      sp[i * 3] = Math.cos(s.a) * rr; sp[i * 3 + 1] = 0.95 + Math.sin(s.a) * rr * s.tilt * 0.6 + (s.y - 0.5) * 0.6; sp[i * 3 + 2] = Math.sin(s.a) * rr * 0.7;
    }
    starGeo.attributes.position.needsUpdate = true;
    starMat.opacity = (0.8 + c * 0.2 - Math.abs(Math.sin(t * 5)) * 0.15) * (1 - zz * 0.5);
    starMat.color.copy(WHITE).lerp(CYAN, c * 0.6);

    // ---- 尾巴星光拖尾：飞得越快、把戏越多，星光越多 ----
    const speed = st.vel.length() + st.ext.length() / 450;
    const tip = bones.Tail7 || bones.Tail5;
    if (tip && !REDUCED) {
      const rate = 6 + speed * 60 + (tr ? 20 : 0) + c * 25;
      if (Math.random() < rate * dt) {
        tip.getWorldPosition(tmp);
        trail.emit(tmp.x, tmp.y, tmp.z, { vx: (Math.random() - 0.5) * 0.3, vy: 0.15 + Math.random() * 0.2, vz: (Math.random() - 0.5) * 0.2, life: 0.8 + Math.random() * 0.6, size: 0.08 + Math.random() * 0.08, color: Math.random() < 0.3 ? CYAN : WHITE });
      }
    }
    if (zz > 0.6 && Math.random() < dt * 0.8) trail.emit(root.position.x + 0.25, 1.5, 0.2, { vx: 0.12, vy: 0.25, life: 1.8, size: 0.14, color: VIOLET });
    trail.update(dt); hearts.update(dt);

    // ---- 魔法阵 ----
    rings.forEach(m => {
      m.userData.t = (m.userData.t + dt * 0.7) % 1;
      const k = m.userData.t;
      m.position.x = root.position.x;
      m.scale.setScalar(0.6 + k * 2.2); m.rotation.z = t * 0.6; m.material.opacity = c * (1 - k) * 0.85;
    });
    glow.position.set(root.position.x, root.position.y + 1, 1.2);
    glow.intensity = (1.1 + c * 2.2 + st.burst * 3) * (1 - zz * 0.5);

    renderer.render(scene, camera);
    stat.frames++;
  }
  requestAnimationFrame(frame);

  function heartBurst(n = 6) {
    for (let i = 0; i < n; i++) hearts.emit(root.position.x, root.position.y + 1.3, 0.3, { vx: (Math.random() - 0.5) * 0.9, vy: 0.5 + Math.random() * 0.5, life: 1.2 + Math.random() * 0.4, size: 0.18 + Math.random() * 0.1, gravity: 0.3, color: WHITE });
  }

  return {
    stat,
    pointer(x, y) { ptr.x = x; ptr.y = y; ptr.t = clock.elapsedTime; },
    hover(on) { st.hover = on; st.sleepy = 0; if (on) { heartBurst(5); st.burst = Math.max(st.burst, 0.4); } },
    trick(name) { st.sleepy = 0; if (!st.trick || name === 'loop') startTrick(name); if (name === 'loop') heartBurst(4); },
    /* 兼容旧接口 */
    twirl() { startTrick('spin'); },
    /* 悬浮窗在桌面上移动时的速度（像素/秒）：决定朝向、侧倾和星光拖尾 */
    travel(vx, vy) { st.ext.set(vx, vy); if (Math.hypot(vx, vy) > 60) st.sleepy = 0; },
    wake() { st.sleepy = 0; },
    /* 弹出气泡菜单时：朝每个气泡的方向喷出一小串星光（angles 为屏幕坐标系的弧度，y 向下） */
    puff(angles = []) {
      if (REDUCED) return;
      const cx = root.position.x, cy = root.position.y + 0.95;
      st.sleepy = 0; st.burst = Math.max(st.burst, 0.45);
      for (const a of angles) for (let k = 0; k < 5; k++) {
        const v = 1.5 + Math.random() * 1.5, j = (Math.random() - 0.5) * 0.3;
        trail.emit(cx + Math.cos(a) * 0.3, cy - Math.sin(a) * 0.3, 0.35, { vx: Math.cos(a + j) * v, vy: -Math.sin(a + j) * v, life: 0.35 + Math.random() * 0.3, size: 0.07 + Math.random() * 0.07, color: [PINK, VIOLET, CYAN, WHITE][k % 4] });
      }
    },
    /* 技能：vanish / appear（瞬移）、burst（念力爆发）、sparkle（爱心星光） */
    skill(name) {
      st.sleepy = 0;
      const cx = root.position.x, cy = root.position.y + 0.95;
      if (name === 'vanish' || name === 'appear') {
        if (name === 'appear') st.hidden = false;
        st.sk = { name, t: 0, dur: name === 'vanish' ? 0.38 : 0.55 }; st.burst = 1;
        for (let i = 0; i < 26; i++) { const a = Math.random() * Math.PI * 2, v = 0.8 + Math.random() * 1.2; trail.emit(cx, cy, 0, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.6 + Math.random() * 0.5, size: 0.1 + Math.random() * 0.1, color: Math.random() < 0.5 ? CYAN : PINK }); }
      } else if (name === 'burst') {
        st.castTarget = 1; st.burst = 1; startTrick('stretch');
        setTimeout(() => { st.castTarget = 0; st.burst = 1;
          for (let i = 0; i < 60; i++) { const a = (i / 60) * Math.PI * 2, v = 1.6 + Math.random() * 0.9; trail.emit(cx, cy, 0, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: (Math.random() - 0.5) * 0.6, life: 0.7 + Math.random() * 0.5, size: 0.12 + Math.random() * 0.1, color: [PINK, VIOLET, CYAN, WHITE][i % 4] }); }
          heartBurst(5); startTrick('loop');
        }, 900);
      } else if (name === 'sparkle') { heartBurst(8); st.burst = 0.8; startTrick('giggle'); }
    },
    cast(on) { st.castTarget = on ? 1 : 0; st.sleepy = 0; if (on) st.burst = 1; },
    fps(v) { gap = 1 / v; },
    /* 被拖动时：身体往反方向晃一下、有点惯性（dx/dy 是这一帧拖动的像素） */
    nudge(dx, dy) {
      st.vel.x = THREE.MathUtils.clamp(st.vel.x - dx * 0.012, -1.6, 1.6);
      st.vel.y = THREE.MathUtils.clamp(st.vel.y + dy * 0.008, -1.2, 1.2);
      st.sleepy = 0; st.burst = Math.max(st.burst, Math.min(0.5, Math.hypot(dx, dy) * 0.01));
    },
    /* 泡泡中心在 host 里的像素位置和半径（用来做鼠标命中检测） */
    hitCircle(nominal = false) {
      // nominal：泡泡静止时的位置（算拖动边界用，避免精灵在泡泡里飘动导致边界抖动）
      const px = nominal ? 0 : root.position.x, py = nominal ? 0.06 : root.position.y;
      const v = new THREE.Vector3(px, 0.95 + py, 0).project(camera);
      const e = new THREE.Vector3(px + 0.9, 0.95 + py, 0).project(camera);
      const w = W(), h = H(), cx = (v.x + 1) / 2 * w, cy = (1 - v.y) / 2 * h;
      return { x: cx, y: cy, r: Math.abs((e.x + 1) / 2 * w - cx) * 1.12 };
    },
    resize() { camera.aspect = W() / H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); },
    _state: st,
    dispose() {
      stopped = true; ro.disconnect();
      scene.traverse(o => { o.geometry?.dispose(); (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []).forEach(mt => { mt.map?.dispose(); mt.uniforms?.uMap?.value?.dispose?.(); mt.dispose(); }); });
      renderer.dispose(); renderer.forceContextLoss?.(); renderer.domElement.remove(); 
    },
  };
}

export const createMew = createSprite;
