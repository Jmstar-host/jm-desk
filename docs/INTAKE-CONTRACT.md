# 平台接收线索的接口契约

JM Desk 的「搬运」会把用户本机收集到的线索（邮件、飞书消息、会议纪要）送进业务平台的**个人需求池**。任何平台按本文实现，就能接收。实现参考：`src/mp2.mjs`；测试用的假平台：`test/mock-mp2.mjs`。

## 1. 原则

- 原文只由用户本机以本人身份读取后送出；平台不主动去拉用户的邮箱或聊天。
- 平台把线索变成**候选需求**，放进提交人自己的需求池。**候选进池只能由本人在平台页面上确认**，AI 连接不能调用确认、驳回接口。
- 回执里只记标题，不存原文。

## 2. 送一条线索

经平台的 AI 调用通道：`POST {base}/api/ai-access/call`，`Authorization: Bearer <关联账号时拿到的凭据>`。

```json
{ "operation_id": "POST:/api/meeting-intake/sources", "request_id": "jmdesk-<线索 id>-<第几次尝试>", "task": "把来源内容送入个人需求池",
  "body": {
    "source_type": "feishu_im | feishu_meeting | mail",
    "source_ref": "来源方唯一标识（≤255）",
    "source_url": "可空，http(s) 原文链接（≤1000）",
    "title": "≤200 字",
    "occurred_at": "ISO 8601，可空",
    "participants": ["发起人 / 发件人"],
    "content": "原文纯文本，≤20000 字（UTF-16 计数）",
    "collector": "jm-desk/<版本>"
  } }
```

调用体的字段名用 snake_case（`operation_id`、`request_id`）：需求管理平台全局按 snake_case 解析，驼峰写法会被忽略并返回 `operation_not_found`。

平台的处理要求：
1. **校验**：`source_type` 只能是上面三个值；`source_ref`、`title`、`content` 必填；超长返回 400 `content_too_long`，不要静默截断。
2. **幂等**：同一用户、同一 `source_type + source_ref` 已有批次时，返回原批次，并带 `duplicate: true`。
3. **提交人**：提交人是 AI 连接的所属用户，不能由请求体指定。
4. **返回**：`{ "batch_id": 123, "status": "extracting", "duplicate": false }`。

JM Desk 一侧的行为：
- **重试**：每次尝试都换新的 `request_id`。只有回执成功、HTTP 码为 2xx、并且结果里带 `batch_id`，才算送达。
- **按状态码处理**：
  - 401：停止本轮。
  - 400 / 403 / 413 / 422：标记失败，不再重试。
  - 其他错误：留到下一轮再送。
- **超长正文**：按章节、段落拆成多段，每段 ≤20000 字。`source_ref` 加 `#partK`，标题加 `（K/N）`。

## 3. 只读接口

- `GET:/api/meeting-intake/batches/{id}`：查一个批次的处理状态。
- `GET:/api/meeting-intake/my-candidates?status=pending|pooled|rejected&source_type=&page=&size=`：返回 `{ total, items, summary }`，只包含当前用户的候选。

## 4. 授权

用户在平台上给这个连接授权「需求」模块的「新建」和「查看」即可，不需要更新或删除权限。
