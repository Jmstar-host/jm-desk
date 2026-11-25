# JM Desk 平台接入规范 v1（`jm-desk/1`）

业务平台（需求管理平台，以后的 ERP 等）按本文开放接口，JM Desk 就能：

1. 读出平台**实时**的结构和配置（有哪些对象、层级、下拉选项）；
2. 按平台给出的**录入结构**展示和编辑记录，AI 也按这个结构录入；
3. 确认后推送，推送时**核对版本**，不会覆盖别人的修改。

JM Desk 不再写死任何平台的字段。平台改了表单、加了字段、调了选项，JM Desk 下次读结构时自动跟上。

**接入是双向的，二选一：**

| 方式 | 谁来做 | 适合 |
|---|---|---|
| **规范模式**（`contract`） | 平台按本文开放第 1–8 节的接口，JM Desk 读到什么就展示什么 | 自己能改的平台（需求管理平台） |
| **适配模式**（`adapter`） | 平台不改，JM Desk 按平台现有的接口写一份适配配置：哪些对象、哪些字段、读写各用哪个接口、字段怎么对应 | 改不了的平台（ERP 等第三方） |

两种方式在 JM Desk 里看起来一样：左上角切换平台，左边是平台的结构，右边按平台的字段录入。需求管理平台现在是适配模式（JM Desk 按它现有的接口适配），平台实现本规范后切到规范模式。

本文只规定接口的形状。认证、授权、回执沿用 [PLATFORM-CONNECT.md](PLATFORM-CONNECT.md)：设备授权拿到连接凭据，所有调用经 `POST /api/ai-access/call`（字段一律 snake_case），平台按连接的授权和连接所有者本人的权限判断，写操作记回执。

---

## 0. 总则

- **一个对象类型 = 一张录入表单。** 例如需求管理平台的「原始需求」「研发项目」，ERP 的「客户」「商机」。
- **字段名就是接口上的字段名。** 结构里的 `key` 与读、写接口的 JSON 字段一一对应，JM Desk 不做映射。
- **按连接裁剪。** 结构、选项、树只返回**这个连接能看到、能写**的部分：负责范围外的平台产品不出现在下拉里，没有写权限的对象 `can.create = false`。JM Desk 只展示平台给的，不自己猜。
- **结构有版本号。** 每份结构带 `schema_rev`，平台改了表单就变。JM Desk 缓存结构，`schema_rev` 变了才重新读。
- **只读接口不产生数据。** 第 1–5 节都是 GET，不写回执以外的任何东西。

需要平台新增的操作（经 AI 通道调用的 `operation_id`）：

| 操作 | 用途 | 节 |
|---|---|---|
| `GET:/api/v1/desk/manifest` | 平台自述：有哪些对象类型、这个连接能做什么 | 1 |
| `GET:/api/v1/desk/schema/{type}` | 某类对象的录入结构 | 2 |
| `GET:/api/v1/desk/options/{source}` | 下拉、级联选项 | 3 |
| `GET:/api/v1/desk/tree` | 平台的层级树（左边导航） | 4 |
| `GET:/api/v1/desk/records/{type}`、`GET:/api/v1/desk/records/{type}/{id}` | 读记录（带版本号） | 5 |
| `POST:/api/v1/desk/validate/{type}` | 试填：只校验不保存 | 6 |
| 新建、修改 | 用平台现有的业务操作，在结构里声明（见 2.3）；修改必须支持版本核对 | 7 |
| `GET:/api/v1/desk/changes`（可选） | 增量变更，用来刷新 | 8 |

---

## 1. 平台自述 `GET:/api/v1/desk/manifest`

```json
{
  "contract": "jm-desk/1",
  "platform": { "id": "mp2", "name": "需求管理平台", "version": "2026.11.24", "web_base": "https://…" },
  "connection": { "id": "…", "owner_name": "…", "scope_label": "负责 12 个平台产品" },
  "objects": [
    { "type": "requirement", "label": "原始需求", "schema_rev": "r17",
      "parents": ["product"], "can": { "read": true, "create": true, "update": true },
      "record_url": "https://…/requirement?id={id}" },
    { "type": "project", "label": "研发项目", "schema_rev": "r9",
      "parents": ["product"], "can": { "read": true, "create": true, "update": true } }
  ],
  "tree": { "root_types": ["line"], "types": ["line", "product", "solution", "project"] }
}
```

- `can` 是这个连接**此刻**的真实能力：连接授权 ∩ 所有者本人权限 ∩ 负责范围。JM Desk 据此决定显示「新建」「修改」按钮。
- `record_url` 用来「在平台上查看」，`{id}` 由 JM Desk 替换。

## 2. 录入结构 `GET:/api/v1/desk/schema/{type}`

### 2.1 形状

```json
{
  "type": "requirement",
  "label": "原始需求",
  "schema_rev": "r17",
  "title_key": "title",
  "code_key": "requirement_code",
  "fields": [
    { "key": "title", "label": "需求标题", "type": "string", "required": true, "max_length": 200, "unique": true },
    { "key": "description", "label": "需求描述", "type": "text", "required": true, "max_length": 2000,
      "ai_hint": "用来源原文里的事实概括：现状、问题、期望。不要编造。" },
    { "key": "business_project_id", "label": "平台产品", "type": "ref", "required": true, "readonly": "never",
      "options": { "source": "products" } },
    { "key": "solution_id", "label": "方案", "type": "ref", "required": false,
      "options": { "source": "solutions", "params": { "product_id": "$business_project_id" } },
      "depends_on": ["business_project_id"] },
    { "key": "priority", "label": "优先级", "type": "enum", "required": true, "default": "P2",
      "enum": [{ "value": "P1", "label": "P1 - 高" }, { "value": "P2", "label": "P2 - 中" }, { "value": "P3", "label": "P3 - 低" }] },
    { "key": "expected_date", "label": "预期完成时间", "type": "date" },
    { "key": "status", "label": "状态", "type": "enum", "readonly": "always", "enum": [ … ] }
  ],
  "groups": [
    { "label": "基本信息", "keys": ["title", "description", "priority"] },
    { "label": "方案归属", "keys": ["business_project_id", "solution_id"] }
  ],
  "operations": {
    "read":   { "operation_id": "GET:/api/v1/desk/records/requirement/{id}" },
    "create": { "operation_id": "POST:/api/requirement", "fixed": { "source": "JM Desk" } },
    "update": { "operation_id": "PUT:/api/requirement/{id}", "mode": "replace", "version_key": "revision" }
  },
  "rules": [
    "标题在平台内唯一；重名时不要新建，改为让用户确认是不是同一条。",
    "原始需求要先澄清、拆分才能进入需求计划，AI 只建原始需求。"
  ]
}
```

### 2.2 字段

| 属性 | 说明 |
|---|---|
| `key` | 读写接口上的字段名（snake_case） |
| `label` | 和平台页面上一样的中文名 |
| `type` | `string` `text` `number` `date` `datetime` `bool` `url` `enum` `multi_enum` `ref` `multi_ref` `ref_tree` |
| `required` | 新建时必填 |
| `readonly` | `always`（平台管，只读）、`after_create`（新建后不能改）、`never` |
| `max_length` `min` `max` `pattern` | 校验，和平台后端同一条规则 |
| `enum` | 固定选项 `[{ value, label }]` |
| `options` | 选项来自接口：`{ source, params }`，`params` 里 `$字段名` 表示取表单里该字段的当前值 |
| `depends_on` | 这些字段变了，本字段的选项要重读、已选值要清空 |
| `default` | 新建时的默认值 |
| `unique` | 平台内唯一（JM Desk 新建前会先查重） |
| `ai_hint` | 给 AI 的填写说明：从哪类原文里取、取什么、不能怎么填 |
| `help` | 给人看的说明，显示在字段下方 |

### 2.3 操作

- `create` / `update` 指向平台**现有的业务操作**，写入、权限、回执都走平台原来的逻辑，不需要为 JM Desk 另写一套保存。
- `fixed`：JM Desk 新建时固定带上的值（例如来源 `JM Desk`）。
- `update.mode`：
  - `replace`：整体提交，没带的字段会被清空（例如现在的改项目）。JM Desk 会先读当前值，把改动盖上去再提交。
  - `patch`：只送改动的字段，没带的保持原值。**推荐**。
- `update.version_key`：版本号字段名，见第 7 节。**没有版本核对的对象，JM Desk 不提供修改。**

## 3. 选项 `GET:/api/v1/desk/options/{source}`

```json
{ "source": "products", "items": [
  { "value": 117, "label": "商城与支付", "path": ["示例产品线", "消费产品"] },
  { "value": 121, "label": "设备平台", "path": ["示例产品线", "终端产品"], "disabled": true, "reason": "已归档" }
] }
```

- 查询参数就是结构里 `options.params` 的值，例如 `?product_id=117`。
- **只返回这个连接可以选的项。** 负责范围外的平台产品、不可用的方案不出现；需要展示但不能选的，用 `disabled` + `reason`。
- `ref_tree` 类型的字段，`items` 里可以有 `children`。

## 4. 层级树 `GET:/api/v1/desk/tree`

```json
{ "nodes": [
  { "key": "line:3", "type": "line", "id": 3, "label": "示例产品线", "children": [
    { "key": "product:117", "type": "product", "id": 117, "label": "商城与支付", "code": "BP-MALL",
      "can": { "create": ["requirement", "project"] }, "counts": { "requirement": 12, "project": 2 },
      "children": [
        { "key": "project:1", "type": "project", "id": 1, "label": "…", "code": "PRJ-0001", "state": "active", "version": 3 }
      ] }
  ] }
] }
```

- 就是平台左树的那一棵，`type` 用第 1 节里的类型名。
- `can.create`：这个节点下，这个连接能新建哪些对象。JM Desk 只在这些节点上提供「录入到这里」。
- `counts`：和平台页面上同口径的数，JM Desk 直接显示，不自己数。
- 需求管理平台现有的 `GET:/api/v1/plans/portfolio/tree` 可以直接扩成这个形状。

## 5. 读记录

`GET:/api/v1/desk/records/{type}?parent=product:117&q=关键字&page=1&page_size=50`

```json
{ "total": 12, "items": [
  { "id": 1, "code": "REQ-0001", "version": 5, "updated_at": "2026-11-24T07:10:00Z", "updated_by": "…",
    "values":  { "title": "…", "business_project_id": 117, "priority": "P2", "status": "entered" },
    "display": { "business_project_id": "商城与支付", "priority": "P2 - 中", "status": "已录入" },
    "url": "https://…" }
] }
```

`GET:/api/v1/desk/records/{type}/{id}` 返回单条，形状同上。

- `values` 的键和结构里的 `key` 完全一致；`display` 是给人看的文字，JM Desk 不自己翻译编码。
- `version` 每次修改都会变。

## 6. 试填 `POST:/api/v1/desk/validate/{type}`

请求体：`{ "id": null 或已有 id, "values": { … } }`。只校验，不保存，不记业务数据。

```json
{ "ok": false, "errors": [
  { "key": "business_project_id", "code": "outside_responsibility_scope", "message": "这个平台产品不在负责范围里" },
  { "key": "title", "code": "duplicated", "message": "已有同名需求", "existing": { "id": 8, "code": "REQ-0008" } }
] }
```

AI 填完表单后先试填，把问题标在对应字段上给人看，人改好、确认后再真正提交。

## 7. 写入与版本核对

**新建**：调用结构里声明的 `create` 操作，请求体是 `values`（加上 `fixed`）。成功时返回新记录（同第 5 节的单条形状，含 `id`、`code`、`version`）。

**修改**：调用 `update` 操作，请求体带上**编辑开始时读到的版本号**（字段名是 `version_key`）。

- 版本一致：保存，返回新记录（含新 `version`）。
- 版本不一致：返回 **409**，`{ "detail": "version_conflict", "current": <第 5 节的单条> }`，不保存。JM Desk 把「你改的」和「平台现在的」并排给人选。

**错误**（都放在回执的 `detail` 里，字段级错误带 `key`）：

| HTTP | `detail` | 含义 |
|---|---|---|
| 400 | `field_invalid` + `errors[]` | 字段校验没过，同第 6 节 |
| 403 | `operation_not_granted` | 连接没勾这项操作 |
| 403 | `forbidden` | 连接所有者本人没有写权限 |
| 403 | `outside_responsibility_scope` + `key` | 超出负责范围 |
| 409 | `version_conflict` + `current` | 别人改过了 |
| 409 | `duplicated` + `existing` | 唯一字段重复 |

## 7.5 证据 `POST:/api/v1/desk/evidence/{type}/{id}`（建议）

人工 + AI 协同录入时，每个字段要能回答「依据是什么、谁确认的」。JM Desk 在本机记全证据链，推到平台时只带**摘录和出处**，不带聊天、邮件全文：

```json
{ "items": [
  { "key": "description", "by": "ai", "quote": "流量预警、单卡用量、激活数、卡状态变更四个API推送json",
    "source": { "kind": "feishu_im", "title": "IoT 对接群", "at": "2026-11-18T10:00:00Z" }, "verified": true, "confirmed_by": "me" },
  { "key": "expected_date", "by": "human" }
] }
```

- `by`：`ai`（AI 从线索补全）或 `human`（人工补充）；`verified`：原话在线索原文里核对上了。
- 平台把它挂在记录的「来源、关联与变更」里，审核人在平台上就能看到依据。
- 平台没实现这个接口之前，JM Desk 把同样的内容写进描述末尾的「字段依据」一段。

## 8. 变更（可选）`GET:/api/v1/desk/changes?since=<游标>`

`{ "cursor": "…", "items": [{ "type": "requirement", "id": 1, "version": 6, "op": "update" | "create" | "delete" }] }`

有这个接口时，JM Desk 只刷新变了的记录；没有时整体重读。

---

## 9. JM Desk 怎么用这些接口

1. **选平台**：读 manifest，列出这个平台有哪些对象、你能做什么。
2. **拉结构**：读树和各对象的结构（按 `schema_rev` 缓存）。
3. **展示**：左边是平台的树；右边按结构生成表单，字段、分组、下拉都和平台页面一致。本地整理出的内容进「待录入」清单，选好「录成哪类对象、挂在树上哪个节点」后按表单补全。
4. **AI 录入**：AI 拿到结构（含 `ai_hint`、`rules`）和原文，只填结构里有的字段；选项只能从选项接口返回的值里选。填完先试填（第 6 节），问题标在字段上。
5. **确认后推送**：列出这次改了哪些字段（改前 → 改后），人确认后提交，并带上版本号（第 7 节）。冲突时并排给人选，不自动覆盖。

## 10. 验收清单（平台实现后，JM Desk 逐条核对）

- [ ] manifest 的 `can` 随连接授权、所有者权限、负责范围变化
- [ ] 每个可写对象都有结构；字段 `key` 与读写接口一致；必填、长度和后端校验一致
- [ ] 负责范围外的选项不出现在选项接口里
- [ ] 树的 `counts` 与平台页面上的数一致
- [ ] 读记录带 `version`、`values`、`display`
- [ ] 试填返回字段级错误，不产生数据
- [ ] 修改带旧版本号时返回 409 和当前记录，不保存
- [ ] 新建、修改走平台原有业务操作，回执里能看到
