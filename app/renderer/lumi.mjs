/* 星灵 Lumi：JM Desk 的原创默认精灵（程序化建模，不依赖外部模型文件）。
 * 造型：圆滚滚的半透明小光团，奶白肚皮、大眼睛、腮红；头顶两根带星星灯的小触角；
 * 两侧小鳍当手；身后一条彗星尾巴，尾尖一颗星。
 * 骨骼命名沿用引擎的动作接口：Spine1 / Head / LEar REar（触角）/ LArm RArm / LForeArm RForeArm（鳍尖）/ Tail1…Tail7。 */
/* 可定制参数（设置面板 / AI 定制写入 character.json 的 params）：
 *   body body2 belly cheek eye star  颜色（#rrggbb）
 *   antenna: 'star' | 'leaf' | 'none'   tail: true | false   size: 0.8–1.3 */
export const LUMI_DEFAULTS = { body: '#b9a6ff', body2: '#8fd8ff', belly: '#fff6fb', cheek: '#ff9ccf', eye: '#2a1f3d', star: '#ffe27a', antenna: 'star', tail: true, size: 1 };
export function buildLumi(THREE, params = {}) {
  const P = { ...LUMI_DEFAULTS, ...params };
  const bones = {};
  const node = (name, parent) => { const o = new THREE.Group(); o.name = name; bones[name] = o; parent.add(o); return o; };
  const glossy = (color, extra = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.25, sheen: 0.6, sheenColor: new THREE.Color(0xffffff), ...extra });

  const root = new THREE.Group();
  const spine = node('Spine1', root);

  // 身体：上紫下蓝的渐变光团（顶点色）
  const bodyGeo = new THREE.SphereGeometry(0.5, 48, 36);
  const cA = new THREE.Color(P.body), cB = new THREE.Color(P.body2), col = [], v = new THREE.Vector3();
  for (let i = 0; i < bodyGeo.attributes.position.count; i++) {
    v.fromBufferAttribute(bodyGeo.attributes.position, i);
    const k = THREE.MathUtils.clamp(0.5 - v.y, 0, 1); const c = cA.clone().lerp(cB, k * 0.85); col.push(c.r, c.g, c.b);
  }
  bodyGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const body = new THREE.Mesh(bodyGeo, glossy(0xffffff, { vertexColors: true, emissive: new THREE.Color(P.body), emissiveIntensity: 0.12, transmission: 0.08, thickness: 0.6 }));
  body.scale.set(1, 0.92, 0.9); spine.add(body);

  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.24, 32, 24), glossy(P.belly, { roughness: 0.5 }));
  belly.scale.set(1, 0.72, 0.32); belly.position.set(0, -0.22, 0.33); spine.add(belly);

  // 脸（Head 骨骼只带脸部和触角，转头时身体不动）
  const head = node('Head', spine); head.position.set(0, 0.08, 0);
  const eyeMat = glossy(P.eye, { roughness: 0.15, clearcoat: 1 });
  const hiMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const eyes = [];
  for (const s of [-1, 1]) {
    const e = new THREE.Group(); e.position.set(0.155 * s, 0.03, 0.41); head.add(e);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.085, 24, 18), eyeMat); ball.scale.set(0.85, 1.15, 0.5); e.add(ball);
    const hi = new THREE.Mesh(new THREE.SphereGeometry(0.027, 12, 10), hiMat); hi.position.set(0.025 * s, 0.045, 0.04); e.add(hi);
    const hi2 = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), hiMat); hi2.position.set(-0.02 * s, -0.03, 0.042); e.add(hi2);
    eyes.push(e);
    const cheek = new THREE.Mesh(new THREE.CircleGeometry(0.055, 20), new THREE.MeshBasicMaterial({ color: P.cheek, transparent: true, opacity: 0.55, depthWrite: false }));
    cheek.position.set(0.25 * s, -0.08, 0.385); cheek.rotation.y = 0.45 * s; head.add(cheek);
  }
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.009, 8, 16, Math.PI), new THREE.MeshBasicMaterial({ color: P.eye }));
  mouth.rotation.z = Math.PI; mouth.position.set(0, -0.07, 0.445); head.add(mouth);

  // 触角 + 星星灯
  const starShape = (() => { const s = new THREE.Shape(); for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.035 : 0.085, a = Math.PI / 2 + i * Math.PI / 5; i ? s.lineTo(Math.cos(a) * r, Math.sin(a) * r) : s.moveTo(Math.cos(a) * r, Math.sin(a) * r); } return s; })();
  const starGeo = new THREE.ExtrudeGeometry(starShape, { depth: 0.03, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2 }); starGeo.center();
  const starMat = glossy(P.star, { emissive: new THREE.Color(P.star), emissiveIntensity: 0.9 });
  const lamps = [];
  for (const [name, s] of [['LEar', -1], ['REar', 1]]) {
    const ant = node(name, head); if (P.antenna === 'none') { ant.visible = false; continue; } ant.position.set(0.15 * s, 0.36, 0.05); ant.rotation.z = -0.35 * s;
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, 0.26, 10), glossy(P.body)); stalk.position.y = 0.12; ant.add(stalk);
    const lamp = P.antenna === 'leaf' ? new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), glossy(P.body2, { emissive: new THREE.Color(P.body2), emissiveIntensity: 0.4 })) : new THREE.Mesh(starGeo, starMat);
    if (P.antenna === 'leaf') lamp.scale.set(0.6, 1.4, 0.4); lamp.position.y = 0.28; lamp.scale.setScalar(0.85); ant.add(lamp); lamps.push(lamp);
  }

  // 鳍手
  for (const [a, f, s] of [['LArm', 'LForeArm', -1], ['RArm', 'RForeArm', 1]]) {
    const arm = node(a, spine); arm.position.set(0.45 * s, -0.08, 0.05);
    const fin = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), glossy(P.body2)); fin.scale.set(1.25, 0.6, 0.45); fin.position.x = 0.07 * s; arm.add(fin);
    const tip = node(f, arm); tip.position.x = 0.15 * s;
    const t = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), glossy(P.body)); t.scale.set(1.2, 0.7, 0.5); tip.add(t);
  }

  // 彗星尾巴：7 节，越往后越细越亮，尾尖一颗星
  let parent = spine;
  for (let n = 1; n <= 7; n++) {
    const seg = node('Tail' + n, parent);
    if (n === 1) { seg.position.set(0, -0.3, -0.38); seg.rotation.x = 0.6; } else seg.position.set(0, -0.085, -0.02);
    const r = 0.07 * (1 - n * 0.09);
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), glossy(new THREE.Color(P.body).lerp(new THREE.Color(P.body2), n / 7), { emissive: new THREE.Color(P.body2), emissiveIntensity: 0.15 + n * 0.05 }));
    m.scale.set(1, 1.3, 1); seg.add(m); parent = seg;
  }
  if (!P.tail) bones.Tail1.visible = false;
  const tailStar = new THREE.Mesh(starGeo, starMat); tailStar.position.y = -0.09; tailStar.scale.setScalar(0.7); parent.add(tailStar); lamps.push(tailStar);

  root.scale.setScalar(THREE.MathUtils.clamp(+P.size || 1, 0.8, 1.3));
  root.traverse(o => { if (o.isMesh) o.frustumCulled = false; });

  // 眨眼、星星灯呼吸（每帧调用）
  let nextBlink = 2, blinkT = -1;
  function update(t, s = {}) {
    if (blinkT < 0 && t > nextBlink) blinkT = 0;
    let open = 1;
    if (blinkT >= 0) { blinkT += 1 / 60; open = Math.abs(Math.cos(Math.min(1, blinkT / 0.16) * Math.PI)); if (blinkT > 0.16) { blinkT = -1; nextBlink = t + 2 + Math.random() * 4; } }
    const sleepy = s.sleepy || 0;
    eyes.forEach(e => e.scale.set(1, Math.max(0.08, open * (1 - sleepy * 0.85)), 1));
    const glow = 0.7 + Math.sin(t * 3) * 0.25 + (s.cast || 0) * 0.8;
    starMat.emissiveIntensity = glow;
    lamps.forEach((l, i) => { l.rotation.z = t * (0.8 + i * 0.2); });
  }
  return { root, bones, update };
}
