/* 飞书：以本人身份只读（lark-cli --as user）
 * - feishu_im：@我的消息 + 单聊消息，按会话聚合成一条信号（同一会话同一时间窗一条）
 * - feishu_meeting：已结束会议的纪要/逐字稿；没有纪要的会议跳过 */
import { lark } from '../run.mjs';
import { sha, splitSignal } from '../text.mjs';

const fmt = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`; };
const day = d => fmt(d).slice(0, 10);
const toIso = s => { const d = new Date(String(s).replace(' ', 'T') + (String(s).length <= 16 ? ':00+08:00' : '')); return isNaN(d) ? null : d.toISOString(); };

let me = null;
async function myOpenId() {
  if (me) return me;
  const d = await lark(['auth', 'status']);
  me = d?.identities?.user?.openId;
  if (!me || d?.identities?.user?.available === false) throw Object.assign(new Error('飞书用户身份未授权，请运行 lark-cli auth login'), { code: 'FEISHU_AUTH' });
  return me;
}

async function search(extra, since, until) {
  const all = []; let token = null;
  for (let page = 0; page < 10; page++) {
    const args = ['im', '+messages-search', '--as', 'user', '--start', fmt(since), '--end', fmt(until), '--format', 'json', '--no-reactions', ...extra];
    if (token) args.push('--page-token', token);
    const d = await lark(args);
    if (d.ok === false) throw new Error(d.error?.message || '飞书消息搜索失败');
    all.push(...(d.data?.messages || []));
    if (!d.data?.has_more || !d.data?.page_token) break;
    token = d.data.page_token;
  }
  return all;
}

export async function collectIm({ since, until, includeBots = false }) {
  const mine = await myOpenId();
  const atMe = await search(['--is-at-me'], since, until);
  const p2p = await search(['--chat-type', 'p2p'], since, until);
  const byChat = new Map();
  const seen = new Set();
  for (const [m, why] of [...atMe.map(m => [m, 'at_me']), ...p2p.map(m => [m, 'p2p'])]) {
    if (m.deleted || seen.has(m.message_id)) continue;
    seen.add(m.message_id);
    if (!includeBots && m.sender?.sender_type !== 'user') continue;
    const k = m.chat_id;
    const g = byChat.get(k) || { chat_id: k, chat_name: m.chat_name || '', chat_type: m.chat_type, why: new Set(), msgs: [], link: m.message_app_link };
    g.why.add(why); g.msgs.push(m); byChat.set(k, g);
  }
  const out = [];
  for (const g of byChat.values()) {
    const others = g.msgs.filter(m => m.sender?.id !== mine);
    if (!others.length) continue; // 只有我自己说话的会话不收
    g.msgs.sort((a, b) => String(a.create_time).localeCompare(String(b.create_time)));
    const who = [...new Set(others.map(m => m.sender?.name).filter(Boolean))];
    const title = g.chat_type === 'p2p' ? `飞书单聊 · ${who.join('、') || '对方'}` : `飞书群聊 · ${g.chat_name || '群'}（@我）`;
    const content = g.msgs.map(m => `[${m.create_time}] ${m.sender?.id === mine ? '我' : (m.sender?.name || '对方')}：${m.msg_type === 'text' || m.msg_type === 'post' ? m.content : `（${m.msg_type}）`}`).join('\n');
    const first = g.msgs[0], last = g.msgs[g.msgs.length - 1];
    // 不截断：超过 20000 字按行拆成多条（splitSignal），标题 ≤200（群名可能很长）
    out.push(...splitSignal({
      id: sha(`feishu_im|${g.chat_id}|${first.message_id}|${last.message_id}`),
      source_type: 'feishu_im', source_ref: `${g.chat_id}:${first.message_id}..${last.message_id}`,
      source_url: last.message_app_link || g.link || null,
      title, occurred_at: toIso(last.create_time), participants: who,
      content, meta: { messages: g.msgs.length, reasons: [...g.why] },
    }));
  }
  return out;
}

export async function collectMeetings({ since, until }) {
  const d = await lark(['vc', '+search', '--start', day(since), '--end', day(until), '--format', 'json']);
  const items = (d.data?.items || []).filter(i => i.id);
  if (!items.length) return { signals: [], skipped: 0 };
  const notes = await lark(['vc', '+notes', '--meeting-ids', items.map(i => i.id).join(','), '--format', 'json']).catch(e => ({ data: { notes: [] }, error: e }));
  const out = []; let skipped = 0;
  for (const n of notes.data?.notes || []) {
    const doc = n.verbatim_doc_token || n.note_doc_token; // 按 lark-vc 规范：提炼需求从逐字稿出发
    if (!doc) { skipped++; continue; }
    const meta = items.find(i => i.id === n.meeting_id);
    const titleLine = String(meta?.display_info || '').split('\n')[0] || '飞书会议';
    let text = '';
    try { const f = await lark(['docs', '+fetch', '--api-version', 'v2', '--doc', doc, '--doc-format', 'markdown']); text = f.data?.markdown || f.data?.content || ''; }
    catch { skipped++; continue; }
    if (!text.trim()) { skipped++; continue; }
    // MP2 WORKING_RULES：原文超过 20000 字按会议/话题拆分后分别送，不截断后加标记
    out.push(...splitSignal({
      id: sha(`feishu_meeting|${n.meeting_id}|${doc}`),
      source_type: 'feishu_meeting', source_ref: `${n.meeting_id}:${doc}`,
      source_url: meta?.meta_data?.app_link || null,
      title: `飞书会议 · ${titleLine}`, occurred_at: null, participants: [],
      content: text, meta: { doc_kind: n.verbatim_doc_token ? 'verbatim' : 'ai_note' },
    }));
  }
  return { signals: out, skipped };
}
