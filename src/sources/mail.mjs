/* 邮件：只读 Mailspring 本地库（sqlite ?mode=ro），不经过网络。
 * 取「上次之后收到、不是我发的、不是草稿、不是自动通知」的邮件，一封一条信号。 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { run } from '../run.mjs';
import { sha, htmlToText, splitSignal, AUTO } from '../text.mjs';

const DB = process.env.JM_MAILSPRING_DB || path.join(os.homedir(), 'Library/Application Support/Mailspring/edgehill.db');
const AUTO_SUBJ = /alert|告警|预警|周切结果报告|report|notification|日报|daily|payment records/i;

async function q(sql) {
  const { stdout } = await run('sqlite3', ['-json', `file:${DB}?mode=ro`, sql], { timeout: 60000 });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

export async function collectMail({ since, until, limit = 200 }) {
  if (!fs.existsSync(DB)) return { signals: [], skipped: 0, note: '没有找到 Mailspring 数据库' };
  const accounts = await q(`select json_extract(data,'$.emailAddress') e from Account`);
  const mine = new Set(accounts.map(a => String(a.e || '').toLowerCase()));
  const s = Math.floor(since.getTime() / 1000), u = Math.floor(until.getTime() / 1000);
  const rows = await q(`select m.id, m.threadId, m.subject, m.date, m.headerMessageId hid,
      json_extract(m.data,'$.from[0].email') fe, json_extract(m.data,'$.from[0].name') fn, json_extract(m.data,'$.snippet') snip,
      (select json_group_array(json_extract(t.value,'$.name')) from json_each(m.data,'$.to') t) tos, b.value body
    from Message m left join MessageBody b on b.id = m.id
    where m.draft = 0 and m.date > ${s} and m.date <= ${u}
    order by m.date asc limit ${Math.max(1, Math.min(1000, +limit))}`);
  const out = []; let skipped = 0;
  for (const r of rows) {
    const from = String(r.fe || '').toLowerCase();
    if (mine.has(from) || AUTO.test(from) || AUTO_SUBJ.test(r.subject || '')) { skipped++; continue; }
    const text = htmlToText(r.body) || r.snip || '';
    if (!text.trim()) { skipped++; continue; }
    // 标题（主题）≤200；长邮件按段落拆成多条，不截断
    out.push(...splitSignal({
      id: sha(`mail|${r.hid || r.id}`),
      source_type: 'mail', source_ref: r.hid || r.id, source_url: null,
      title: `邮件 · ${r.subject || '(无主题)'}`, occurred_at: new Date(r.date * 1000).toISOString(),
      participants: [r.fn || r.fe].filter(Boolean),
      content: `发件人：${r.fn || ''} <${r.fe || ''}>\n收件人：${(JSON.parse(r.tos || '[]') || []).filter(Boolean).join('、')}\n主题：${r.subject || ''}\n\n${text}`,
      meta: { thread_id: r.threadId, body_loaded: !!r.body },
    }));
  }
  return { signals: out, skipped };
}
