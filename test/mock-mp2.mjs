/* 假 MP2，只用于测试本地这一半。行为按 MP2 源码核对（2026-11-17），与真实服务一致的部分：
 * - 信封 `{ replayed, receipt: { id, operation_id, status: 'succeeded'|'failed', http_status }, result? }`
 * - requestId 重复：只回 `{ replayed: true, receipt }`（第一次调用的回执，可能是 failed），没有 result
 * - POST sources 成功 result `{ batch_id, duplicate, status: '<批次状态>' }`；失败 result `{ status: <http>, detail }`
 *   AI 通道缺必填字段 → 400 required_field_missing + field；其余校验码同 MP2 controller；未授权 → 403 operation_not_granted
 * - 同 source_type + source_ref（同 owner）再送 → 原批次 + duplicate:true
 * - GET batches/{id}：status 'completed' + 中文 phase；不存在 → 200 + { error: 'batch not found' }
 * - GET my-candidates：status pending|pooled|rejected（confirmed 是 pooled 的别名）→ { total, items, summary }，来源字段 source_kind
 * 测试钩子：failNext(n, http) 让后面 n 次 sources 调用记成失败回执；gatewayDown(n, http) 让后面 n 次请求直接回网关错误（无信封、无回执）。
 * 选项 mirrorHttp：信封的 HTTP 码跟随 receipt.http_status（默认 200），两种都要能处理。 */
import http from 'node:http';

const OP_SOURCES = 'POST:/api/meeting-intake/sources';
const OP_BATCH = 'GET:/api/meeting-intake/batches/{id}';
const OP_MY = 'GET:/api/meeting-intake/my-candidates';
const TYPES = new Set(['feishu_im', 'feishu_meeting', 'mail']);

function validateSource(b) {
  for (const f of ['source_type', 'source_ref', 'title', 'content']) if (b?.[f] === undefined || b?.[f] === null) return { status: 400, detail: 'required_field_missing', field: f };
  if (!TYPES.has(b.source_type)) return { status: 400, detail: 'invalid_source_type' };
  if (!String(b.source_ref).trim()) return { status: 400, detail: 'source_ref_required' };
  if (!String(b.title).trim()) return { status: 400, detail: 'title_required' };
  if (!String(b.content).trim()) return { status: 400, detail: 'content_required' };
  if (String(b.source_ref).length > 255) return { status: 400, detail: 'source_ref_too_long' };
  if (String(b.title).length > 200) return { status: 400, detail: 'title_too_long' };
  if (String(b.content).length > 20000) return { status: 400, detail: 'content_too_long' }; // MP2 从不截断
  if (b.source_url != null && b.source_url !== '') {
    if (String(b.source_url).length > 1000) return { status: 400, detail: 'source_url_too_long' };
    if (!/^https?:\/\//i.test(b.source_url)) return { status: 400, detail: 'invalid_source_url' };
  }
  if (b.occurred_at != null && b.occurred_at !== '' && isNaN(Date.parse(b.occurred_at))) return { status: 400, detail: 'invalid_occurred_at' };
  return null;
}

/* 设备授权（POST /api/ai-access/device-links、/{id}/token），按 AiDeviceLinkService 核对：
 * secret 43–128 位 [A-Za-z0-9_-]；token 需 X-MP2-Link-Secret（不符 403 device_link_secret_required）；
 * 间隔内重复查询 → slow_down；approved 时 config 只给一次，之后只回 { status: 'connected' }；不存在 → 404 device_link_not_found。
 * 测试钩子：links.approve(code) / deny(code) / expire(code)；linkInterval（秒）与 linkMinGapMs 用来缩短测试。 */
const crypto = await import('node:crypto');
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
export function startMock({ token = 'test-token', grants = [OP_SOURCES, OP_BATCH, OP_MY], mirrorHttp = false, linkInterval = 5, linkMinGapMs = 5000 } = {}) {
  const devLinks = new Map(); let linkRequests = 0;
  const batches = new Map(), byRef = new Map(), receipts = new Map(), candidates = [], calls = [];
  const granted = new Set(grants);
  let seq = 0, failing = 0, failHttp = 502, down = 0, downHttp = 502;
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      const send = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
      if (down > 0) { down--; res.writeHead(downHttp, { 'Content-Type': 'text/html' }); return res.end('<html>Bad Gateway</html>'); }
      const dm = req.url.match(/^\/api\/ai-access\/device-links(?:\/([^/]+)\/token)?$/);
      if (dm && req.method === 'POST') {
        linkRequests++;
        if (!dm[1]) {
          let b = null; try { b = JSON.parse(raw || 'null'); } catch {}
          if (!b?.client_name || !/^[A-Za-z0-9_-]{43,128}$/.test(b?.secret || '')) return send(400, { status: 400, detail: 'invalid_device_link' });
          const id = crypto.randomUUID(), A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
          const code = Array.from({ length: 8 }, () => A[crypto.randomInt(A.length)]).join('').replace(/^(.{4})/, '$1-');
          devLinks.set(id, { id, code, digest: sha(b.secret), status: 'pending', client: b.client_name, device: b.device_name, lastPoll: 0, config: null, expires: Date.now() + 600e3 });
          return send(200, { id, user_code: code, verification_url: `http://${req.headers.host}/ai-access/link?code=${code}`, expires_at: new Date(Date.now() + 600e3).toISOString(), interval: linkInterval });
        }
        const l = devLinks.get(decodeURIComponent(dm[1]));
        if (!l) return send(404, { status: 404, detail: 'device_link_not_found' });
        if (sha(String(req.headers['x-mp2-link-secret'] || '')) !== l.digest) return send(403, { status: 403, detail: 'device_link_secret_required' });
        const now = Date.now();
        if (l.lastPoll && now - l.lastPoll < linkMinGapMs) return send(200, { status: 'slow_down' });
        l.lastPoll = now;
        if (l.status !== 'approved') return send(200, { status: l.status });
        const config = l.config; l.config = null; l.status = 'connected';
        return send(200, { status: 'connected', connection_id: l.connectionId, config });
      }
      if (req.headers.authorization !== 'Bearer ' + token) return send(401, { code: 'unauthorized' });
      if (req.url !== '/api/ai-access/call') return send(404, {});
      const call = JSON.parse(raw);
      calls.push({ operationId: call.operationId, requestId: call.requestId, query: call.query, path: call.path });
      if (receipts.has(call.requestId)) { const r = receipts.get(call.requestId); return send(mirrorHttp ? r.http_status : 200, { replayed: true, receipt: r }); }
      let result;
      if (!granted.has(call.operationId)) result = { status: 403, detail: 'operation_not_granted' };
      else if (call.operationId === OP_SOURCES) {
        const b = call.body;
        if (failing > 0) { failing--; result = { status: failHttp, detail: 'upstream_error' }; }
        else if (!(result = validateSource(b))) {
          const key = b.source_type + '|' + b.source_ref;
          if (byRef.has(key)) { const id = byRef.get(key); result = { batch_id: id, duplicate: true, status: batches.get(id).status }; }
          else {
            const id = ++seq; batches.set(id, { ...b, status: 'extracting' }); byRef.set(key, id);
            candidates.push({ id: candidates.length + 1, batch_id: id, title: '候选：' + b.title, status: 'pending', source_kind: b.source_type });
            result = { batch_id: id, duplicate: false, status: 'extracting' };
          }
        }
      } else if (call.operationId === OP_BATCH) {
        const id = +call.path?.id, b = batches.get(id);
        result = b ? { id, status: 'completed', phase: '已完成', candidates: candidates.filter(c => c.batch_id === id).map(c => ({ id: c.id, title: c.title, status: c.status })) } : { error: 'batch not found' };
      } else if (call.operationId === OP_MY) {
        const q = call.query || {};
        const st = q.status === 'confirmed' ? 'pooled' : q.status;
        if (st != null && !['pending', 'pooled', 'rejected'].includes(st)) result = { status: 400, detail: 'invalid_status' };
        else {
          const items = candidates.filter(c => (!st || c.status === st) && (!q.source_type || c.source_kind === q.source_type));
          const summary = { pending: 0, pooled: 0, rejected: 0 }; for (const c of candidates) summary[c.status]++;
          result = { total: items.length, items, summary };
        }
      } else result = { status: 404, detail: 'operation_not_found' };
      const httpStatus = typeof result.status === 'number' ? result.status : 200;
      const receipt = { id: 'r' + (receipts.size + 1), operation_id: call.operationId, request_id: call.requestId, status: httpStatus < 400 ? 'succeeded' : 'failed', http_status: httpStatus };
      receipts.set(call.requestId, receipt);
      send(mirrorHttp ? httpStatus : 200, { replayed: false, receipt, result });
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({
    url: `http://127.0.0.1:${srv.address().port}`, batches, candidates, calls, receipts,
    failNext: (n = 1, code = 502) => { failing = n; failHttp = code; },
    gatewayDown: (n = 1, code = 502) => { down = n; downHttp = code; },
    links: {
      get requests() { return linkRequests; },
      byCode: code => [...devLinks.values()].find(l => l.code === code),
      approve(code, connectionId = 'conn-' + code) {
        const l = this.byCode(code); l.status = 'approved'; l.connectionId = connectionId;
        l.config = { mcpServers: { mp2: { url: `http://127.0.0.1:${srv.address().port}/api/ai-access/mcp`, headers: { Authorization: 'Bearer ' + token } } } };
      },
      deny(code) { this.byCode(code).status = 'denied'; },
      expire(code) { this.byCode(code).status = 'expired'; },
      remove(code) { devLinks.delete(this.byCode(code).id); },
      list: () => [...devLinks.values()].map(l => ({ code: l.code, status: l.status, device: l.device, client: l.client })),
    },
    close: () => srv.close(),
  })));
}
