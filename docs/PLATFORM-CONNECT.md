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

### 1.1 从平台网页唤起 JM Desk（已实现）

平台可以在「关联本地助手」处放一个按钮，打开 `jmdesk://connect?base=<encodeURIComponent(平台地址)>`：

- 已安装 JM Desk 时，它被唤起并打开「关联需求管理平台账号」，地址已填好；用户核对后点「申请关联代码」，之后走上面的设备授权。
- **不会自动发起**：平台网页之外的任何页面也能触发 URL scheme，所以发起必须由用户在 JM Desk 里确认。
- `base` 只接受 http / https，不带账号密码；查询串和片段会被去掉。平台地址应填用户在浏览器里访问平台的地址（确认页 `verification_url` 由平台按该地址生成）。
- 没装 JM Desk 时浏览器不会有反应；平台页面应在 1–2 秒后提示「没有唤起？」并给出可复制的地址。

## 2. 接入后的统一约定

| 能力 | 接口 |
|---|---|
| 上下文 | `GET /api/ai-access/context`：当前账号、授权范围 |
| 操作目录 | `GET /api/ai-access/catalog`：只列出已授权的操作 |
| 调用 | `POST /api/ai-access/call`：`operation_id` + `request_id`（幂等）+ `task`，平台记回执。字段名一律 snake_case |
| MCP | 平台可以同时提供 MCP 端点（`config` 里的 `url`） |
| 送线索 | 见 [INTAKE-CONTRACT.md](INTAKE-CONTRACT.md) |
| 工作台对齐（只读） | `GET /api/v1/plans/portfolio/tree`（产品项目计划的树，含项目状态）、`GET /api/requirement/list?keyword=`（找需求）、`GET /api/v1/plans/targets/by-requirements?requirementIds=`（需求的状态、需求计划交付状态与排期、所属功能）。连接在平台上没有对应模块的读取授权时返回 `operation_not_granted`，JM Desk 退回业务产品树或提示 |

凭据只存在本机：凭据文件权限 0600，其他接入的密钥存在系统钥匙串；不进日志，也不发给模型。

## 2.1 工作台上传需求到需求管理平台（D87，已实现）

- 入口：工作台需求详情「上传到需求管理平台」；助手工具 `upload_work_mp2`（本机 AI 经本机 MCP 也可调用）。三处走同一个 `services.uploadWork`。
- 调用：AI 通道 `POST:/api/requirement`（原始需求新建），`source` 固定 `JM Desk`；`description` = 本地说明 + 上级 / 提出人 / 期望交付 + 依据线索标题（不含原文，原文走「收集」送个人需求池）；优先级 high/medium/low → P1/P2/P3；类型 feature/change/bug → 产品需求/优化/问题修复；`expected_date` 取交期。
- 平台产品：取工作的平台产品在产品树里的 MP2 id，写 `scope_type=product`、`scope_id`、`business_project_id`。关联设了负责范围时，MP2 按 `business_project_id` 拒绝范围外或未挂产品的新建（`outside_responsibility_scope`），JM Desk 提示先选平台产品；助手可带 `product` 参数一步改产品再上传。上传处的平台产品下拉只列负责范围内的产品：范围经关联的 MCP 端点 `mp2_context`（只读）读取，助手用 `list_mp2_upload_products`。
- 调用体字段一律 snake_case（`operation_id`、`request_id`）：MP2 全局 Jackson SNAKE_CASE，驼峰字段会被忽略并回 `operation_not_found`（2026-11-24 实测修正）。
- 成功后自动绑定（history 记「上传到需求管理平台 REQ-xxxx」）并读一次进度。MP2 标题唯一：重名不创建，返回同名候选，由人 / 助手确认后用绑定。每次写入用新的 `request_id`。
- 只上传「需求」；项目在 MP2 由产品项目计划维护，用绑定；待办、专项只在本地。

## 2.2 工作台以需求管理平台为准（D87，已实现）

- **拉取**（工作台「从需求管理平台拉取」，助手 `sync_mp2_tree`）：产品树 `GET /api/v1/plans/portfolio/tree`（项目节点带 `revision`、`requirement_ids`）+ 全部原始需求 `GET /api/requirement/list`（分页）。项目、需求落成工作台的工作（`m2j_` / `m2r_`，已对应的本地工作沿用原 id）；需求按 `requirement_ids` 挂到项目，其余挂在平台产品下；分组 = 产品线路径 › 平台产品。MP2 管的字段每次以平台为准（`workmodel.MP2_OWNED`，基线存 `mp2Base`）；平台上删了的标「找不到」，不删本地。
- **回写**（保存即回写；JM Desk 助手补充信息自动回写，本机 AI 仍逐次确认）：需求 `PUT /api/requirement/{id}` 只送改动字段（标题、说明、优先级、类型、期望交付、平台产品）；项目 `PUT /api/v1/plans/projects/{id}`（名称、计划结束，带 revision；平台产品创建后固定）。层级、上级、状态以平台为准，在 JM Desk 只读。回写失败本地照样保存、标「待回写」（`mp2Dirty`），下次保存或拉取时先重试，拉取不覆盖这些字段。
- **新建**：本地需求上传为原始需求（2.1）；本地项目 `POST /api/v1/plans/projects`（`source: product`）新建为平台研发项目。同名时不重复创建，给出候选。
- **待归入**：本地还没对应平台的项目 / 需求，以及顶层、没有平台产品的待办 / 专项，拉取后由 AI 给建议（`mp2Suggest`：bind 对应已有 / create 新建到某平台产品 / anchor 归到某平台产品），只接受产品树里真实存在的产品、项目、需求；人点「按建议」或助手 `apply_mp2_suggestion` 后才生效。对应到已拉取的记录时，拉取副本并进本地那条（`foldMp2Duplicates`）。
- AI 整理（汇总 / AI 整理）只能用产品树里的平台产品名，认不出的不写（留 `anchorHint`）；不改平台记录上 MP2 管的字段。

## 3. 规划中（尚未实现）

- **平台发码**：用户在平台上生成接入码，粘贴到 JM Desk。
- **邮箱反向接入**：用户在 JM Desk 里输入账号邮箱，再用邮件验证码或在平台内批准。
- **平台发现**：`GET {base}/.well-known/jm-desk.json` → `{ name, icon, connect, api_base, version }`。
