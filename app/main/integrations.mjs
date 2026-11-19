/* 接入：把各种平台 API 和 MCP 服务器变成助手可以调用的「工具」。
 *
 * settings.json 的 integrations：[{ id, name, kind, enabled, ... }]
 *   kind = mcp-stdio  本机命令启动的 MCP 服务器：command、args、cwd；环境变量（常含密钥）加密存在 secrets.json
 *   kind = mcp-http   网址形式的 MCP（Streamable HTTP，兼容只回 JSON 的无状态实现，如 MP2 /api/ai-access/mcp）：url；请求头加密保存
 *   kind = api        平台 HTTP API：baseUrl + 鉴权（bearer / header / query / none，密钥加密保存）
 *                     有 OpenAPI（JSON）就按接口生成工具；没有就只提供一个「通用请求」工具，只能访问 baseUrl 下的路径
 * settings.json 的 toolPolicy：{ <接入 id>: { <工具名>: 'auto' | 'confirm' | 'off' } }
 *   auto 直接调用；confirm 每次调用前弹窗让人确认；off 不给 AI 用。
 *   默认：只读的（MCP 标了 readOnlyHint、名字像查询；API 的 GET）为 auto，其余为 confirm。
 * 工具清单缓存在 <数据目录>/integrations-cache.json（只有工具名、说明和参数结构，没有密钥）。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KINDS = { builtin: '内置工具', 'mcp-stdio': 'MCP · 本机命令', 'mcp-http': 'MCP · 网址', api: '平台 API' };
export const MODES = { auto: '自动', confirm: '需确认', off: '关闭' };
const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'JM Desk', version: '0.2' };
const clip = (s, n) => String(s ?? '').slice(0, n);
const EXTRA_PATHS = [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const expand = v => String(v ?? '').replace(/^~(?=\/|\\|$)/, os.homedir());
const READ_NAME = /(^|[_.-])(get|list|search|query|read|fetch|find|describe|show|lookup|status|info|catalog|stats|count|ask)([_.-]|$)|^(get|list|search|query|read|fetch|find|describe|show|lookup)/i;
export const isLocalUrl = u => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(u || ''));
export function allowedUrl(u) { try { const x = new URL(String(u)); return x.protocol === 'https:' || isLocalUrl(x.href) ? x.href : null; } catch { return null; } }
const err = (message, extra = {}) => Object.assign(new Error(message), extra);

/* ---------- MCP：本机命令（stdio，一行一个 JSON-RPC 消息） ---------- */
export class StdioMcp {
  constructor({ command, args = [], env = {}, cwd, timeoutMs = 60000 }) { Object.assign(this, { command, args, env, cwd, timeoutMs }); this.seq = 0; this.wait = new Map(); this.stderr = ''; }
  async start() {
    const env = { ...process.env, PATH: [process.env.PATH, ...EXTRA_PATHS].filter(Boolean).join(path.delimiter) };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const [k, v] of Object.entries(this.env || {})) env[k] = expand(v);
    this.p = spawn(expand(this.command), (this.args || []).map(expand), { env, cwd: this.cwd ? expand(this.cwd) : os.homedir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    this.p.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this.onMessage(line); }
    });
    this.p.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-4000); });
    const dead = e => { this.closed = true; for (const w of this.wait.values()) w.rej(err(`MCP 程序已退出${e ? '：' + e.message : ''}${this.stderr ? '（' + this.stderr.trim().split('\n').pop().slice(0, 160) + '）' : ''}`)); this.wait.clear(); };
    this.p.on('error', dead); this.p.on('exit', () => dead());
    this.p.stdin.on('error', () => {});
    const init = await this.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT }, 60000)  // 有些 MCP（如 Python 写的）冷启动较慢;
    this.info = init?.serverInfo || null;
    this.notify('notifications/initialized');
    return this;
  }
  onMessage(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method && m.id != null) { // 服务器发来的请求：只回应 ping，其余（采样、征询等）不支持
      this.send(m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported by JM Desk' } }); return;
    }
    const w = m.id != null && this.wait.get(m.id); if (!w) return;
    this.wait.delete(m.id); clearTimeout(w.t);
    m.error ? w.rej(err(`MCP 错误：${clip(m.error.message, 200)}`, { code: m.error.code })) : w.res(m.result);
  }
  send(msg) { if (!this.closed) this.p.stdin.write(JSON.stringify(msg) + '\n'); }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }
  rpc(method, params, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(err('MCP 程序已退出'));
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.wait.delete(id); rej(err(`MCP 响应超时${this.stderr.trim() ? '（程序输出：' + this.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200) + '）' : ''}`)); }, timeoutMs);
      this.wait.set(id, { res, rej, t }); this.send({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }
  close() { this.closed = true; try { this.p?.kill(); } catch {} }
}

/* ---------- MCP：网址（Streamable HTTP；响应可能是 JSON 或 SSE 流） ---------- */
export class HttpMcp {
  /* urls：多个备用地址，只在连不上（网络 / DNS / TLS）时换下一个；HTTP 错误不换，免得把鉴权问题当成换线成功 */
  constructor({ url, urls, headers = {}, fetchImpl = fetch, timeoutMs = 60000 }) { Object.assign(this, { headers, fetchImpl, timeoutMs }); this.urls = (urls && urls.length ? urls : [url]).filter(Boolean); this.url = this.urls[0]; this.seq = 0; }
  async post(msg, timeoutMs = this.timeoutMs) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...this.headers };
    if (this.sid) h['Mcp-Session-Id'] = this.sid;
    if (this.proto) h['MCP-Protocol-Version'] = this.proto;
    let res, lastErr;
    for (const u of this.fixed ? [this.url] : this.urls) {
      try { res = await this.fetchImpl(u, { method: 'POST', headers: h, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeoutMs) }); this.url = u; this.fixed = true; break; }
      catch (e) { lastErr = e; }
    }
    if (!res) throw err(`连接失败：${lastErr?.name === 'TimeoutError' ? '超时' : lastErr?.message || '无法连接'}`);
    const sid = res.headers.get('mcp-session-id'); if (sid) this.sid = sid;
    if (res.status === 401 || res.status === 403) throw err(`没有权限（HTTP ${res.status}），检查请求头里的凭据`, { auth: true });
    if (msg.id == null) return null; // 通知：202 即可
    if (!res.ok) throw err(`MCP 服务返回 HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    let m;
    if (ct.includes('text/event-stream')) m = await readSse(res, msg.id);
    else m = await res.json().catch(() => null);
    if (Array.isArray(m)) m = m.find(x => x.id === msg.id);
    if (!m) throw err('MCP 服务没有返回结果');
    if (m.error) throw err(`MCP 错误：${clip(m.error.message, 200)}`, { code: m.error.code });
    return m.result;
  }
  rpc(method, params, timeoutMs) { return this.post({ jsonrpc: '2.0', id: ++this.seq, method, params: params || {} }, timeoutMs); }
  async start() {
    const init = await this.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT }, 30000);
    this.proto = init?.protocolVersion || PROTOCOL; this.info = init?.serverInfo || null;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
    return this;
  }
  close() { if (this.sid) this.fetchImpl(this.url, { method: 'DELETE', headers: { ...this.headers, 'Mcp-Session-Id': this.sid } }).catch(() => {}); }
}
async function readSse(res, id) {
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(buf.slice(i).match(/^\r?\n\r?\n/)[0].length + i);
        const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let m; try { m = JSON.parse(data); } catch { continue; }
        const hit = Array.isArray(m) ? m.find(x => x.id === id) : m.id === id ? m : null;
        if (hit) return hit;
      }
      if (done) return null;
    }
  } finally { reader.cancel().catch(() => {}); }
}
export async function mcpTools(session, { allow = null, readOnly = false } = {}) {
  const out = []; let cursor;
  for (let page = 0; page < 10; page++) {
    const r = await session.rpc('tools/list', cursor ? { cursor } : {});
    out.push(...(r?.tools || [])); cursor = r?.nextCursor; if (!cursor) break;
  }
  return out.filter(t => !allow || allow.includes(t.name)).slice(0, 300).map(t => {
    const a = t.annotations || {};
    const write = readOnly ? false : a.destructiveHint === true ? true : a.readOnlyHint === true ? false : !READ_NAME.test(t.name);
    return { name: clip(t.name, 80), title: clip(t.title || a.title || '', 80), description: clip(t.description, 600), inputSchema: t.inputSchema || { type: 'object', properties: {} }, write };
  });
}
export function mcpResultText(r) {
  const parts = (r?.content || []).map(c => c.type === 'text' ? c.text : c.type === 'resource' ? (c.resource?.text || `[资源 ${c.resource?.uri || ''}]`) : `[${c.type}]`);
  let text = parts.join('\n');
  if (!text && r?.structuredContent) text = JSON.stringify(r.structuredContent);
  return { text, isError: !!r?.isError };
}

/* ---------- 平台 API：OpenAPI → 工具 ---------- */
const OPS = ['get', 'post', 'put', 'patch', 'delete', 'head'];
const safeName = s => String(s || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'op';
function deref(spec, node, depth = 0, seen = new Set()) {
  if (!node || typeof node !== 'object' || depth > 5) return node;
  if (Array.isArray(node)) return node.map(x => deref(spec, x, depth + 1, seen));
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (seen.has(node.$ref)) return { type: 'object', description: '（递归结构）' };
    const target = node.$ref.slice(2).split('/').reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    return deref(spec, target, depth + 1, new Set([...seen, node.$ref]));
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) if (!['example', 'examples', 'xml', 'externalDocs'].includes(k)) out[k] = deref(spec, v, depth + 1, seen);
  return out;
}
export function parseOpenApi(spec, { baseUrl } = {}) {
  if (!spec || typeof spec !== 'object' || !(spec.openapi || spec.swagger) || !spec.paths) throw err('不是 OpenAPI / Swagger 文档（需要 JSON 格式）');
  let base = baseUrl;
  if (!base) {
    if (spec.servers?.[0]?.url) base = spec.servers[0].url;
    else if (spec.host) base = `${(spec.schemes || ['https'])[0]}://${spec.host}${spec.basePath || ''}`;
  }
  const tools = [], used = new Set();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of OPS) {
      const op = item?.[method]; if (!op) continue;
      let name = safeName(op.operationId || `${method}_${p}`); while (used.has(name)) name += '_';
      used.add(name);
      const params = [...(item.parameters || []), ...(op.parameters || [])].map(x => deref(spec, x)).filter(x => x && ['path', 'query', 'header', 'body'].includes(x.in));
      const props = {}, required = [];
      for (const x of params) {
        if (x.in === 'body') { props.body = { ...(x.schema || { type: 'object' }), description: x.description || '请求体' }; if (x.required) required.push('body'); continue; }
        props[x.name] = { ...(x.schema || { type: x.type || 'string' }), description: clip(`${x.in === 'path' ? '路径' : x.in === 'query' ? '查询' : '请求头'}参数${x.description ? '：' + x.description : ''}`, 200) };
        if (x.required || x.in === 'path') required.push(x.name);
      }
      const rb = deref(spec, op.requestBody);
      const js = rb?.content?.['application/json']?.schema || rb?.content && Object.values(rb.content)[0]?.schema;
      if (js) { props.body = { ...js, description: clip(rb.description || '请求体（JSON）', 200) }; if (rb.required) required.push('body'); }
      tools.push({ name, title: clip(op.summary || '', 80), description: clip([op.summary, op.description].filter(Boolean).join('：') || `${method.toUpperCase()} ${p}`, 600) + `（${method.toUpperCase()} ${p}）`,
        inputSchema: { type: 'object', properties: props, required: [...new Set(required)] }, write: !['get', 'head'].includes(method),
        http: { method: method.toUpperCase(), path: p, params: params.filter(x => x.in !== 'body').map(x => ({ name: x.name, in: x.in })) } });
      if (tools.length >= 200) break;
    }
  }
  return { baseUrl: base || null, title: clip(spec.info?.title, 60), tools };
}
export const GENERIC_TOOL = {
  name: 'request', title: '通用请求', write: null, dynamic: true,
  description: '向这个平台的 API 发一个 HTTP 请求。只能访问它的接口地址下的路径。GET 用来查询；POST / PUT / PATCH / DELETE 会修改数据，需要用户确认。',
  inputSchema: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', description: '以 / 开头的相对路径，例如 /api/v1/orders' }, query: { type: 'object' }, body: { type: 'object' } }, required: ['method', 'path'] },
};
export async function callApi(integ, tool, args, { secret = {}, fetchImpl = fetch } = {}) {
  const base = allowedUrl(integ.baseUrl); if (!base) throw err('接口地址必须是 https（本机 127.0.0.1 / localhost 除外）');
  let method, rel, query = {}, headers = { Accept: 'application/json, */*' }, body;
  if (tool.dynamic) {
    method = String(args.method || 'GET').toUpperCase(); rel = String(args.path || '');
    if (!/^\/(?!\/)/.test(rel) || /[\r\n]/.test(rel) || /^\/[a-z]+:/i.test(rel)) throw err('path 必须是以 / 开头的相对路径');
    query = args.query && typeof args.query === 'object' ? args.query : {}; body = args.body;
  } else {
    method = tool.http.method; rel = tool.http.path;
    for (const p of tool.http.params) {
      const v = args[p.name]; if (v == null) continue;
      if (p.in === 'path') rel = rel.replace(`{${p.name}}`, encodeURIComponent(String(v)));
      else if (p.in === 'query') query[p.name] = v;
      else if (p.in === 'header' && !/^(authorization|cookie|host)$/i.test(p.name)) headers[p.name] = String(v);
    }
    if (/\{[^}]+\}/.test(rel)) throw err('缺少路径参数：' + rel.match(/\{([^}]+)\}/)[1]);
    body = args.body;
  }
  const u = new URL(base.replace(/\/+$/, '') + rel);
  if (!u.href.startsWith(base.replace(/\/+$/, ''))) throw err('不能访问接口地址以外的路径');
  for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const a = integ.auth || { type: 'none' };
  if (a.type === 'bearer' && secret.token) headers.Authorization = 'Bearer ' + secret.token;
  if (a.type === 'header' && secret.token && a.name) headers[a.name] = secret.token;
  if (a.type === 'query' && secret.token && a.name) u.searchParams.set(a.name, secret.token);
  if (body != null && !['GET', 'HEAD'].includes(method)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); } else body = undefined;
  let res;
  try { res = await fetchImpl(u.href, { method, headers, body, signal: AbortSignal.timeout(60000) }); } catch (e) { throw err(`请求失败：${e.name === 'TimeoutError' ? '超时' : e.message}`); }
  let text = await res.text().catch(() => '');
  try { text = JSON.stringify(JSON.parse(text)); } catch {}
  return { text: `HTTP ${res.status}\n${text.slice(0, 20000)}`, isError: !res.ok };
}
export async function loadSpec(src, fetchImpl = fetch) {
  const s = String(src || '').trim();
  if (/^https?:\/\//i.test(s)) {
    const u = allowedUrl(s); if (!u) throw err('OpenAPI 地址必须是 https');
    const r = await fetchImpl(u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw err(`读取 OpenAPI 失败：HTTP ${r.status}`);
    return r.json().catch(() => { throw err('OpenAPI 需要 JSON 格式'); });
  }
  try { return JSON.parse(fs.readFileSync(expand(s), 'utf8')); } catch (e) { throw err('读取 OpenAPI 文件失败：' + e.message); }
}

/* ---------- 工具权限 ---------- */
export function modeOf(tool, policy = {}) { return policy[tool.name] || (tool.write === false || tool.dynamic ? 'auto' : 'confirm'); }
export function needsConfirm(tool, args, mode) {
  if (mode === 'off') return 'off';
  if (mode === 'confirm') return true;
  if (tool.dynamic) return !['GET', 'HEAD'].includes(String(args?.method || 'GET').toUpperCase());
  return false;
}

/* ---------- 统一入口：管理会话、缓存工具清单、调用工具 ---------- */
export function createHub({ getIntegrations, getSecret, getPolicy, readCache, writeCache, fetchImpl = fetch, idleMs = 5 * 60e3, local = { tools: [] } }) {
  const sessions = new Map();
  async function session(integ) {
    const s = sessions.get(integ.id);
    if (s && !s.session.closed) { clearTimeout(s.idle); s.idle = setTimeout(() => drop(integ.id), idleMs); s.idle.unref?.(); return s.session; }
    const sec = getSecret(integ) || {};
    let ss;
    if (integ.kind === 'mcp-stdio') ss = new StdioMcp({ command: integ.command, args: integ.args, cwd: integ.cwd, env: sec.env || {} });
    else if (integ.kind === 'mcp-http') {
      const u = allowedUrl(integ.url || integ.urls?.[0]); if (!u) throw err('MCP 网址必须是 https（本机 127.0.0.1 / localhost 除外）');
      if (integ.credential && !(sec.headers || {}).Authorization) throw err('还没有填写凭据：在「设置 › 接入」里填一次');
      const urls = (integ.urls || []).map(allowedUrl).filter(Boolean);
      ss = new HttpMcp({ url: u, urls: urls.length ? urls : [u], headers: sec.headers || {}, fetchImpl });
    } else throw err('不是 MCP');
    await ss.start();
    const idle = setTimeout(() => drop(integ.id), idleMs); idle.unref?.(); // 空闲计时不挡住进程退出
    sessions.set(integ.id, { session: ss, idle });
    return ss;
  }
  function drop(id) { const s = sessions.get(id); if (s) { clearTimeout(s.idle); s.session.close(); sessions.delete(id); } }
  async function refresh(integ) {
    let tools, info = null;
    if (integ.kind === 'builtin') { tools = local.tools.map(({ handler, ...t }) => t); info = { name: integ.name }; }
    else if (integ.kind === 'api') {
      if (integ.openapi) {
        const p = parseOpenApi(await loadSpec(integ.openapi, fetchImpl), { baseUrl: integ.baseUrl });
        // 文档里的 servers 可能是相对路径（如 /api）：相对 OpenAPI 文档的网址解析
        let base = p.baseUrl; if (base && /^https?:/i.test(integ.openapi)) { try { base = new URL(base, integ.openapi).href; } catch {} }
        if (!allowedUrl(base)) throw err(base ? `文档里的接口地址 ${base} 不是 https，请在「接口地址」里填写` : 'OpenAPI 文档里没有接口地址，请在「接口地址」里填写');
        tools = p.tools; info = { name: p.title, baseUrl: base };
      }
      else tools = [GENERIC_TOOL];
    } else { drop(integ.id); const ss = await session(integ); tools = await mcpTools(ss, { allow: integ.allowTools || null, readOnly: !!integ.readOnly }); info = ss.info; }
    const cache = readCache(); cache[integ.id] = { at: new Date().toISOString(), info, tools }; writeCache(cache);
    return cache[integ.id];
  }
  /* 给 AI 的工具清单：只含启用的接入、没关掉的工具；名字 = 接入 id + __ + 工具名 */
  async function catalog({ ensure = true } = {}) {
    const cache = readCache(), out = [], problems = [];
    for (const integ of getIntegrations().filter(i => i.enabled !== false)) {
      let c = cache[integ.id];
      if (!c && ensure) { try { c = await refresh(integ); } catch (e) { problems.push(`${integ.name}：${e.message}`); continue; } }
      if (!c) continue;
      const pol = getPolicy(integ.id);
      for (const t of c.tools) { const mode = modeOf(t, pol); if (mode !== 'off') out.push({ id: `${integ.id}__${t.name}`, integ, tool: t, mode }); }
    }
    return { tools: out, problems };
  }
  async function call(integ, tool, args) {
    if (integ.kind === 'builtin') { const t = local.tools.find(x => x.name === tool.name); if (!t) throw err('没有这个内置工具'); const r = await t.handler(args || {}); return { text: typeof r === 'string' ? r : JSON.stringify(r), isError: false }; }
    if (integ.allowTools && !integ.allowTools.includes(tool.name)) throw err('这个工具不在允许列表里');
    if (integ.kind === 'api') {
      if (integ.openapi && !tool.http) throw err('工具清单过期，请重新测试这个接入');
      const base = integ.baseUrl || readCache()[integ.id]?.info?.baseUrl; // 没填接口地址时用 OpenAPI 文档里的
      return callApi({ ...integ, baseUrl: base }, tool, args || {}, { secret: getSecret(integ) || {}, fetchImpl });
    }
    let ss = await session(integ);
    try { return mcpResultText(await ss.rpc('tools/call', { name: tool.name, arguments: args || {} }, 120000)); }
    catch (e) { if (!ss.closed) throw e; drop(integ.id); ss = await session(integ); return mcpResultText(await ss.rpc('tools/call', { name: tool.name, arguments: args || {} }, 120000)); }
  }
  const closeAll = () => { for (const id of [...sessions.keys()]) drop(id); };
  return { refresh, catalog, call, drop, closeAll };
}

/* ---------- 从其他 AI 工具导入已经配好的 MCP（Claude Code / Claude Desktop / Cursor / Codex） ---------- */
function tomlValue(v) {
  v = v.trim();
  if (v.startsWith('"')) { try { return JSON.parse(v.replace(/"\s*#.*$/, '"')); } catch { return v.slice(1, v.lastIndexOf('"')); } }
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'"));
  if (v.startsWith('[')) { const out = []; v.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (_, a, b) => out.push(a != null ? JSON.parse(`"${a}"`) : b)); return out; }
  if (v.startsWith('{')) { const o = {}; v.replace(/([A-Za-z0-9_.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g, (_, k, a, b) => { o[k] = a != null ? JSON.parse(`"${a}"`) : b; }); return o; }
  return v.replace(/\s*#.*$/, '');
}
export function parseCodexToml(text) {
  const out = {}; let cur = null, sub = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[\s*mcp_servers\.("?)([^\]".]+)\1(?:\.(env|headers|http_headers))?\s*\]$/);
    if (sec) { cur = out[sec[2]] ||= {}; sub = sec[3] ? (cur[sec[3] === 'env' ? 'env' : 'headers'] ||= {}) : null; continue; }
    if (line.startsWith('[')) { cur = null; sub = null; continue; }
    if (!cur) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/); if (!kv) continue;
    const val = tomlValue(kv[2]);
    if (sub) sub[kv[1]] = String(val);
    else if (kv[1] === 'env' || kv[1] === 'http_headers' || kv[1] === 'headers') cur[kv[1] === 'env' ? 'env' : 'headers'] = val;
    else cur[kv[1]] = val;
  }
  return out;
}
export function detectExternal(home = os.homedir()) {
  const found = [], read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const add = (from, name, s) => {
    if (!s || typeof s !== 'object') return;
    const url = s.url || s.serverUrl || null, command = s.command || null;
    if (!url && !command) return;
    found.push({ from, name: clip(name, 40), kind: url ? 'mcp-http' : 'mcp-stdio', command, args: Array.isArray(s.args) ? s.args.map(String) : [], cwd: s.cwd || null, url,
      env: s.env && typeof s.env === 'object' ? s.env : {}, headers: (s.headers || s.http_headers) && typeof (s.headers || s.http_headers) === 'object' ? (s.headers || s.http_headers) : {} });
  };
  const json = (from, f) => { const t = read(f); if (!t) return; try { const j = JSON.parse(t); for (const [n, s] of Object.entries(j.mcpServers || {})) add(from, n, s); } catch {} };
  json('Claude Code', path.join(home, '.claude.json'));
  json('Claude Desktop', path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json'));
  json('Claude Desktop', path.join(home, 'AppData/Roaming/Claude/claude_desktop_config.json'));
  json('Cursor', path.join(home, '.cursor/mcp.json'));
  const t = read(path.join(home, '.codex/config.toml'));
  if (t) for (const [n, s] of Object.entries(parseCodexToml(t))) add('Codex', n, s);
  return found;
}
