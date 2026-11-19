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

/* 调一次 AI 通道，返回 { http, receipt, result, replayed }；HTTP 码以 receipt.http_status 为准 */
async function call(cfg, payload, timeoutMs) {
  let res;
  try {
    res = await fetch(cfg.mp2.baseUrl.replace(/\/$/, '') + '/api/ai-access/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential(cfg.mp2.credentialFile) },
      body: JSON.stringify(payload),
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
