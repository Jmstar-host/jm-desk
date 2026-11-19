/* 模型来源与 token 政策：不一定要买 API，也可以用本机已经登录的 Claude Code / Codex，或本机 Ollama。
 *
 * settings.json：
 *   providers: [{ id, name, kind, enabled, ...按类型的字段, dailyTokens }]
 *     kind = api     OpenAI 兼容接口（DeepSeek、Ollama 的 /v1 等）：baseUrl、model；Key 存系统钥匙串（secrets.keys[id]），或 keyEnvFile + keyEnvName
 *     kind = claude  本机 Claude Code：claude -p，关掉全部工具和 MCP，只回答文本
 *     kind = codex   本机 Codex：codex exec，只读沙箱、关掉 MCP、在空目录里运行
 *     kind = cmd     自定义命令：command + args，提示词从标准输入传入，标准输出当回答
 *   modelRouting: { summary: [id…], knowledge: [id…], customize: [id…] }   按顺序尝试，前一个不可用 / 超额就换下一个
 *   modelPolicy:  { privateLocalOnly: false }   true 时，邮件和聊天内容（汇总）只交给本机模型（Ollama / 自定义本机命令）
 * 用量记在 <数据目录>/usage.jsonl：每次调用一行 { at, provider, task, in, out, est }，不记提示词和回答内容。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const TASKS = { summary: '汇总（邮件 / 飞书 / 会议）', knowledge: '问知识', assistant: '助手（调用平台接口和 MCP）', customize: 'AI 定制气泡和形象' };
export const PRIVATE_TASKS = new Set(['summary']);
export const KINDS = { api: 'API', claude: '本机 Claude Code', codex: '本机 Codex', cmd: '本机命令' };

const EXTRA_PATHS = [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
export function which(bin) {
  if (!bin) return null;
  if (path.isAbsolute(bin)) return fs.existsSync(bin) ? bin : null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of [...String(process.env.PATH || '').split(path.delimiter), ...EXTRA_PATHS]) {
    for (const e of exts) { const f = path.join(dir, bin + e); try { if (fs.statSync(f).isFile()) return f; } catch {} }
  }
  return null;
}
const estTokens = s => Math.ceil(String(s || '').length / 2);   // 中英混排的粗估：约 2 字符 1 token
export const isLocal = p => p.kind === 'cmd' ? p.local !== false : p.kind === 'api' && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(p.baseUrl || '');

/* ---------- 调用各类来源，统一返回 { text, in, out, est } ---------- */
function run(cmd, args, input, { timeoutMs = 240000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: [process.env.PATH, ...EXTRA_PATHS].filter(Boolean).join(path.delimiter), NO_COLOR: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    let out = '', err = '', done = false;
    const p = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const t = setTimeout(() => { if (!done) { done = true; p.kill(); reject(new Error('本机模型超时')); } }, timeoutMs);
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', e => { if (!done) { done = true; clearTimeout(t); reject(new Error(`启动失败：${e.message}`)); } });
    p.on('close', code => { if (done) return; done = true; clearTimeout(t); resolve({ out, err, code }); });
    p.stdin.end(input);
  });
}
function scratchDir() { const d = path.join(os.tmpdir(), 'jm-desk-model'); fs.mkdirSync(d, { recursive: true }); return d; }

export const CALLERS = {
  async api(p, system, user, { getKey }) {
    const key = getKey(p) || '';
    const headers = { 'Content-Type': 'application/json' }; if (key) headers.Authorization = 'Bearer ' + key;
    const body = { model: p.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.3, max_tokens: 6000, response_format: { type: 'json_object' } };
    if (/deepseek/i.test(p.baseUrl || '')) body.thinking = { type: 'disabled' };
    const res = await fetch(String(p.baseUrl || '').replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Key 不对或没有权限'), { auth: true });
    if (!res.ok) throw new Error(`模型返回 ${res.status}`);
    const j = await res.json();
    return { text: j.choices?.[0]?.message?.content || '', in: j.usage?.prompt_tokens, out: j.usage?.completion_tokens };
  },
  async claude(p, system, user) {
    const bin = which(p.command || 'claude'); if (!bin) throw Object.assign(new Error('没有找到 claude 命令'), { missing: true });
    const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', system];
    if (p.model) args.push('--model', p.model);
    const r = await run(bin, args, user, { cwd: scratchDir() });
    let j; try { j = JSON.parse(r.out); } catch { throw new Error(`Claude Code 没有返回结果${r.err ? '：' + r.err.trim().split('\n').pop().slice(0, 120) : ''}`); }
    if (j.is_error) throw Object.assign(new Error(/log ?in/i.test(j.result || '') ? 'Claude Code 还没登录：在终端运行一次 claude 登录' : `Claude Code：${String(j.result || '出错').slice(0, 120)}`), { auth: /log ?in/i.test(j.result || '') });
    const u = j.usage || {};
    return { text: String(j.result || ''), in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens };
  },
  async codex(p, system, user) {
    const bin = which(p.command || 'codex'); if (!bin) throw Object.assign(new Error('没有找到 codex 命令'), { missing: true });
    const dir = scratchDir(), outFile = path.join(dir, `codex-${process.pid}-${Date.now()}.txt`);
    const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-C', dir, '-c', 'mcp_servers={}', '-o', outFile, '--color', 'never'];
    if (p.model) args.push('-m', p.model);
    args.push('-');
    const r = await run(bin, args, `${system}\n\n不要执行命令、不要读取文件，直接回答。\n\n${user}`, { cwd: dir });
    let text = ''; try { text = fs.readFileSync(outFile, 'utf8'); fs.rmSync(outFile, { force: true }); } catch {}
    if (!text.trim()) throw Object.assign(new Error(/login|auth/i.test(r.out + r.err) ? 'Codex 还没登录：在终端运行一次 codex login' : 'Codex 没有返回结果'), { auth: /login|auth/i.test(r.out + r.err) });
    const m = (r.out + '\n' + r.err).match(/tokens used\s*\n?\s*([\d,]+)/i);
    return { text, in: m ? Number(m[1].replace(/,/g, '')) : undefined, out: 0 };
  },
  async cmd(p, system, user) {
    const bin = which(p.command); if (!bin) throw Object.assign(new Error(`没有找到命令 ${p.command}`), { missing: true });
    const r = await run(bin, Array.isArray(p.args) ? p.args.map(String) : [], `${system}\n\n${user}`, { cwd: scratchDir() });
    if (r.code !== 0 && !r.out.trim()) throw new Error(`命令出错：${r.err.trim().split('\n').pop()?.slice(0, 120) || r.code}`);
    return { text: r.out };
  },
};

export function parseJSON(text) {
  const t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('模型没有返回 JSON');
  try { return JSON.parse(t.slice(a, b + 1)); } catch { throw new Error('模型返回的 JSON 不完整'); }
}

/* ---------- 用量 ---------- */
export function makeUsage(file) {
  const today = () => new Date().toISOString().slice(0, 10);
  function read(days = 31) {
    const since = Date.now() - days * 864e5;
    try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => Date.parse(x.at) >= since); } catch { return []; }
  }
  return {
    add(rec) { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n'); },
    usedToday(provider) { const d = today(); return read(2).filter(x => x.provider === provider && x.at.slice(0, 10) === d).reduce((s, x) => s + (x.in || 0) + (x.out || 0), 0); },
    summary() {
      const d = today(), rows = read(31), by = {};
      for (const x of rows) { const k = x.provider; by[k] ||= { today: 0, month: 0, calls: 0, est: false }; const n = (x.in || 0) + (x.out || 0); by[k].month += n; if (x.at.slice(0, 10) === d) { by[k].today += n; by[k].calls++; } if (x.est) by[k].est = true; }
      return by;
    },
  };
}

/* ---------- 路由：按任务的顺序尝试，遵守每日额度和隐私政策 ---------- */
export function createRouter({ getSettings, getKey, usage, callers = CALLERS }) {
  const providers = () => (getSettings().providers || []).filter(p => p && p.id && p.enabled !== false);
  function candidates(task) {
    const s = getSettings(), all = providers(), order = (s.modelRouting || {})[task];
    let list = Array.isArray(order) && order.length ? order.map(id => all.find(p => p.id === id)).filter(Boolean) : all;
    if (PRIVATE_TASKS.has(task) && s.modelPolicy?.privateLocalOnly) list = list.filter(isLocal);
    return list;
  }
  async function chat(system, user, { task = 'customize' } = {}) {
    const list = candidates(task);
    if (!list.length) throw new Error(PRIVATE_TASKS.has(task) && getSettings().modelPolicy?.privateLocalOnly ? '隐私政策要求只用本机模型，但还没有可用的本机模型（设置 › 模型）' : '还没有可用的模型（设置 › 模型）');
    const errors = [], need = estTokens(system + user);
    for (const p of list) {
      const limit = Number(p.dailyTokens) || 0;
      if (limit && usage.usedToday(p.id) + need > limit) { errors.push(`${p.name || p.id}：今天的额度用完了`); continue; }
      const caller = callers[p.kind]; if (!caller) { errors.push(`${p.name || p.id}：不支持的类型`); continue; }
      try {
        const r = await caller(p, system, user, { getKey });
        const est = r.in == null; const rec = { provider: p.id, task, in: r.in ?? need, out: r.out ?? estTokens(r.text), est };
        usage.add(rec);
        return { data: parseJSON(r.text), provider: p.id, usage: rec };
      } catch (e) { errors.push(`${p.name || p.id}：${e.message}`); }
    }
    throw new Error(errors.join('；'));
  }
  return { chat, candidates, providers };
}

/* 本机能找到的模型来源（给「添加」用） */
export async function detect(fetchImpl = fetch) {
  const found = [];
  for (const [kind, bin, name] of [['claude', 'claude', 'Claude Code（本机）'], ['codex', 'codex', 'Codex（本机）']]) { const f = which(bin); if (f) found.push({ kind, name, command: bin, path: f }); }
  try {
    const r = await fetchImpl('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (r.ok) { const j = await r.json(); for (const m of (j.models || []).filter(m => !/embed/i.test(m.name)).slice(0, 8)) found.push({ kind: 'api', name: `Ollama · ${m.name}`, baseUrl: 'http://127.0.0.1:11434/v1', model: m.name, local: true }); }
  } catch {}
  return found;
}

/* 旧版 settings.model（只有一个 DeepSeek）迁移成 providers */
export function migrate(s) {
  if (Array.isArray(s.providers)) return false;
  const m = s.model || {};
  s.providers = [{ id: 'deepseek', name: 'DeepSeek', kind: 'api', enabled: true, baseUrl: m.baseUrl || 'https://api.deepseek.com', model: m.model || 'deepseek-flash',
    ...(m.keyEnvFile ? { keyEnvFile: m.keyEnvFile, keyEnvName: m.keyEnvName } : {}), dailyTokens: 0 }];
  s.modelRouting ||= {}; s.modelPolicy ||= { privateLocalOnly: false };
  return true;
}
