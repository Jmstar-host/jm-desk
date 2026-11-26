/* 可放进气泡的动作目录。布局（layout.json）只能引用这里的 id；扩展可以往里注册新动作。
 * kind: skill（精灵自己执行） toggle（开关，不收起菜单） app（打开面板应用） cmd（主进程执行） */
export const CATALOG = {
  'skill.teleport': { kind: 'skill', icon: 'portal', label: '瞬移', tip: '瞬间移动到屏幕别处' },
  'skill.burst':    { kind: 'skill', icon: 'burst', label: '爆发', tip: '念力爆发' },
  'skill.orbit':    { kind: 'skill', icon: 'orbit', label: '绕圈', tip: '原地绕圈飞' },
  'skill.zoom':     { kind: 'skill', icon: 'dash', label: '冲刺', tip: '冲到屏幕边上' },
  'skill.sparkle':  { kind: 'skill', icon: 'heart', label: '爱心', tip: '撒一把爱心' },
  'skill.loop':     { kind: 'skill', icon: 'loop', label: '跟头', tip: '翻个跟头' },
  'skill.wave':     { kind: 'skill', icon: 'smile', label: '挥手', tip: '打个招呼' },
  // 1.8.0 能边飞边放的技能：放的时候不停下来
  'skill.combo':    { kind: 'skill', icon: 'dash', label: '连招', tip: '满屏快飞，沿途随机施放五种不同的技能' },
  'skill.psywave':  { kind: 'skill', icon: 'portal', label: '念力波', tip: '三圈光环向外扩散，飞着也能放' },
  'skill.orb':      { kind: 'skill', icon: 'orbit', label: '能量球', tip: '在身前聚光，往飞行方向打出去' },
  'skill.meteor':   { kind: 'skill', icon: 'magic', label: '流星', tip: '一串星星从上方斜着落下' },
  'skill.spark':    { kind: 'skill', icon: 'bell', label: '电光', tip: '身体周围噼里啪啦的闪电' },
  'skill.swirl':    { kind: 'skill', icon: 'loop', label: '旋风', tip: '转一圈，甩出一圈星光' },
  'skill.fireflies': { kind: 'skill', icon: 'dash', label: '流萤火线', tip: '三道火尾沿飞行方向追逐' },
  'skill.tide':      { kind: 'skill', icon: 'orbit', label: '潮汐泡环', tip: '三圈水纹向外扩散，气泡浮起' },
  'skill.forks':     { kind: 'skill', icon: 'burst', label: '折枝电弧', tip: '两束紫电向两侧分叉伸展' },
  'skill.leaves':    { kind: 'skill', icon: 'wing', label: '回旋叶阵', tip: '八片绿叶沿椭圆轨道绕身飞旋' },
  'skill.crystals':  { kind: 'skill', icon: 'magic', label: '悬冰星簇', tip: '八枚冰晶向外绽开，再合拢' },
  /* 主窗口（1.3.0 起对话、工作台、线索合进一个窗口，左边切换） */
  'app.desk':       { kind: 'cmd', icon: 'chart', label: '主窗口', tip: '助手、工作台、线索都在这个窗口里' },
  'app.agent':      { kind: 'cmd', icon: 'magic', label: '助手', tip: '和 AI 多轮对话：查资料、问知识库、调用平台办事、交给本机执行者' },
  'app.work':       { kind: 'cmd', icon: 'chart', label: '工作台', tip: '专项 › 项目 › 需求 › 待办，汇总线索、勾掉待办、对齐需求管理平台', count: 'tasks' },
  'app.clues':      { kind: 'cmd', icon: 'inbox', label: '线索', tip: '收到的邮件、飞书、纪要原文，信息源和搬运到需求管理平台' },
  'app.chat':       { kind: 'cmd', icon: 'smile', label: '聊天', tip: '打开主窗口的「聊天」页（团队的私有聊天）' },
  'sys.load':       { kind: 'cmd', icon: 'dash', label: '占用', tip: 'CPU 和内存占用；点一下打开活动监视器' },
  'app.peers':      { kind: 'app', icon: 'portal', label: '串门', tip: '选一个好友、选好范围，精灵飞去好友的桌面找回来' },
  'app.settings':   { kind: 'app', icon: 'sliders', label: '设置', tip: '形象、气泡、需求管理平台、接入、模型' },
  'app.reminders':  { kind: 'app', icon: 'bell', label: '提醒', tip: '订饭、吃饭、下班提醒，时间可以自己设' },
  'app.update':     { kind: 'app', icon: 'inbox', label: '升级', tip: '检查并安装新版本' },
  'app.library':    { kind: 'app', icon: 'box', label: '收资料', tip: '把文件拖到精灵身上，或在这里选文件，核对后传到知识库的资料库' },
  'mail.open':      { kind: 'cmd', icon: 'mail', label: '邮箱', tip: '打开邮件客户端' },
  'mail.compose':   { kind: 'cmd', icon: 'quill', label: '写邮件', tip: '新建一封邮件' },
  'mail.stats':     { kind: 'app', icon: 'chart', label: '未读', tip: '未读统计', count: 'unread' },
  'toggle.roam':    { kind: 'toggle', icon: 'wing', label: '自由飞', tip: '开关自由活动', stay: true },
  'place.corner':   { kind: 'skill', icon: 'corner', label: '右下角', tip: '回到屏幕右下角' },
};
export const ICONS = ['magic', 'mail', 'sliders', 'portal', 'burst', 'orbit', 'dash', 'heart', 'loop', 'smile', 'doc', 'check', 'chart', 'inbox', 'quill', 'box', 'wing', 'moon', 'pin', 'corner', 'bell'];

/* 分组上限：第一层 6 个；一组里最多 14 个气泡（外圈铺到 300°，14 个时相邻两个仍不重叠；1.10.4 之前是 8） */
export const MAX_ITEMS = 14;
const ELEMENT_IDS = ['skill.fireflies', 'skill.tide', 'skill.forks', 'skill.leaves', 'skill.crystals'];
export const DEFAULT_LAYOUT = {
  version: 1,
  groups: [
    // 1.10.4：「元素」并进「互动」（一组最多 14 个）；第一层加「聊天」，点一下直接打开聊天页
    { id: 'play', label: '互动', icon: 'magic', color: ['#ec4899', '#8b5cf6'], tip: '放技能、翻跟头、元素特效', items: ['skill.teleport', 'skill.burst', 'skill.orbit', 'skill.zoom', 'skill.sparkle', 'skill.loop', 'skill.wave', 'skill.combo', 'skill.fireflies', 'skill.tide', 'skill.forks', 'skill.leaves', 'skill.crystals'] },
    { id: 'chat', label: '聊天', icon: 'smile', color: ['#ec4899', '#ea580c'], tip: '打开聊天', action: 'app.chat', items: [] },
    { id: 'load', label: '占用', icon: 'dash', color: ['#16a34a', '#3b82f6'], tip: 'CPU 和内存占用', action: 'sys.load', items: [] },
    { id: 'work', label: '工作', icon: 'doc', color: ['#ec4899', '#3b82f6'], tip: '助手、工作台、线索、串门', items: ['app.agent', 'app.work', 'app.clues', 'app.peers'] },
    { id: 'mail', label: '邮箱', icon: 'mail', color: ['#3b82f6', '#8b5cf6'], tip: '调起邮件客户端', items: ['mail.open', 'mail.compose', 'mail.stats'] },
    { id: 'more', label: '设置', icon: 'sliders', color: ['#17141f', '#3b82f6'], tip: '设置、提醒、精灵位置', items: ['app.settings', 'app.reminders', 'toggle.roam', 'place.corner'] },
  ],
};

/* 1.3.0 去掉的入口 → 现在去哪里。旧的 layout.json、精灵气泡、外部 AI、旧版本代码里的链接都按这里转过去：
 *   [动作 id, 设置页的分页]。待办 / 需求池 / 汇总并进工作台，问知识并进助手，收集并进线索，平台 / 接入 / 模型 / 形象是设置里的分页。 */
export const MOVED = {
  'app.meeting': ['app.clues'], // 1.5.2 去掉本机会议纪要：旧入口转到线索（飞书会议纪要在那里）
  'app.summary': ['app.work'], 'app.tasks': ['app.work'], 'app.pool': ['app.work'], 'mail.report': ['app.work'],
  'app.knowledge': ['app.agent'], 'app.collect': ['app.clues'],
  'app.connect': ['app.settings', 'account'], 'app.integrations': ['app.settings', 'integrations'], 'app.models': ['app.settings', 'model'], 'app.character': ['app.settings', 'character'],
};
/* 旧布局里去掉的入口换成新的，重复的只留一个；全空的分组去掉。返回 { layout, changed } */
export function migrateLayout(l) {
  if (!l || !Array.isArray(l.groups)) return { layout: l, changed: false };
  let changed = false; const used = new Set();
  // 1.3.1 换了色板：还是旧默认颜色的分组换成新默认颜色（用户自己挑过的颜色只做就近对齐，见 validateLayout）
  const OLD = { '#f472b6/#c084fc': 'play', '#8b7cf6/#60a5fa': 'work', '#38bdf8/#818cf8': 'mail', '#2dd4bf/#a78bfa': 'more' };
  const recolor = g => { const k = OLD[(g.color || []).join('/').toLowerCase()], d = k && DEFAULT_LAYOUT.groups.find(x => x.id === k); if (!d) return g; changed = true; return { ...g, color: [...d.color] }; };
  const groups = l.groups.map(recolor).map(g => {
    const items = [];
    for (const x of Array.isArray(g.items) ? g.items : []) {
      const to = MOVED[x] ? MOVED[x][0] : x;
      if (to !== x) changed = true;
      if (used.has(to)) { changed = true; continue; }
      used.add(to); items.push(to);
    }
    // 1.8.0「搬运」改名「串门」：旧的默认提示一起换掉
    if (g.id === 'work' && (/汇总|待办|需求池|知识/.test(g.tip || '') || g.tip === '助手、工作台、线索、搬运')) { changed = true; return { ...g, tip: '助手、工作台、线索、串门', items }; }
    return { ...g, items };
  }).filter(g => g.items.length || g.action || (changed = true, false));
  // 1.5.2 去掉了本机会议纪要：1.4.2 加到第一层的「会议」分组删掉（会议内容走飞书会议纪要，作为线索收进来）
  const kept = groups.filter(g => g.action !== 'app.meeting'); if (kept.length !== groups.length) changed = true;
  // 1.7.0：第一层加「占用」（CPU / 内存，点开活动监视器）。只加一次，用户删掉后不再加回来（seen 记着）
  const seen = new Set(Array.isArray(l.seen) ? l.seen : []);
  // 1.8.0：「互动」里加「连招」（边飞边放技能）。只加一次，放得下才加
  if (!seen.has('combo')) { seen.add('combo'); changed = true; const play = kept.find(g => g.id === 'play' && !g.action); if (play && play.items.length < 8 && !kept.some(g => g.items.includes('skill.combo'))) play.items = [...play.items, 'skill.combo']; }
  if (!seen.has('load')) { seen.add('load'); changed = true; if (kept.length < 6 && !kept.some(g => g.action === 'sys.load' || g.items.includes('sys.load'))) kept.splice(Math.min(1, kept.length), 0, { ...DEFAULT_LAYOUT.groups.find(g => g.id === 'load'), items: [] }); }
  if (!seen.has('elements')) {
    seen.add('elements'); changed = true;
    const playIndex = kept.findIndex(g => g.id === 'play' && !g.action);
    // 1.10.4 起元素技能直接放进「互动」，不再单独成组
    const play = kept[playIndex], items = ELEMENT_IDS.filter(id => !used.has(id));
    if (play && play.items.length + items.length <= MAX_ITEMS) { play.items = [...play.items, ...items]; items.forEach(id => used.add(id)); }
  }
  // 1.10.4：「元素」并进「互动」（只并还是默认内容的那一组；用户自己改过名字或内容的不动），第一层加「聊天」。各只做一次
  if (!seen.has('merge-play')) {
    seen.add('merge-play'); changed = true;
    const play = kept.find(g => g.id === 'play' && !g.action), ei = kept.findIndex(g => g.id === 'elements' && !g.action && g.label === '元素' && g.items.every(id => ELEMENT_IDS.includes(id)));
    if (play && ei >= 0 && play.items.length + kept[ei].items.length <= MAX_ITEMS) { play.items = [...play.items, ...kept[ei].items]; if (play.tip === '放技能、翻跟头、撒爱心') play.tip = '放技能、翻跟头、元素特效'; kept.splice(ei, 1); }
  }
  if (!seen.has('chat')) {
    seen.add('chat'); changed = true;
    if (kept.length < 6 && !kept.some(g => g.action === 'app.chat' || g.items.includes('app.chat'))) { const pi = kept.findIndex(g => g.id === 'play'); kept.splice(pi >= 0 ? pi + 1 : kept.length, 0, { ...DEFAULT_LAYOUT.groups.find(g => g.id === 'chat'), items: [] }); }
  }
  return { layout: { ...l, groups: kept, seen: [...seen] }, changed };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
/* 色板（和 renderer/tokens.css 一致）：粉、蓝、黑、白为主，紫、绿、橙、红为辅。气泡分组只能用这里的颜色（白色做泡泡底，不做分组色）。 */
export const PALETTE = { pink: '#ec4899', blue: '#3b82f6', black: '#17141f', violet: '#8b5cf6', green: '#16a34a', orange: '#ea580c', red: '#e11d48' };
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
/** 任意 #rrggbb → 色板里最接近的一种（布局里写了别的颜色、AI 改布局时乱选颜色，都会被对齐） */
export function snapColor(hex) {
  if (!HEX.test(String(hex))) return PALETTE.pink;
  const [r, g, b] = rgb(hex.toLowerCase());
  let best = PALETTE.pink, bd = Infinity;
  for (const c of Object.values(PALETTE)) { const [R, G, B] = rgb(c), d = (r - R) ** 2 * 0.3 + (g - G) ** 2 * 0.59 + (b - B) ** 2 * 0.11; if (d < bd) { bd = d; best = c; } }
  return best;
}
/* 校验布局：只接受目录里存在的动作；返回 { ok, layout, errors } */
export function validateLayout(l) {
  const errors = [];
  if (!l || !Array.isArray(l.groups)) return { ok: false, errors: ['缺少 groups'] };
  if (l.groups.length < 1 || l.groups.length > 6) errors.push('分组数量需在 1–6 之间');
  const gids = new Set(), used = new Set();
  const groups = l.groups.map((g, i) => {
    const id = String(g.id || '').trim();
    if (!/^[a-z][a-z0-9-]{0,20}$/.test(id)) errors.push(`第 ${i + 1} 个分组的 id 不合法`);
    if (gids.has(id)) errors.push(`分组 id 重复：${id}`); gids.add(id);
    const label = String(g.label || '').trim();
    if (!label || [...label].length > 5) errors.push(`分组「${label || id}」名称需 1–5 个字`);
    const icon = ICONS.includes(g.icon) ? g.icon : 'magic';
    const color = (Array.isArray(g.color) && g.color.length === 2 && g.color.every(c => HEX.test(c)) ? g.color : [PALETTE.pink, PALETTE.blue]).map(snapColor);
    // 第一层直接动作的分组（action）：点一下就执行，不展开第二层
    const action = g.action && CATALOG[g.action]?.kind === 'cmd' && !used.has(g.action) ? g.action : null;
    if (g.action && !action) errors.push(`分组「${g.label || id}」的动作不可用：${g.action}`);
    if (action) used.add(action);
    const items = action ? [] : (Array.isArray(g.items) ? g.items : []).filter(x => {
      if (!CATALOG[x]) { errors.push(`未知动作：${x}`); return false; }
      if (used.has(x)) { errors.push(`动作重复出现：${x}`); return false; }
      used.add(x); return true;
    });
    if (items.length > MAX_ITEMS) errors.push(`分组「${label}」最多 ${MAX_ITEMS} 个气泡`);
    return { id, label, icon, color, tip: String(g.tip || '').slice(0, 30), ...(action ? { action } : {}), items };
  });
  if (!used.has('app.settings')) errors.push('必须保留「设置」气泡（app.settings），否则改不回来');
  return { ok: errors.length === 0, errors, layout: { version: 1, groups, ...(Array.isArray(l.seen) ? { seen: l.seen.filter(x => typeof x === 'string').slice(0, 20) } : {}) } };
}
/* 给界面用：把动作 id 展开成完整气泡数据 */
export function resolveLayout(l) {
  return { groups: l.groups.map(g => ({ ...g, items: g.items.map(id => ({ id, ...CATALOG[id] })) })) };
}
