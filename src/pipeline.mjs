/* 收集 → 整理 → 送平台：命令行和桌面应用共用 */
import * as store from './store.mjs';
export { store };
import * as mp2 from './mp2.mjs';
import { collectIm, collectMeetings } from './sources/feishu.mjs';
import { collectMail } from './sources/mail.mjs';
import { splitSignal } from './text.mjs';

const short = s => (s.length > 28 ? s.slice(0, 28) + '…' : s);

export const COLLECTORS = {
  feishu_im: async (w) => ({ signals: await collectIm(w), skipped: 0 }),
  feishu_meeting: collectMeetings,
  mail: collectMail,
};

/* collectors 可替换：桌面应用用 node:sqlite 读邮件（Windows 也能用），命令行用 sqlite3 */
export async function collect(collectors = COLLECTORS) {
  const cfg = store.config(), st = store.state(), until = new Date();
  const result = {};
  for (const [name, fn] of Object.entries(collectors)) {
    if (!cfg.sources[name]?.enabled) { result[name] = { off: true }; continue; }
    const since = st.cursors[name] ? new Date(st.cursors[name]) : new Date(until - cfg.firstLookbackHours * 3600e3);
    // 会议纪要通常会后几分钟才生成：会议源始终至少回看 48 小时，靠信号 id 去重
    if (name === 'feishu_meeting') since.setTime(Math.min(since.getTime(), until - 48 * 3600e3));
    try {
      const r = await fn({ since, until });
      let added = 0;
      for (const s of r.signals) if (store.putSignal(s)) { added++; store.log('collected', `收集 · ${short(s.title)}`, { source: name, signal: s.id }); }
      st.cursors[name] = until.toISOString();
      result[name] = { found: r.signals.length, added, skipped: r.skipped || 0, since: since.toISOString() };
    } catch (e) {
      result[name] = { error: e.message, code: e.code || null };
      store.log('error', `${cfg.sources[name].label} 收集失败：${short(e.message)}`, { source: name });
    }
  }
  st.runs.push({ at: until.toISOString(), kind: 'collect', result });
  store.saveState(st);
  return result;
}

/* 发送前按 MP2 校验整理：旧版收集的信号可能正文 >20000（截断后又加了标记）或标题 >200。
 * 需要拆分时把各段作为新信号放进 outbox，原信号标记 split（不删除），本轮直接发各段。 */
function prepare(s) {
  const { status, attempts, lastError, lastErrorCode, lastAttemptAt, collectedAt, ...clean } = s;
  const parts = splitSignal(clean);
  if (parts.length === 1) {
    const p = parts[0];
    if (p.title !== s.title || p.source_ref !== s.source_ref || p.source_url !== s.source_url || p.occurred_at !== s.occurred_at)
      store.updateSignal(s.id, { title: p.title, source_ref: p.source_ref, source_url: p.source_url, occurred_at: p.occurred_at });
    return { list: [{ ...s, ...p }], split: false };
  }
  for (const p of parts) store.putSignal(p);
  store.updateSignal(s.id, { status: 'split', splitInto: parts.map(p => p.id) });
  store.log('split', `拆分 · ${short(s.title)} → ${parts.length} 段`, { source: s.source_type, signal: s.id });
  // 某段若早已存在且送达（例如之前收集过），不重复发
  const inbox = new Map(store.listSignals().map(x => [x.id, x]));
  return { list: parts.map(p => inbox.get(p.id) || p).filter(p => p.status === 'queued'), split: true };
}

export async function submit() {
  const cfg = store.config();
  const queued = store.listSignals('queued');
  if (!mp2.ready(cfg)) return { skipped: 'mp2_not_configured', queued: queued.length };
  let sent = 0, dup = 0, failed = 0, retry = 0, split = 0;
  outer: for (const q of queued) {
    const { list, split: didSplit } = prepare(q);
    if (didSplit) split++;
    for (const s of list) {
      // 每次尝试先把序号落盘，保证 requestId（jmdesk-<id>-<n>）永不复用：复用会被 MP2 回放旧回执且没有 result
      const attempt = (s.attempts || 0) + 1;
      store.updateSignal(s.id, { attempts: attempt, lastAttemptAt: new Date().toISOString() });
      try {
        const r = await mp2.submit(cfg, s, attempt);
        store.updateSignal(s.id, { status: 'submitted', batchId: r.batchId, batchStatus: r.batchStatus, duplicate: r.duplicate, receiptId: r.receiptId, requestId: r.requestId, submittedAt: new Date().toISOString(), lastError: null, lastErrorCode: null });
        store.log('moved', `搬运 · ${short(s.title)} → MP2 个人需求池`, { source: s.source_type, signal: s.id, batch: r.batchId });
        r.duplicate ? dup++ : sent++;
      } catch (e) {
        failed++;
        if (!e.final) retry++;
        // 400/403 等 final：标 failed 不再重试；5xx / 网关 / 回放无结果 / 网络：留在 queued，下一轮换新 requestId
        store.updateSignal(s.id, { status: e.final ? 'failed' : 'queued', lastError: e.message, lastErrorCode: e.code || null });
        store.log('error', `搬运失败 · ${short(s.title)}：${short(e.message)}`, { signal: s.id });
        if (e.stop) break outer; // 凭据失效，后面的不用试了
      }
    }
  }
  return { sent, duplicate: dup, failed, retry, split, remaining: store.listSignals('queued').length };
}

export function status() {
  const cfg = store.config(), st = store.state();
  const all = store.listSignals();
  const count = s => all.filter(x => x.status === s).length;
  return {
    home: store.HOME,
    sources: Object.fromEntries(Object.entries(cfg.sources).map(([k, v]) => [k, { enabled: !!v.enabled, label: v.label, cursor: st.cursors[k] || null }])),
    mp2: { configured: mp2.ready(cfg), baseUrl: cfg.mp2.baseUrl },
    outbox: { queued: count('queued'), submitted: count('submitted'), failed: count('failed'), split: count('split') },
    lastRun: st.runs.at(-1) || null,
  };
}

