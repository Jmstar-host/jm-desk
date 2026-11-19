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
  'app.work':       { kind: 'cmd', icon: 'chart', label: '工作台', tip: '专项 › 项目 › 需求 › 待办，按产品线分层管理' },
  'app.summary':    { kind: 'app', icon: 'doc', label: '汇总', tip: '邮件、飞书、会议的综合汇总' },
  'app.tasks':      { kind: 'app', icon: 'check', label: '待办', tip: '从线索整理出的跟进动作：需求跟进和日常', count: 'tasks' },
  'app.pool':       { kind: 'app', icon: 'box', label: '需求池', tip: '按项目归集的需求：每条是项目里要完成的一件完整的事' },
  'app.clues':      { kind: 'cmd', icon: 'mail', label: '线索', tip: '收集到的邮件、飞书、纪要原文，以及从中整理出的工作' },
  'app.collect':    { kind: 'app', icon: 'inbox', label: '搬运', tip: '收集信息源，送入平台' },
  'app.knowledge':  { kind: 'app', icon: 'magic', label: '问知识', tip: '查询已接入的知识库' },
  'app.connect':    { kind: 'app', icon: 'pin', label: '平台', tip: '接入 MP2 等业务平台' },
  'app.agent':      { kind: 'app', icon: 'magic', label: '助手', tip: '让 AI 调用已接入的平台 API 和 MCP 办事' },
  'app.integrations': { kind: 'app', icon: 'portal', label: '接入', tip: '接入平台 API 和 MCP 服务器' },
  'app.settings':   { kind: 'app', icon: 'sliders', label: '设置', tip: '形象、气泡、信息源、模型' },
  'app.peers':      { kind: 'app', icon: 'portal', label: '串门', tip: '和同事的桌面结伴，让精灵去对方那里找资料、搬回来' },
  'app.reminders':  { kind: 'app', icon: 'bell', label: '提醒', tip: '订饭、吃饭、下班提醒，时间可以自己设' },
  'app.character':  { kind: 'app', icon: 'smile', label: '形象', tip: '更换或定制精灵形象' },
  'app.update':     { kind: 'app', icon: 'inbox', label: '升级', tip: '检查并安装新版本' },
  'mail.open':      { kind: 'cmd', icon: 'mail', label: '邮箱', tip: '打开邮件客户端' },
  'mail.compose':   { kind: 'cmd', icon: 'quill', label: '写邮件', tip: '新建一封邮件' },
  'mail.stats':     { kind: 'app', icon: 'chart', label: '未读', tip: '未读统计', count: 'unread' },
  'mail.report':    { kind: 'app', icon: 'doc', label: '邮件汇报', tip: '只整理邮件的未读和交期' },
  'toggle.roam':    { kind: 'toggle', icon: 'wing', label: '自由飞', tip: '开关自由活动', stay: true },
  'place.corner':   { kind: 'skill', icon: 'corner', label: '右下角', tip: '回到屏幕右下角' },
};
export const ICONS = ['magic', 'mail', 'sliders', 'portal', 'burst', 'orbit', 'dash', 'heart', 'loop', 'smile', 'doc', 'check', 'chart', 'inbox', 'quill', 'box', 'wing', 'moon', 'pin', 'corner', 'bell'];

export const DEFAULT_LAYOUT = {
  version: 1,
  groups: [
    { id: 'play', label: '互动', icon: 'magic', color: ['#f472b6', '#c084fc'], tip: '放技能、翻跟头、撒爱心', items: ['app.peers', 'skill.teleport', 'skill.burst', 'skill.orbit', 'skill.zoom', 'skill.sparkle', 'skill.loop', 'skill.wave'] },
    { id: 'work', label: '工作', icon: 'doc', color: ['#8b7cf6', '#60a5fa'], tip: '汇总、待办、需求池、知识', items: ['app.work', 'app.agent', 'app.summary', 'app.clues', 'app.tasks', 'app.pool', 'app.collect', 'app.knowledge'] },
    { id: 'mail', label: '邮箱', icon: 'mail', color: ['#38bdf8', '#818cf8'], tip: '调起邮件客户端', items: ['mail.open', 'mail.compose', 'mail.stats', 'mail.report'] },
    { id: 'more', label: '设置', icon: 'sliders', color: ['#2dd4bf', '#a78bfa'], tip: '形象、气泡、平台接入', items: ['app.reminders', 'app.character', 'app.settings', 'app.connect', 'app.integrations', 'toggle.roam', 'place.corner'] },
  ],
};

const HEX = /^#[0-9a-fA-F]{6}$/;
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
    const color = Array.isArray(g.color) && g.color.length === 2 && g.color.every(c => HEX.test(c)) ? g.color : ['#8b7cf6', '#60a5fa'];
    const items = (Array.isArray(g.items) ? g.items : []).filter(x => {
      if (!CATALOG[x]) { errors.push(`未知动作：${x}`); return false; }
      if (used.has(x)) { errors.push(`动作重复出现：${x}`); return false; }
      used.add(x); return true;
    });
    if (items.length > 8) errors.push(`分组「${label}」最多 8 个气泡`);
    return { id, label, icon, color, tip: String(g.tip || '').slice(0, 30), items };
  });
  if (!used.has('app.settings')) errors.push('必须保留「设置」气泡（app.settings），否则改不回来');
  return { ok: errors.length === 0, errors, layout: { version: 1, groups } };
}
/* 给界面用：把动作 id 展开成完整气泡数据 */
export function resolveLayout(l) {
  return { groups: l.groups.map(g => ({ ...g, items: g.items.map(id => ({ id, ...CATALOG[id] })) })) };
}
