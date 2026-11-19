/* 员工提醒：订饭、吃饭、下班等每天固定时间的提醒，到点由精灵冒气泡。
 * 不算待办：待办是从线索整理出的工作，做完即关闭；提醒是每天重复的生活节奏，只在「待办」页顶部显示今天的安排。
 *
 * settings.json 的 reminders：
 *   { enabled: true, notify: false, mealUrl: 'https://…', items: [{ id, label, time: 'HH:mm', days: [1..7]（1=周一）, message, openMeal: bool, url, enabled }] }
 * 已提醒记录在 <数据目录>/reminders-state.json：{ fired: { <id>: 'YYYY-MM-DD' } }，每条每天最多提醒一次。 */

export const DEFAULTS = {
  enabled: true, notify: false, mealUrl: '',
  items: [
    { id: 'meal-order', label: '订饭', time: '10:30', days: [1, 2, 3, 4, 5], message: '该订午饭啦，点我打开订餐页面', openMeal: true, enabled: true },
    { id: 'lunch', label: '吃饭', time: '12:00', days: [1, 2, 3, 4, 5], message: '到饭点了，起来走走、吃饭去', enabled: true },
    { id: 'off-work', label: '下班', time: '18:00', days: [1, 2, 3, 4, 5], message: '到下班时间啦，记得保存工作', enabled: true },
  ],
};
export const GRACE_MIN = 30; // 电脑睡眠 / 关机错过时，30 分钟内醒来仍补提醒，再晚就算了
const DAYN = ['日', '一', '二', '三', '四', '五', '六'];

const pad = n => String(n).padStart(2, '0');
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoDay = d => (d.getDay() === 0 ? 7 : d.getDay()); // 1=周一 … 7=周日
const minutes = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
const httpsUrl = u => { const s = String(u || '').trim(); try { return /^https?:$/.test(new URL(s).protocol) ? s : null; } catch { return null; } }; // 校验通过就原样保存

/* 读配置时补齐默认值、过滤掉不合法的项 */
export function normalize(r) {
  const src = r && typeof r === 'object' ? r : {};
  const items = (Array.isArray(src.items) ? src.items : DEFAULTS.items).map((it, i) => ({
    id: /^[a-z0-9][a-z0-9-]{0,30}$/.test(it?.id || '') ? it.id : `r${i + 1}`,
    label: String(it?.label || '提醒').trim().slice(0, 12),
    time: minutes(it?.time) != null ? String(it.time).replace(/^(\d):/, '0$1:') : '09:00',
    days: [...new Set((Array.isArray(it?.days) ? it.days : [1, 2, 3, 4, 5]).map(Number).filter(d => d >= 1 && d <= 7))].sort(),
    message: String(it?.message || '').trim().slice(0, 60),
    openMeal: !!it?.openMeal, url: httpsUrl(it?.url) || '', enabled: it?.enabled !== false,
  }));
  return { enabled: src.enabled !== false, notify: !!src.notify, mealUrl: httpsUrl(src.mealUrl) || '', items };
}

/* 现在该提醒哪些：今天是设定的星期、时间已到且没超过补提醒窗口、今天还没提醒过 */
export function due(cfg, now, state = {}) {
  if (!cfg.enabled) return [];
  const today = dayKey(now), cur = now.getHours() * 60 + now.getMinutes(), fired = state.fired || {};
  return cfg.items.filter(it => {
    const t = minutes(it.time);
    return it.enabled && t != null && it.days.includes(isoDay(now)) && cur >= t && cur - t <= GRACE_MIN && fired[it.id] !== today;
  });
}

/* 今天的安排（给「待办」页顶部和右键卡片）：按时间排序，标出已过 / 已提醒 */
export function today(cfg, now, state = {}) {
  const cur = now.getHours() * 60 + now.getMinutes(), d = isoDay(now), fired = state.fired || {}, k = dayKey(now);
  return cfg.enabled ? cfg.items.filter(it => it.enabled && it.days.includes(d)).sort((a, b) => minutes(a.time) - minutes(b.time))
    .map(it => ({ id: it.id, label: it.label, time: it.time, passed: minutes(it.time) <= cur, fired: fired[it.id] === k, hasUrl: !!(it.openMeal ? cfg.mealUrl : it.url) })) : [];
}

/* 提醒要打开的地址：订饭类用订餐页面，其余用自己的 url */
export const urlFor = (cfg, it) => (it.openMeal ? cfg.mealUrl : it.url) || '';
export const daysText = days => (days.length === 7 ? '每天' : days.join() === '1,2,3,4,5' ? '工作日' : days.join() === '6,7' ? '周末' : '周' + days.map(d => DAYN[d % 7]).join(''));
