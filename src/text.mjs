import crypto from 'node:crypto';
export const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/* MP2 POST /api/meeting-intake/sources 的长度上限（MP2 按 Java String.length 计，即 UTF-16 单元，与 JS .length 一致）。
 * MP2 从不截断：超长直接 400，所以这里必须在发送前保证不超。 */
export const LIMITS = { content: 20000, title: 200, ref: 255, url: 1000 };

/* 截到 n 个 UTF-16 单元以内，不把代理对劈成两半 */
const cutSafe = (s, n) => { let i = Math.max(0, n); if (i > 0 && i < s.length && /[\ud800-\udbff]/.test(s[i - 1])) i--; return s.slice(0, i); };

/* 保留给旧调用方：结果（含标记）总长 ≤ n。新代码请用 splitSignal，不要截断。 */
export const clip = (s, n, marker = '\n…（已截断）') => (s.length > n ? cutSafe(s, n - marker.length) + marker : s);

export const fitTitle = (t, n = LIMITS.title) => { t = String(t ?? '').trim(); return t.length > n ? cutSafe(t, n - 1) + '…' : t; };
/* source_ref ≤ 255：超长时保留前缀 + 原值哈希（确定性，MP2 端按它去重） */
export function fitRef(ref, suffix = '', n = LIMITS.ref) {
  ref = String(ref ?? ''); const full = ref + suffix;
  return full.length <= n ? full : cutSafe(ref, n - suffix.length - 25) + '~' + sha(ref) + suffix;
}
/* MP2 只接受 http/https、≤1000 的 source_url；不合格就不送（可空字段） */
export const safeUrl = (u, n = LIMITS.url) => (typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= n ? u : null);
const safeDate = d => (d && !isNaN(Date.parse(d)) ? d : null);

/* 按「会议章节 → 段落 → 行 → 句子 → 硬切」找切点，每段 ≤ max，拼回去与原文逐字相同（不丢字、不加标记）。 */
export function splitText(s, max = LIMITS.content) {
  s = String(s ?? '');
  const parts = []; let rest = s;
  const lastEnd = (win, re, min) => { let at = -1; for (const m of win.matchAll(re)) { const e = m.index + m[0].length; if (e >= min && e <= win.length) at = e; } return at; };
  while (rest.length > max) {
    const win = rest.slice(0, max), min = Math.floor(max / 2);
    let cut = lastEnd(win, /\n(?=#{1,6}\s)/g, min);          // markdown 标题（纪要的会议/话题章节）
    if (cut < 0) cut = lastEnd(win, /\n[ \t]*\n/g, min);      // 空行 = 段落
    if (cut < 0) cut = lastEnd(win, /\n/g, min);              // 行（逐字稿/聊天一行一句）
    if (cut < 0) cut = lastEnd(win, /[。！？!?；;.]/g, min);  // 句子
    if (cut < 0) cut = cutSafe(win, max).length;              // 实在没有就硬切（不劈代理对）
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

/* 把一条信号整理成符合 MP2 校验的一条或多条：
 * - 标题 ≤200、source_ref ≤255、source_url 只留合格的 http(s)、occurred_at 不合法置空
 * - 正文 >20000 时按章节/段落拆成多条：source_ref 加 `#partK`，标题加 `（K/N）`，id 由原 id + 段号派生（确定性，重复收集仍去重）
 * 单段时 id、source_ref 与旧版完全一致，不影响已送出的信号。 */
export function splitSignal(sig, lim = LIMITS) {
  const base = { ...sig, title: fitTitle(sig.title, lim.title), source_url: safeUrl(sig.source_url, lim.url), occurred_at: safeDate(sig.occurred_at) };
  const chunks = splitText(sig.content, lim.content);
  if (chunks.length === 1) return [{ ...base, source_ref: fitRef(sig.source_ref, '', lim.ref), content: chunks[0] }];
  const n = chunks.length;
  return chunks.map((c, i) => {
    const tag = `（${i + 1}/${n}）`;
    return {
      ...base, id: sha(`${sig.id}#part${i + 1}`), source_ref: fitRef(sig.source_ref, `#part${i + 1}`, lim.ref),
      title: fitTitle(sig.title, lim.title - tag.length) + tag, content: c,
      meta: { ...(sig.meta || {}), part: i + 1, parts: n, parent: sig.id },
    };
  });
}

/* 自动发件人：通知、告警、系统邮件不进需求池 */
export const AUTO = /(^|[._-])(no-?reply|do-?not-?reply|noreply|notification|notify|alert|alerts|monitor|system|bounce|mailer-daemon|postmaster|newsletter|bussiness|business)([._-]|@)/i;
