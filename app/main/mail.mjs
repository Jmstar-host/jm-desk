/* 邮件连接器：只读打开 Mailspring 本地库（node:sqlite，macOS / Windows / Linux 通用）。不联网、不改邮件状态。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
const AUTO = /(^|[._-])(no-?reply|do-?not-?reply|noreply|notification|notify|alert|alerts|monitor|system|bounce|mailer-daemon|postmaster|newsletter|marketing|bussiness|business)([._-]|@)/i;
const AUTO_SUBJ = /alert|告警|预警|周切结果报告|report|notification|日报|daily|payment records|otp|verification/i;

export function mailspringDb(custom) {
  if (custom) return custom;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/Mailspring/edgehill.db');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData/Roaming'), 'Mailspring/edgehill.db');
  return path.join(home, '.config/Mailspring/edgehill.db');
}
export function mailspringApp() {
  if (process.platform === 'darwin') return '/Applications/Mailspring.app';
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || '', 'Mailspring', 'Mailspring.exe');
  return '/usr/bin/mailspring';
}
async function open(file) {
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}
function htmlToText(html) {
  return String(html || '').replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}
const toDate = v => (v == null ? null : new Date(v > 1e12 ? v : v * 1000));

export async function stats(dbFile) {
  const db = await open(mailspringDb(dbFile));
  if (!db) return { available: false };
  try {
    const mine = new Set(db.prepare(`select json_extract(data,'$.emailAddress') e from Account`).all().map(r => String(r.e || '').toLowerCase()));
    const rows = db.prepare(`select t.id, t.subject, t.snippet, json_extract(t.data,'$.participants') p, t.lastMessageReceivedTimestamp ts, t.hasAttachments att
      from ThreadCategory tc join Folder f on f.id = tc.value join Thread t on t.id = tc.id
      where f.role = 'inbox' and tc.unread > 0 order by t.lastMessageReceivedTimestamp desc limit 800`).all();
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const out = { available: true, total: rows.length, today: 0, yesterday: 0, week: 0, older: 0, auto: 0, human: 0, attach: 0, threads: [] };
    const senders = {};
    for (const r of rows) {
      let ps = []; try { ps = JSON.parse(r.p || '[]'); } catch {}
      const c = ps.find(x => x.email && !mine.has(String(x.email).toLowerCase())) || ps[0] || {};
      const email = String(c.email || '').toLowerCase(), name = (c.name || '').trim() || email;
      const d = toDate(r.ts), t = d ? d.getTime() : 0;
      if (t >= day0) out.today++; else if (t >= day0 - 864e5) out.yesterday++; else if (t >= day0 - 6 * 864e5) out.week++; else out.older++;
      const auto = AUTO.test(email) || AUTO_SUBJ.test(r.subject || '');
      auto ? out.auto++ : out.human++;
      if (r.att) out.attach++;
      senders[name] = (senders[name] || 0) + 1;
      if (out.threads.length < 60) out.threads.push({ id: r.id, subject: r.subject || '(无主题)', snippet: (r.snippet || '').slice(0, 140), from: name, email, at: d && d.toISOString(), auto });
    }
    out.top = Object.entries(senders).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => ({ name: n, count: c }));
    return out;
  } finally { db.close(); }
}

export async function collect({ since, until, dbFile, limit = 200 }) {
  const db = await open(mailspringDb(dbFile));
  if (!db) return { signals: [], skipped: 0, note: '没有找到 Mailspring 数据库' };
  try {
    const mine = new Set(db.prepare(`select json_extract(data,'$.emailAddress') e from Account`).all().map(r => String(r.e || '').toLowerCase()));
    const rows = db.prepare(`select m.id, m.threadId, m.subject, m.date, m.headerMessageId hid,
        json_extract(m.data,'$.from[0].email') fe, json_extract(m.data,'$.from[0].name') fn, json_extract(m.data,'$.snippet') snip, b.value body
      from Message m left join MessageBody b on b.id = m.id
      where m.draft = 0 and m.date > ? and m.date <= ? order by m.date asc limit ?`).all(Math.floor(since / 1000), Math.floor(until / 1000), Math.max(1, Math.min(1000, limit)));
    const signals = []; let skipped = 0;
    for (const r of rows) {
      const from = String(r.fe || '').toLowerCase();
      if (mine.has(from) || AUTO.test(from) || AUTO_SUBJ.test(r.subject || '')) { skipped++; continue; }
      const text = htmlToText(r.body) || r.snip || '';
      if (!text.trim()) { skipped++; continue; }
      signals.push({
        id: sha(`mail|${r.hid || r.id}`), source_type: 'mail', source_ref: String(r.hid || r.id).slice(0, 255), source_url: null,
        title: `邮件 · ${r.subject || '(无主题)'}`.slice(0, 200), occurred_at: toDate(r.date).toISOString(), participants: [r.fn || r.fe].filter(Boolean),
        content: `发件人：${r.fn || ''} <${r.fe || ''}>\n主题：${r.subject || ''}\n\n${text}`.slice(0, 12000), meta: { thread_id: r.threadId },
      });
    }
    return { signals, skipped };
  } finally { db.close(); }
}
