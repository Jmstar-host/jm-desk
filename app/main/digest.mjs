/* 把一条线索（信号）整理成列表能用的样子：要点预览、人、条数；详情里的聊天记录 / 邮件正文。
 * 只做本地文本解析，不调模型。 */
const PLACEHOLDER = /^[（(][^）)]{1,8}[）)]$/;            // （图片）（表情）（文件）这类占位
const IM_LINE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*([^：:]{1,40})[：:]\s?(.*)$/;
const SRC = { mail: '邮件', feishu_im: '飞书', feishu_meeting: '会议' };

/* 飞书导出里的图片是一长串 key：[Image: img_v3_…]、（image）——统一显示成「图片」 */
const tidy = t => String(t || '').replace(/\[Image:\s*[^\]]*\]/gi, '[图片]').replace(/^[（(]\s*(image|图片|img)\s*[）)]$/i, '（图片）').trim();
const onlyMedia = t => PLACEHOLDER.test(t) || /^(\[图片\]\s*)+$/.test(t);
export function parseIm(content) {
  const msgs = [];
  for (const raw of String(content || '').split('\n')) {
    const m = raw.match(IM_LINE);
    if (m) msgs.push({ at: m[1], who: m[2].trim(), text: tidy(m[3]) });
    else if (raw.trim() && msgs.length) msgs[msgs.length - 1].text += '\n' + tidy(raw); // 多行消息
  }
  return msgs;
}
export function parseMail(content) {
  const lines = String(content || '').split('\n'), head = {};
  let i = 0;
  for (; i < Math.min(lines.length, 6); i++) {
    const m = lines[i].match(/^(发件人|主题|收件人|时间)[：:]\s*(.*)$/);
    if (m) head[m[1]] = m[2].trim(); else if (!lines[i].trim()) { i++; break; } else break;
  }
  const body = lines.slice(i).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { from: head['发件人'] || '', subject: head['主题'] || '', body };
}
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

/* 列表项：title（来源 + 会话名）、preview（真正说了什么）、people、count */
export function summarize(sig) {
  const base = { id: sig.id, source: sig.source_type, sourceLabel: SRC[sig.source_type] || sig.source_type, title: sig.title, at: sig.occurred_at || sig.collectedAt,
    status: sig.status, url: sig.source_url || null, chars: String(sig.content || '').length };
  if (sig.source_type === 'feishu_im') {
    const msgs = parseIm(sig.content), real = msgs.filter(m => !onlyMedia(m.text) && m.text.length > 1);
    const pick = real.slice(-3).map(m => `${m.who}：${clean(m.text)}`).join(' / ');
    return { ...base, title: sig.title.replace(/^飞书(单聊|群聊)\s*·\s*/, ''), kind: sig.title.includes('群聊') ? '群聊' : '单聊',
      preview: (pick || '（只有图片或表情）').slice(0, 160), people: [...new Set(msgs.map(m => m.who))].slice(0, 6), count: msgs.length };
  }
  if (sig.source_type === 'mail') {
    const m = parseMail(sig.content);
    const firstPara = m.body.split(/\n\s*\n/).map(clean).find(p => p.length > 8) || clean(m.body);
    return { ...base, title: m.subject || sig.title.replace(/^邮件\s*·\s*/, ''), kind: '邮件', preview: firstPara.slice(0, 160),
      people: [m.from.replace(/\s*<[^>]*>\s*/, '') || (sig.participants || [])[0] || ''].filter(Boolean), count: 1 };
  }
  return { ...base, kind: SRC[sig.source_type] || '', preview: clean(sig.content).slice(0, 160), people: (sig.participants || []).slice(0, 6), count: 1 };
}

/* 详情：聊天按条、邮件拆信头和正文 */
export function detail(sig) {
  const s = summarize(sig);
  if (sig.source_type === 'feishu_im') return { ...s, messages: parseIm(sig.content) };
  if (sig.source_type === 'mail') { const m = parseMail(sig.content); return { ...s, mail: { from: m.from, subject: m.subject, body: m.body.slice(0, 30000) } }; }
  return { ...s, text: String(sig.content || '').slice(0, 30000) };
}
