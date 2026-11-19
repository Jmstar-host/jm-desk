/* 线索列表：飞书聊天、邮件解析成预览和详情（样例内容为虚构） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, detail } from '../app/main/digest.mjs';

test('飞书单聊：标题去掉前缀，预览取最近几句真正的话，跳过图片占位', () => {
  const sig = { id: 'a', source_type: 'feishu_im', title: '飞书单聊 · 小明', status: 'queued', occurred_at: '2026-11-18T08:00:00Z',
    content: '[2026-11-18 16:00] 小明：（图片）\n[2026-11-18 16:01] 小明：接口下周一前要联调\n第二行补充\n[2026-11-18 16:02] 我：好的' };
  const s = summarize(sig);
  assert.equal(s.title, '小明'); assert.equal(s.kind, '单聊'); assert.equal(s.count, 3);
  assert.match(s.preview, /小明：接口下周一前要联调 第二行补充/); assert.doesNotMatch(s.preview, /图片/);
  assert.deepEqual(s.people, ['小明', '我']);
  const d = detail(sig); assert.equal(d.messages.length, 3); assert.equal(d.messages[1].text, '接口下周一前要联调\n第二行补充');
});

test('邮件：标题用主题，预览取正文第一段', () => {
  const sig = { id: 'b', source_type: 'mail', title: '邮件 · 报价确认', status: 'queued',
    content: '发件人：张三 <z@example.com>\n主题：报价确认\n\nHi\n\n请在周五前确认附件里的报价，谢谢。\n\n张三' };
  const s = summarize(sig);
  assert.equal(s.title, '报价确认'); assert.equal(s.preview, '请在周五前确认附件里的报价，谢谢。'); assert.deepEqual(s.people, ['张三']);
  assert.match(detail(sig).mail.body, /^Hi/);
});

test('飞书图片 key 显示成 [图片]，只有图片的消息不进预览', () => {
  const sig = { id: 'c', source_type: 'feishu_im', title: '飞书群聊 · 项目群（@我）', status: 'queued',
    content: '[2026-11-18 16:00] 小红：[Image: img_v3_0217i_abcdef-1234]\n[2026-11-18 16:01] 小红：[Image: img_v3_0217i_x] 看下这个报错\n[2026-11-18 16:02] 我：（image）' };
  const s = summarize(sig);
  assert.equal(s.preview, '小红：[图片] 看下这个报错'); assert.equal(s.kind, '群聊');
  assert.equal(detail(sig).messages[2].text, '（图片）');
});
