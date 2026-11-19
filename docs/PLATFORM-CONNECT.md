# 平台接入契约（JM Desk ⇄ 业务平台）

本地 AI 空间只有 JM Desk。业务平台只做三件事：**认人、授权、记账**；工具集成、派活都在 JM Desk 里完成。平台按本文实现，就能被 JM Desk 接入。

## 1. 关联账号：设备授权（已实现）

参照 RFC 8628。实现在 `src/mp2link.mjs`，测试用的假平台在 `test/mock-mp2.mjs`。

1. JM Desk 在本机生成 `secret`（43–128 位 `[A-Za-z0-9_-]`，只存本机），调用 `POST {base}/api/ai-access/device-links`，不需要登录：
   - 请求体：`{ "client_name": "JM Desk", "device_name": "<主机名>", "secret": "<secret>" }`
   - 返回：`{ id, user_code, verification_url, expires_at, interval }`。`user_code` 形如 `ABCD-EFGH`，有效期 10 分钟。
2. JM Desk 显示 `user_code`，并打开 `verification_url`。用户登录平台，核对代码，选好有效期，点「允许」或「拒绝」。
3. JM Desk 每隔 `interval` 秒调用一次 `POST {base}/api/ai-access/device-links/{id}/token`，请求头带 `X-MP2-Link-Secret: <secret>`。可能的返回：
   - `{ "status": "pending" }`：继续等。
   - `{ "status": "slow_down" }`：查询间隔加 5 秒。
   - `{ "status": "connected", "connection_id", "config" }`：只返回这一次。JM Desk 把 `config` 原样写入本机凭据文件（独占创建，权限 0600），不读进模型上下文，不写日志。
   - `{ "status": "denied" }` 或 `{ "status": "expired" }`：停止，提示用户重新发起。
4. 错误：
   - 400 `invalid_device_link`
   - 429 `device_link_limit`
   - 403 `device_link_secret_required`
   - 404 `device_link_not_found`
   - 错误码放在响应体的 `detail` 字段里。
5. `config` 采用 MCP 配置格式（`{ mcpServers: { <名字>: { url, headers } } }`）。JM Desk 会把它自动登记为一个内置的 MCP 接入，并用它调用平台的 AI 接口。
6. **断开**：本机直接删除凭据文件。**撤销**：在平台页面上操作；之后 JM Desk 收到 401，会提示用户重新关联。

## 2. 接入后的统一约定

| 能力 | 接口 |
|---|---|
| 上下文 | `GET /api/ai-access/context`：当前账号、授权范围 |
| 操作目录 | `GET /api/ai-access/catalog`：只列出已授权的操作 |
| 调用 | `POST /api/ai-access/call`：`operationId` + `requestId`（幂等）+ `task`，平台记回执 |
| MCP | 平台可以同时提供 MCP 端点（`config` 里的 `url`） |
| 送线索 | 见 [INTAKE-CONTRACT.md](INTAKE-CONTRACT.md) |

凭据只存在本机：凭据文件权限 0600，其他接入的密钥存在系统钥匙串；不进日志，也不发给模型。

## 3. 规划中（尚未实现）

- **平台发码**：用户在平台上生成接入码，粘贴到 JM Desk。
- **邮箱反向接入**：用户在 JM Desk 里输入账号邮箱，再用邮件验证码或在平台内批准。
- **平台发现**：`GET {base}/.well-known/jm-desk.json` → `{ name, icon, connect, api_base, version }`。
