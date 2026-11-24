/* 通过 MP2 现有的 AI 接入通道送信号：POST {base}/api/ai-access/call
 * operationId = "POST:/api/meeting-intake/sources"（契约见 docs/INTAKE-CONTRACT.md）
 *
 * 真实 MP2 的行为（2026-11-17 按 MP2 源码核对）：
 * - 响应信封 `{ replayed, receipt: { status: 'succeeded'|'failed'|…, http_status, … }, result? }`。
 * - requestId 重复时只回 `{ replayed: true, receipt }`，没有 result，receipt 是「第一次」调用的（可能是失败的）。
 *   所以 requestId 必须每次尝试都不同：`jmdesk-<信号 id>-<第几次>`。换 requestId 重发是安全的——
 *   MP2 按 (owner, source_type, source_ref) 去重，返回原批次 + duplicate:true。
 * - 成功 result：`{ batch_id, duplicate, status }`，其中 status 是批次状态字符串（如 extracting），不是 HTTP 码；
 *   HTTP 码只看 receipt.http_status。失败 result：`{ status: <http>, detail: '<code>' }`。
 * 凭据文件由「关联需求管理平台账号」（mp2link.mjs，设备授权）写出（0600），这里只读，不打印。 */
import fs from 'node:fs';
import crypto from 'node:crypto';

export const OP_SOURCES = 'POST:/api/meeting-intake/sources';
export const OP_BATCH = 'GET:/api/meeting-intake/batches/{id}';
export const OP_MY_CANDIDATES = 'GET:/api/meeting-intake/my-candidates';

/* 不可重试的业务错误：校验失败（400/413/422）、未授权操作（403 operation_not_granted） */
const FINAL_HTTP = new Set([400, 403, 413, 422]);

/* 凭据文件内容：
 * - 设备授权得到的 MP2 config：{ mcpServers: { mp2: { url, headers: { Authorization: 'Bearer …' } } } }
 * - 旧的手工配置：{ token } 或纯文本 */
export function credential(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  let j; try { j = JSON.parse(raw); } catch { return raw; }
  const servers = j && typeof j.mcpServers === 'object' ? j.mcpServers : null;
  if (servers) {
    for (const s of [servers.mp2, ...Object.values(servers)]) {
      const h = s?.headers?.Authorization || s?.headers?.authorization;
      if (typeof h === 'string' && h.trim()) return h.trim().replace(/^Bearer\s+/i, '');
    }
  }
  return j.token || j.credential || j.access_token || j.secret;
}

export function ready(cfg) { return !!(cfg.mp2?.baseUrl && cfg.mp2?.credentialFile && fs.existsSync(cfg.mp2.credentialFile)); }

const fail = (message, { status = null, code, final = false, stop = false, receiptId = null } = {}) =>
  Object.assign(new Error(message), { status, code, final, stop, receiptId });

/* MP2 全局 Jackson SNAKE_CASE：调用体字段必须是 operation_id / request_id / run_id / depends_on。
 * 驼峰的 operationId 会被忽略，MP2 当作空操作回 404 operation_not_found（2026-11-24 对本机 MP2 实测）。 */
const WIRE = { operationId: 'operation_id', requestId: 'request_id', runId: 'run_id', dependsOn: 'depends_on' };
export const wire = payload => Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined).map(([k, v]) => [WIRE[k] || k, v]));

/* 调一次 AI 通道，返回 { http, receipt, result, replayed }；HTTP 码以 receipt.http_status 为准 */
async function call(cfg, payload, timeoutMs) {
  let res;
  try {
    res = await fetch(cfg.mp2.baseUrl.replace(/\/$/, '') + '/api/ai-access/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential(cfg.mp2.credentialFile) },
      body: JSON.stringify(wire(payload)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw fail(`MP2 连接失败：${e.name === 'TimeoutError' ? '超时' : e.message}`, { code: 'network_error' });
  }
  const j = await res.json().catch(() => null);
  if (res.status === 401) throw fail('MP2 拒绝：unauthorized', { status: 401, code: j?.code || 'unauthorized', stop: true });
  if (!j || typeof j !== 'object' || !j.receipt) {
    // 网关 502/504、非 JSON、没有回执：MP2 没有确认收到，下一轮换 requestId 重试
    const status = res.status;
    const code = j?.detail || j?.code || (res.ok ? 'missing_receipt' : `http_${status}`);
    throw fail(`MP2 无回执：${code}`, { status, code, final: FINAL_HTTP.has(status) });
  }
  const receipt = j.receipt;
  // receipt.http_status 是唯一权威；只有它缺失时才退回失败 result 里的数字 status（成功 result.status 是批次状态字符串，不会被当成 HTTP 码）
  const http = Number(receipt.http_status ?? (typeof j.result?.status === 'number' ? j.result.status : res.status));
  return { http, receipt, result: j.result, replayed: !!j.replayed, outer: res.status };
}

/* 失败 result → 错误；校验/授权类为 final（标记 failed 不重试），其余保留待发 */
function rejectFromResult(http, receipt, result) {
  const detail = result?.detail || result?.code || receipt?.error_code || receipt?.detail || `HTTP ${http}`;
  const code = detail === 'required_field_missing' && result?.field ? `required_field_missing:${result.field}` : detail;
  return fail(`MP2 拒绝：${code}`, { status: http, code, final: FINAL_HTTP.has(http), stop: http === 401, receiptId: receipt?.id ?? null });
}

export const requestIdFor = (sig, attempt = 1) => `jmdesk-${sig.id}-${attempt}`;

/* 送一条来源。attempt 由调用方持久化并每次 +1，保证 requestId 每次都不同。
 * 只有 receipt.status==='succeeded' 且 2xx 且 result 带 batch_id 才算送达；其他一律抛错。 */
export async function submit(cfg, sig, attempt = 1) {
  const body = {
    source_type: sig.source_type, source_ref: sig.source_ref, source_url: sig.source_url, title: sig.title,
    occurred_at: sig.occurred_at, participants: sig.participants, content: sig.content, collector: 'jm-desk-space/0.1',
  };
  const requestId = requestIdFor(sig, attempt);
  const { http, receipt, result, replayed } = await call(cfg, { operationId: OP_SOURCES, body, requestId, task: '桌面 AI 空间：把来源内容送入个人需求池' }, 60000);
  if (replayed && result === undefined) {
    // 回放只有原回执、没有 result：不知道批次号，绝不能当成已送达；下一轮换新 requestId 重发（MP2 按 source_ref 去重）
    throw fail(`MP2 回放了旧回执（${receipt.status || 'unknown'}），未拿到结果`, { status: http, code: 'replayed_without_result', receiptId: receipt.id ?? null });
  }
  if (http >= 300 || receipt.status !== 'succeeded') {
    if (http >= 300) throw rejectFromResult(http, receipt, result);
    throw fail(`MP2 回执状态 ${receipt.status || 'unknown'}`, { status: http, code: `receipt_${receipt.status || 'unknown'}`, receiptId: receipt.id ?? null });
  }
  const r = (result && typeof result.body === 'object' && result.body) || result || {};
  if (r.batch_id == null) throw fail('MP2 成功回执但没有 batch_id', { status: http, code: 'missing_batch_id', receiptId: receipt.id ?? null });
  return {
    batchId: r.batch_id, duplicate: !!r.duplicate,
    batchStatus: typeof r.status === 'string' ? r.status : null, // 批次状态，不是 HTTP 码
    receiptId: receipt.id ?? null, requestId,
  };
}

const readId = what => `jmdesk-${what}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

/* 查批次结果（候选数量），给精灵显示「搬成了几条候选需求」。
 * 批次不存在时 MP2 回 200 + {error:'batch not found'} → 返回 null；完成时 status === 'completed'，phase 是中文标签。 */
export async function batch(cfg, batchId) {
  const { http, receipt, result } = await call(cfg, { operationId: OP_BATCH, path: { id: batchId }, requestId: readId(`batch-${batchId}`) }, 30000);
  if (http >= 300 || receipt.status !== 'succeeded') throw rejectFromResult(http, receipt, result);
  const b = (result && typeof result.body === 'object' && result.body) || result;
  if (!b || b.error) return null;
  const candidates = Array.isArray(b.candidates) ? b.candidates : [];
  return { ...b, id: b.id ?? batchId, status: b.status ?? null, phase: b.phase ?? null, done: b.status === 'completed', candidateCount: b.candidate_count ?? candidates.length };
}

/* 本人的候选（个人需求池）。MP2 的状态是 pending | pooled | rejected；旧文档里的 confirmed 等同 pooled。 */
const CANDIDATE_STATUS = { pending: 'pending', pooled: 'pooled', confirmed: 'pooled', rejected: 'rejected' };
export async function myCandidates(cfg, { status, source_type, page, size } = {}) {
  const query = {};
  if (status != null) {
    if (!CANDIDATE_STATUS[status]) throw fail(`未知候选状态：${status}`, { code: 'invalid_status', final: true });
    query.status = CANDIDATE_STATUS[status];
  }
  if (source_type) query.source_type = source_type;
  if (page != null) query.page = page;
  if (size != null) query.size = size;
  const { http, receipt, result } = await call(cfg, { operationId: OP_MY_CANDIDATES, query, requestId: readId('candidates') }, 30000);
  if (http >= 300 || receipt.status !== 'succeeded') throw rejectFromResult(http, receipt, result);
  const r = (result && typeof result.body === 'object' && result.body) || result || {};
  // 候选的来源字段在 MP2 叫 source_kind
  return { total: r.total ?? 0, items: (r.items || []).map(i => ({ ...i, source_type: i.source_type ?? i.source_kind ?? null })), summary: r.summary ?? null };
}

/* 产品树（产品线 › 类目 › 平台产品）：工作体系挂靠用。MP2 里这是只读的跨资源参照，AI 连接可以读、不能改。 */
export const OP_PRODUCT_TREE = 'GET:/api/business-product/tree';
export async function productTree(cfg) {
  const { http, receipt, result } = await call(cfg, { operationId: OP_PRODUCT_TREE, requestId: readId('tree') }, 30000);
  if (http >= 300 || receipt.status !== 'succeeded') throw rejectFromResult(http, receipt, result);
  return (result && typeof result.body === 'object' && result.body) || result || {};
}

/* ---------- 工作台对齐 MP2（D86，只读）：产品项目计划的树、需求搜索、需求的 MP2 进度 ---------- */
export const OP_PORTFOLIO_TREE = 'GET:/api/v1/plans/portfolio/tree';
export const OP_REQUIREMENT_LIST = 'GET:/api/requirement/list';
export const OP_REQUIREMENT_LINKS = 'GET:/api/v1/plans/targets/by-requirements';

async function read(cfg, operationId, { query, path, what, timeoutMs = 30000 } = {}) {
  const { http, receipt, result } = await call(cfg, { operationId, query, path, requestId: readId(what || 'read') }, timeoutMs);
  if (http >= 300 || receipt.status !== 'succeeded') throw rejectFromResult(http, receipt, result);
  return (result && typeof result.body === 'object' && result.body) || result;
}

/** 产品项目计划左树：{ origin, nodes:[{ key, kind: line|product|project, name, code, path, product_id, project_id, state, planned_start, planned_end, children }] } */
export async function portfolioTree(cfg) {
  const r = await read(cfg, OP_PORTFOLIO_TREE, { what: 'portfolio-tree', timeoutMs: 60000 });
  return { origin: r?.origin || null, nodes: Array.isArray(r?.nodes) ? r.nodes : [] };
}

/** 按关键词找 MP2 需求（编号或标题），最多 20 条：[{ id, code, title, status }] */
export async function searchRequirements(cfg, keyword) {
  const q = String(keyword || '').trim().slice(0, 80);
  if (!q) return [];
  const r = await read(cfg, OP_REQUIREMENT_LIST, { query: { keyword: q, page: 1, page_size: 20 }, what: 'req-search' });
  const rows = Array.isArray(r) ? r : r?.records || r?.items || r?.list || r?.data || [];
  return rows.slice(0, 20).map(x => ({ id: x.id, code: x.requirement_code || x.requirementCode || x.code || null, title: x.title || '', status: x.visible_status || x.status || null }))
    .filter(x => x.id != null);
}

/** 需求在 MP2 的进度：[{ requirement_id, code, title, status, visible_status, functions:[…], plans:[{ plan_code, plan_name, delivery_status, planned_start, planned_end }] }] */
export async function requirementLinks(cfg, ids) {
  const list = [...new Set((ids || []).map(Number).filter(Number.isFinite))].slice(0, 200);
  if (!list.length) return [];
  const r = await read(cfg, OP_REQUIREMENT_LINKS, { query: { requirementIds: list.join(',') }, what: 'req-links' });
  return Array.isArray(r) ? r : [];
}

/* ---------- 上传到需求管理平台（D87）：本地需求 → MP2 原始需求 ----------
 * 写操作。requestId 每次都新生成：重复的 requestId 只会回放旧回执、没有 result。
 * MP2 标题唯一：重名时返回 code=title_duplicated，调用方改为搜索后绑定，不重复创建。 */
export const OP_REQUIREMENT_CREATE = 'POST:/api/requirement';
export async function createRequirement(cfg, body) {
  const { http, receipt, result, replayed } = await call(cfg, { operationId: OP_REQUIREMENT_CREATE, body, requestId: readId('req-create'), task: 'JM Desk 工作台：把本地需求上传为原始需求' }, 30000);
  if (replayed && result === undefined) throw fail('MP2 回放了旧回执，未拿到结果', { status: http, code: 'replayed_without_result', receiptId: receipt.id ?? null });
  if (http >= 300 || receipt.status !== 'succeeded') {
    const e = rejectFromResult(http, receipt, result);
    if (/标题已存在|title.*(exist|duplicat)/i.test(`${e.message} ${result?.message || ''} ${result?.error || ''}`)) Object.assign(e, { code: 'title_duplicated', message: '需求管理平台已有同名需求' });
    else if (/operation_not_granted/.test(e.message)) e.message = '这个关联没有「原始需求」的新建权限：到需求管理平台「AI 接入」里给这个连接勾上';
    else if (/outside_responsibility_scope/.test(e.message)) e.message = '这条需求的平台产品不在这个关联的负责范围里：在工作台把平台产品改成负责范围内的，或到需求管理平台「AI 接入」调整负责范围';
    else if (http === 403 && !result?.message) e.message = OWNER_FORBIDDEN;
    else if (result?.message) e.message = `MP2 拒绝：${result.message}`;
    throw e;
  }
  const r = (result && typeof result.body === 'object' && result.body) || result || {};
  if (r.id == null) throw fail('MP2 成功回执但没有需求 id', { status: http, code: 'missing_id', receiptId: receipt.id ?? null });
  return { id: r.id, code: r.requirement_code || r.requirementCode || null, title: r.title || body.title, status: r.visible_status || r.status || null, receiptId: receipt.id ?? null };
}

/* 关联的负责范围（D87）：MP2 只允许在这些平台产品下新建原始需求。经关联得到的 MCP 端点读 mp2_context（只读）。
 * 返回 [{ id, name }]；空数组表示没有限定范围（任何平台产品都行）；凭据不是 MCP 配置时返回 null（未知）。 */
export async function responsibility(cfg) {
  let server;
  try { const j = JSON.parse(fs.readFileSync(cfg.mp2.credentialFile, 'utf8')); server = j?.mcpServers?.mp2 || Object.values(j?.mcpServers || {})[0]; } catch { return null; }
  if (!server?.url) return null;
  let res;
  try {
    res = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(server.headers || {}) }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mp2_context', arguments: { compact: true } } }) });
  } catch (e) { throw fail(`MP2 连接失败：${e.message}`, { code: 'network_error' }); }
  if (res.status === 401) throw fail('MP2 拒绝：unauthorized', { status: 401, code: 'unauthorized', stop: true });
  const j = await res.json().catch(() => null), text = j?.result?.content?.[0]?.text;
  let ctx; try { ctx = j?.result?.structuredContent?.connection ? j.result.structuredContent : JSON.parse(text); } catch { return null; }
  const scope = ctx?.connection?.scope;
  return Array.isArray(scope) ? scope.map(s => ({ id: Number(s.product_id), name: s.product_name || '' })).filter(s => Number.isFinite(s.id)) : null;
}

/* ---------- D87：工作台以 MP2 为准——拉取全部原始需求；回写需求 / 项目；新建项目 ---------- */
export const OP_REQUIREMENT_UPDATE = 'PUT:/api/requirement/{id}';
export const OP_PROJECT_CREATE = 'POST:/api/v1/plans/projects';
export const OP_PROJECT_UPDATE = 'PUT:/api/v1/plans/projects/{id}';
export const OP_PROJECT_LIST = 'GET:/api/v1/plans/projects';

/** 全部原始需求（分页拉完，最多 limit 条）：[{ id, code, title, description, priority, status, product_id, expected_date, deadline, requirement_type, updated_at }] */
export async function listRequirements(cfg, { pageSize = 200, limit = 5000 } = {}) {
  const out = [];
  for (let page = 1; out.length < limit; page++) {
    const r = await read(cfg, OP_REQUIREMENT_LIST, { query: { page, page_size: pageSize }, what: 'req-all', timeoutMs: 60000 });
    const rows = Array.isArray(r) ? r : r?.items || r?.records || [];
    for (const x of rows) if (x?.id != null) out.push({ id: x.id, code: x.requirement_code || null, title: x.title || '', description: x.description || '', priority: x.priority || null,
      status: x.status || null, product_id: x.business_project_id ?? null, expected_date: x.expected_date || null, deadline: x.deadline || null,
      requirement_type: x.requirement_type || null, updated_at: x.updated_at || null });
    const total = Number(r?.total);
    if (rows.length < pageSize || (Number.isFinite(total) && out.length >= total)) break;
  }
  return out.slice(0, limit);
}

/* 平台按「连接所有者」的权限判断写操作：连接勾了这项操作、但所有者的账号本身没有对应的写权限时回 403 forbidden */
const OWNER_FORBIDDEN = '你的需求管理平台账号没有这项写权限（AI 连接按账号本人的权限判断）：请管理员给账号开通，或在平台页面上由有权限的人操作';
/* 写操作的统一处理：成功回执才算；把常见拒绝原因翻成人话 */
async function write(cfg, operationId, { path, body, task }) {
  const { http, receipt, result, replayed } = await call(cfg, { operationId, path, body, requestId: readId('w'), task }, 30000);
  if (replayed && result === undefined) throw fail('MP2 回放了旧回执，未拿到结果', { status: http, code: 'replayed_without_result' });
  if (http >= 300 || receipt.status !== 'succeeded') {
    const e = rejectFromResult(http, receipt, result);
    if (/operation_not_granted/.test(e.message)) e.message = '这个关联没有这项操作的权限：到需求管理平台「AI 接入」里给这个连接勾上';
    else if (/outside_responsibility_scope/.test(e.message)) e.message = '平台产品不在这个关联的负责范围里';
    else if (http === 403) e.message = OWNER_FORBIDDEN;
    else if (/revision|conflict|已被修改/i.test(e.message) || http === 409) e.message = `需求管理平台上这条记录刚被别人改过，先「从需求管理平台拉取」再改（${e.message}）`;
    throw e;
  }
  return (result && typeof result.body === 'object' && result.body) || result || {};
}
/** 改原始需求：只送改动字段（MP2 对 null / 省略的字段保持原值）。 */
export const updateRequirement = (cfg, id, body) => write(cfg, OP_REQUIREMENT_UPDATE, { path: { id }, body, task: 'JM Desk 工作台：回写需求修改' });
/** 一个平台产品下的研发项目（含说明、起止、revision）：[{ id, project_code, name, description, planned_start, planned_end, revision, … }] */
export async function listProjects(cfg, productId) {
  const r = await read(cfg, OP_PROJECT_LIST, { query: { productId }, what: 'projects' });
  return Array.isArray(r) ? r : r?.items || [];
}
const today = () => new Date().toISOString().slice(0, 10);
/* 平台要求起止要么都填、要么都不填，开始不晚于结束。只给了结束时，开始按今天填（今天已经晚于结束就和结束同一天）；返回是否补过 */
export function pairDates(body, now = today()) {
  if (body.planned_end && !body.planned_start) { body.planned_start = now <= body.planned_end ? now : body.planned_end; return true; }
  if (body.planned_start && !body.planned_end) throw fail('需求管理平台要求项目的计划开始和计划结束同时填写：先定一个计划结束日期', { code: 'dates_unpaired', final: true });
  return false;
}
/** 改平台研发项目。平台的这个接口是「整体提交」：名称、说明、起止都要带上，省略的说明和起止会被清空（2026-11-24 平台 D88 明确）。
 * 所以先读出平台上的当前值，把这次的改动盖上去，再连同 revision 一起提交；revision 对不上时平台拒绝，不会用旧值覆盖别人的修改。
 * changes：{ name?, description?, planned_start?, planned_end?, revision }；productId 是项目所在平台产品的 MP2 id（读当前值用）。
 * 返回 ProjectSummary（含新 revision），多一个 startFilled：这次是否替用户补了计划开始。 */
export async function updateProject(cfg, id, changes, { productId } = {}) {
  if (productId == null) throw fail('不知道这个项目在哪个平台产品下：先「从需求管理平台拉取」再改', { code: 'product_unknown', final: true });
  let list;
  try { list = await listProjects(cfg, productId); }
  catch (e) { if (e.code === 'operation_not_granted') e.message = '这个关联没有这项操作的权限：改项目要先读出平台上的说明和起止，到需求管理平台「AI 接入」里给这个连接勾上项目的查看'; throw e; }
  const cur = list.find(p => Number(p.id) === Number(id));
  if (!cur) throw fail('需求管理平台上找不到这个项目了：先「从需求管理平台拉取」', { code: 'project_not_found', final: true });
  const body = { name: cur.name, description: cur.description ?? null, planned_start: cur.planned_start ?? null, planned_end: cur.planned_end ?? null, ...changes };
  const startFilled = pairDates(body);
  const r = await write(cfg, OP_PROJECT_UPDATE, { path: { id }, body, task: 'JM Desk 工作台：回写项目修改' });
  return { ...r, startFilled };
}
/** 新建平台研发项目：{ business_project_id, name, description?, planned_start?, planned_end?, source: 'product' } */
export async function createProject(cfg, body) {
  body = { ...body }; const startFilled = pairDates(body);
  const r0 = await write(cfg, OP_PROJECT_CREATE, { body, task: 'JM Desk 工作台：新建项目' }), r = { ...r0, startFilled };
  if (r.id == null) throw fail('MP2 成功回执但没有项目 id', { code: 'missing_id' });
  return r;
}
