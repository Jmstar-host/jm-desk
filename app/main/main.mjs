/* JM Desk 主进程：精灵窗口、提示层、应用面板、托盘；布局 / 形象 / 设置的读写与热加载；AI 定制。 */
import { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, safeStorage, dialog, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { CATALOG, DEFAULT_LAYOUT, validateLayout, resolveLayout, ICONS } from './catalog.mjs';
import { makeStore } from './store.mjs';
import { createServices } from './services.mjs';
import { mailspringApp } from './mail.mjs';
import * as mp2link from '../core/mp2link.mjs';
import * as knowledge from './knowledge.mjs';
import * as gallery from './gallery.mjs';
import * as updater from './updater.mjs';
import * as providers from './providers.mjs';
import * as integrations from './integrations.mjs';
import * as agent from './agent.mjs';
import * as reminders from './reminders.mjs';
import * as peers from './peers.mjs';
import { createPeerHub } from './peerhub.mjs';
import { Notification } from 'electron';

const require = createRequire(import.meta.url);
const remoteMain = require('@electron/remote/main');
remoteMain.initialize();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = (...p) => path.join(HERE, '..', 'renderer', ...p);
const STAGE = 220;

if (!app.requestSingleInstanceLock()) app.quit();
if (process.env.JM_DESK_DEBUG) { // 调试：记录慢的主进程处理（>20ms）
  const h0 = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (ch, fn) => h0(ch, async (...a) => { const t = Date.now(); try { return await fn(...a); } finally { const d = Date.now() - t; if (d > 20) console.log('[slow]', ch, d + 'ms'); } });
}
if (process.platform === 'darwin') app.dock?.hide();

let store, services, sprite = null, panel = null, tray = null;
const BUILTIN = { lumi: { id: 'lumi', name: '星灵 Lumi', author: 'JM Desk', builtin: true, kind: 'builtin' } };
let CHARACTERS = { ...BUILTIN };
/* 形象包：<数据目录>/extensions/character/<id>/manifest.json（只在本机，不随安装包分发）。
 * kind: gltf（entry 指向 .glb/.gltf，可选 boneMap、size）| procedural（entry 指向导出 build 的 .mjs） */
function scanCharacters() {
  const dir = path.join(store.dir, 'extensions', 'character'), found = { ...BUILTIN };
  let ids = []; try { ids = fs.readdirSync(dir); } catch {}
  for (const d of ids) {
    try {
      const base = path.join(dir, d), m = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
      const id = String(m.id || d);
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id) || found[id] || !['gltf', 'procedural'].includes(m.kind)) continue;
      const entry = path.resolve(base, String(m.entry || ''));
      if (!entry.startsWith(base + path.sep) || !fs.existsSync(entry)) continue;   // 入口必须在包目录里
      if (m.kind === 'gltf' && !/\.(glb|gltf)$/i.test(entry)) continue;
      if (m.kind === 'procedural' && !/\.mjs$/i.test(entry)) continue;
      found[id] = { id, name: String(m.name || id).slice(0, 30), author: String(m.author || '').slice(0, 40), license: String(m.license || '').slice(0, 80), kind: m.kind,
        url: pathToFileURL(entry).href, boneMap: m.boneMap && typeof m.boneMap === 'object' ? m.boneMap : null, size: Number(m.size) || null, params: m.params || null, theme: Array.isArray(m.theme) ? m.theme.slice(0, 2).map(String) : null };
    } catch {}
  }
  CHARACTERS = found;
  return found;
}
const LUMI_KEYS = ['body', 'body2', 'belly', 'cheek', 'eye', 'star', 'antenna', 'tail', 'size'];

/* ---------- 布局 / 形象 / 设置 ---------- */
function loadLayout() {
  const v = validateLayout(store.read('layout.json', DEFAULT_LAYOUT));
  if (!v.ok) { console.warn('layout.json 有问题，使用默认布局：', v.errors); return DEFAULT_LAYOUT; }
  return v.layout;
}
function loadCharacter() {
  scanCharacters();
  const c = store.read('character.json', { id: 'lumi', params: {} }), id = CHARACTERS[c.id] ? c.id : 'lumi', ch = CHARACTERS[id];
  return { id, params: sanitizeParams(c.params), pack: ch.builtin ? null : { id, kind: ch.kind, url: ch.url, boneMap: ch.boneMap, size: ch.size, params: ch.params } };
}
function sanitizeParams(p = {}) {
  const o = {};
  for (const k of ['body', 'body2', 'belly', 'cheek', 'eye', 'star']) if (/^#[0-9a-fA-F]{6}$/.test(p[k] || '')) o[k] = p[k];
  if (['star', 'leaf', 'none'].includes(p.antenna)) o.antenna = p.antenna;
  if (typeof p.tail === 'boolean') o.tail = p.tail;
  if (Number.isFinite(+p.size)) o.size = Math.max(0.8, Math.min(1.3, +p.size));
  return o;
}
const settings = () => store.read('settings.json', { providers: [], modelRouting: {}, modelPolicy: { privateLocalOnly: false }, mailClient: '', pos: null });
/* IPC 处理统一包一层：出错时返回 { ok:false, error } 而不是抛到界面 */
const safe = fn => async (...a) => { try { return { ok: true, data: await fn(...a) }; } catch (err) { return { ok: false, error: err.message || String(err) }; } };

/* ---------- 模型来源与 token 政策（见 providers.mjs）：Key 只在主进程，存 safeStorage ---------- */
function getKey(p) {
  if (!p) return '';
  try { const enc = (store.read('secrets.json', {}).keys || {})[p.id]; if (enc && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch {}
  if (p.keyEnvFile && p.keyEnvName) { // 可选：从本机 env 文件读取（路径写在用户配置里，不写进代码）
    try { const m = fs.readFileSync(String(p.keyEnvFile).replace(/^~/, os.homedir()), 'utf8').match(new RegExp('^' + String(p.keyEnvName).replace(/[^A-Za-z0-9_]/g, '') + '=(.*)$', 'm')); if (m) return m[1].trim().replace(/^["']|["']$/g, ''); } catch {}
  }
  return '';
}
/* ---------- 接入（平台 API / MCP）：配置在 settings.integrations，密钥（环境变量、请求头、Token）加密存在 secrets.json 的 integ ---------- */
function integSecret(id) {
  try { const enc = (store.read('secrets.json', {}).integ || {})[id]; if (enc && safeStorage.isEncryptionAvailable()) return JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64'))); } catch {}
  return {};
}
function setIntegSecret(id, obj) {
  const sec = store.read('secrets.json', {}); sec.integ ||= {};
  if (obj && Object.values(obj).some(v => v && (typeof v !== 'object' || Object.keys(v).length))) sec.integ[id] = safeStorage.encryptString(JSON.stringify(obj)).toString('base64'); else delete sec.integ[id];
  store.write('secrets.json', sec);
}
/* 已关联的需求管理平台本身就是一个 MCP 服务器（设备授权得到的凭据本身就是 mcpServers.mp2 配置），自动作为内置接入 */
function mp2Mcp() {
  try {
    const st = mp2link.linkStatus(); if (!st.linked) return null;
    const j = JSON.parse(fs.readFileSync(mp2link.credentialPath(), 'utf8')), s = j?.mcpServers?.mp2 || Object.values(j?.mcpServers || {})[0];
    return s?.url ? { url: s.url, headers: s.headers || {} } : null;
  } catch { return null; }
}
/* 安装包预置的接入（builtin/integrations.json，打包前由 scripts/set-preset.mjs 写入；开源默认为空）。
 * 预置接入不能删除，可以停用；需要凭据的由用户在界面里填一次（粘贴，或指向本机凭据文件），加密保存在本机。 */
function presetIntegrations() {
  // 两处来源：安装包里的 builtin/integrations.json；管理员放在本机数据目录的 integrations-preset.json（同 id 以安装包为准）
  const out = [];
  for (const f of [path.join(HERE, '..', 'builtin', 'integrations.json'), store.file('integrations-preset.json')]) {
    try { for (const i of JSON.parse(fs.readFileSync(f, 'utf8')).integrations || []) if (i && /^[a-z0-9][a-z0-9-]{0,30}$/.test(i.id) && integrations.KINDS[i.kind] && i.kind !== 'builtin' && !out.some(x => x.id === i.id)) out.push(i); } catch {}
  }
  return out;
}
function allIntegrations() {
  const off = new Set(settings().integrationsOff || []);
  const user = (settings().integrations || []).filter(i => i && i.id && integrations.KINDS[i.kind] && i.kind !== 'builtin');
  const list = [{ id: 'jmdesk', name: 'JM Desk 工作区', kind: 'builtin', builtin: true, enabled: !off.has('jmdesk') }];
  const m = mp2Mcp(); if (m) list.push({ id: 'mp2', name: '需求管理平台', kind: 'mcp-http', url: m.url, builtin: true, enabled: !off.has('mp2') });
  for (const p of presetIntegrations()) if (!user.some(u => u.id === p.id)) list.push({ ...p, preset: true, enabled: !off.has(p.id) });
  return [...list, ...user];
}
/* 凭据：token（加密保存的值）或 tokenFile（本机凭据文件路径，调用时才读，不复制） */
/* 预置接入「默认继承」：还没填凭据时，从本机已有配置里找同名的凭据文件变量（credential.inheritEnv），只记路径不复制内容；
 * 找到的来源如果是用户自己加的同一个知识库（本机命令接入），就停用它，免得工具重复 */
function inheritCredentials() {
  const s = settings(); let changed = false;
  for (const p of presetIntegrations()) {
    const env = p.credential?.inheritEnv; if (!env || !/^[A-Z0-9_]{3,60}$/.test(env)) continue;
    const sec = integSecret(p.id); if (sec.token || sec.tokenFile) continue;
    let file = null, from = null;
    for (const k of s.knowledge || []) if (k?.env?.[env]) { file = k.env[env]; from = 'knowledge'; break; }
    if (!file) for (const u of s.integrations || []) { const v = integSecret(u.id).env?.[env]; if (v) { file = v; from = u.id; break; } }
    if (!file && process.env[env]) file = process.env[env];
    if (!file) continue;
    setIntegSecret(p.id, { ...sec, tokenFile: file, inherited: true }); changed = true;
  }
  // 用同一个凭据变量的用户接入，就是同一个知识库：停用一次（用户之后手动再启用就不再动它）
  for (const p of presetIntegrations()) {
    const env = p.credential?.inheritEnv; if (!env) continue;
    for (const u of s.integrations || []) if (u.enabled !== false && !u.supersededBy && integSecret(u.id).env?.[env]) { u.enabled = false; u.supersededBy = p.id; changed = true; }
  }
  if (changed) store.write('settings.json', s);
}
function integCredential(i) {
  const sec = integSecret(i.id); let token = sec.token || '';
  if (!token && sec.tokenFile) { try { token = fs.readFileSync(String(sec.tokenFile).replace(/^~(?=\/|$)/, os.homedir()), 'utf8').trim(); } catch {} }
  return token;
}
const integCacheFile = () => store.file('integrations-cache.json');
const hub = integrations.createHub({
  getIntegrations: allIntegrations,
  getSecret: i => {
    if (i.id === 'mp2' && i.builtin) return { headers: mp2Mcp()?.headers || {} };
    const sec = integSecret(i.id);
    if (i.credential?.type === 'bearer') { const t = integCredential(i); return { ...sec, headers: { ...(sec.headers || {}), ...(t ? { Authorization: 'Bearer ' + t } : {}) } }; }
    return sec;
  },
  local: { get tools() { return localTools(); } },
  getPolicy: id => (settings().toolPolicy || {})[id] || {},
  readCache: () => { try { return JSON.parse(fs.readFileSync(integCacheFile(), 'utf8')); } catch { return {}; } },
  writeCache: c => fs.writeFileSync(integCacheFile(), JSON.stringify(c, null, 1)),
  fetchImpl: (u, o) => net.fetch(u, o),
});
app.on('before-quit', () => hub.closeAll());

/* ---------- 串门（peers.mjs 加密与中转、peerhub.mjs 调度；这里接窗口、动画和本机搜索） ---------- */
function presetRelay() { // 公司版打包时写进 builtin/integrations.json 的 relay；管理员也可以放在数据目录的 integrations-preset.json
  for (const f of [path.join(HERE, '..', 'builtin', 'integrations.json'), store.file('integrations-preset.json')]) { try { const r = peers.relayUrl(JSON.parse(fs.readFileSync(f, 'utf8')).relay || ''); if (r) return r; } catch {} }
  return null;
}
const peerRelay = () => peers.relayUrl(settings().peers?.relay || '') || presetRelay();
function myLook() {
  const ch = loadCharacter(), theme = themeFor(ch);
  return { theme, palette: ch.id === 'lumi' ? { ...ch.params } : { body: theme[0], body2: theme[1] } }; // 别人桌面上画不了我的模型包，就用同色的星灵
}
const visitors = new Map();
const peerHub = createPeerHub({
  store: { read: (n, d) => store.read(n, d), write: (n, v) => store.write(n, v) },
  settings: () => settings(), relay: peerRelay, fetchImpl: (u, o) => net.fetch(u, o),
  getIdentity: () => { try { const e = store.read('secrets.json', {}).peer; return e && safeStorage.isEncryptionAvailable() ? JSON.parse(safeStorage.decryptString(Buffer.from(e, 'base64'))) : null; } catch { return null; } },
  setIdentity: v => { const s = store.read('secrets.json', {}); s.peer = safeStorage.encryptString(JSON.stringify(v)).toString('base64'); store.write('secrets.json', s); },
  myName: () => String(settings().peers?.name || os.hostname().replace(/\.(local|lan)$/i, '')).slice(0, 20),
  myLook,
  onUpdate: () => { if (panel && !panel.isDestroyed()) panel.webContents.send('peer:update'); },
  sprite: m => toSprite(m),
  say: (title, sub, action) => toSprite({ type: 'say', title, sub, ms: 0, trick: 'loop', action }),
  visitor: {
    open(v) {
      const sb = sprite && !sprite.isDestroyed() ? sprite.getBounds() : null, d = screen.getDisplayNearestPoint(sb ? { x: sb.x + 110, y: sb.y + 110 } : screen.getCursorScreenPoint());
      const w = new BrowserWindow({ width: 300, height: 380, x: d.workArea.x, y: d.workArea.y, frame: false, transparent: true, hasShadow: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
        fullscreenable: false, minimizable: false, maximizable: false, show: false, type: 'panel', backgroundColor: '#00000000', title: 'JM Desk 访客',
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
      w.setAlwaysOnTop(true, 'floating'); try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
      remoteMain.enable(w.webContents);
      const u = pathToFileURL(R('visitor.html')); u.searchParams.set('rp', path.join(HERE, '..'));
      u.searchParams.set('v', JSON.stringify({ ...v, home: sb ? { x: sb.x, y: sb.y } : null, wa: d.workArea }));
      w.loadURL(u.href); visitors.set(v.id, w); w.on('closed', () => visitors.delete(v.id));
      setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 6 * 60e3); // 兜底：最多停留 6 分钟
    },
    send(id, m) { const w = visitors.get(id); if (w && !w.isDestroyed()) w.webContents.send('visitor', m); },
  },
  /* B 这边：只用开放给伙伴的只读工具，用 B 自己的模型找，回答带依据 */
  async search({ ask, peer, share }) {
    const c = await hub.catalog(), tools = peers.scopeTools(c.tools, share).map(t => ({ ...t, needsConfirm: () => false }));
    if (!tools.length) throw new Error('主人没有开放可以查的内容');
    if (!hasModel('assistant')) throw new Error('主人这边还没配置模型');
    const r = await agent.run({ question: ask, tools, maxSteps: 6, confirm: async () => false,
      hint: `这是伙伴「${peer}」的精灵来串门找资料。只能用列出的工具；回答简明，写明依据的资料名称；查不到就直说查不到，不要编造，也不要透露工具范围以外的任何信息。`,
      chat: (sy, us) => chatJSON(sy, us, { task: 'assistant' }), call: (t, args) => hub.call(t.integ, t.tool, args) });
    if (!r.steps.some(s => s.kind === 'call' && s.ok)) {
      if (r.steps.some(s => s.kind === 'call')) throw new Error('知识库这次没连上');
      return { answer: '', used: [] };
    }
    return { answer: r.answer, used: r.used };
  },
});
app.on('before-quit', () => peerHub.stop());
ipcMain.on('visitor:decide', (_e, id, ok) => peerHub.decide(String(id), !!ok));
ipcMain.on('visitor:gone', (_e, id) => { const w = visitors.get(String(id)); if (w && !w.isDestroyed()) w.close(); });
ipcMain.on('visitor:landed', () => {});
ipcMain.handle('peer:state', () => ({ ...peerHub.state(), presetRelay: !!presetRelay(), relaySetting: settings().peers?.relay || '', scopes: peers.SCOPES }));
ipcMain.handle('peer:config', safe((_e, c) => {
  const s = settings(); s.peers ||= {};
  if ('relay' in c) { const r = String(c.relay || '').trim(); if (r && !peers.relayUrl(r)) throw new Error('中转地址必须是 https（本机测试可以用 http://127.0.0.1）'); s.peers.relay = r; }
  if ('name' in c) s.peers.name = String(c.name || '').trim().slice(0, 20);
  if (c.share) s.peers.share = Object.fromEntries(Object.keys(peers.SCOPES).map(k => [k, !!c.share[k]]));
  store.write('settings.json', s); peerHub.ensureLoop(); return true;
}));
for (const [ch, fn] of Object.entries({ offer: () => peerHub.offer(), claim: (c) => peerHub.claim(c), confirm: () => peerHub.confirm(), cancel: () => peerHub.cancelPair(),
  set: (id, p) => peerHub.setPeer(id, p || {}), remove: id => peerHub.removePeer(id), visit: (id, ask) => peerHub.visit(id, ask), decide: (id, ok) => peerHub.decide(id, ok) }))
  ipcMain.handle('peer:' + ch, safe((_e, ...a) => fn(...a)));
/* 内置工具：不用任何配置，助手就能查和整理 JM Desk 自己的线索、待办、需求池 */
function localTools() {
  const pick = (o, ks) => Object.fromEntries(ks.filter(k => o[k] != null && o[k] !== '').map(k => [k, o[k]]));
  return [
    { name: 'list_todos', title: '查看待办', write: false, description: '列出我的待办（从线索整理出的跟进动作）。kind：follow 需求跟进 / daily 日常；status：open / done',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'done', 'all'] }, kind: { type: 'string', enum: ['follow', 'daily'] } } },
      handler: a => services.tasks().filter(t => (a.status === 'all' || t.status === (a.status || 'open')) && (!a.kind || t.kind === a.kind)).slice(0, 60)
        .map(t => ({ ...pick(t, ['id', 'title', 'summary', 'status', 'deadline', 'who']), kind: t.kind, requirement: t.requirement?.title, project: t.project?.title })) },
    { name: 'list_requirements', title: '查看需求池', write: false, description: '列出需求池：按项目分组的需求，每条是项目里要完成的一件完整的事，附跟进待办数',
      inputSchema: { type: 'object', properties: {} },
      handler: () => services.requirementPool().projects.map(g => ({ project: g.title, project_id: g.id, line: g.line, product: g.product, requirements: g.reqs.map(r => pick(r, ['id', 'title', 'type', 'status', 'deadline', 'todosOpen'])) })) },
    { name: 'search_clues', title: '搜索线索', write: false, description: '在收到的邮件、飞书消息、会议纪要里按关键字搜索，返回摘要和 id',
      inputSchema: { type: 'object', properties: { q: { type: 'string', description: '关键字' }, limit: { type: 'number' } }, required: ['q'] },
      handler: a => services.signals({ q: a.q }).items.slice(0, Math.min(20, Number(a.limit) || 10)).map(x => ({ ...pick(x, ['id', 'title', 'preview', 'at', 'sourceLabel']), people: x.people })) },
    { name: 'get_clue', title: '读线索原文', write: false, description: '读取一条线索的完整内容（聊天记录或邮件正文）',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: a => { const d = services.signal(String(a.id)); return { title: d.title, at: d.at, people: d.people, messages: d.messages?.slice(-40), mail: d.mail ? { from: d.mail.from, body: String(d.mail.body).slice(0, 6000) } : undefined, derived: d.derived }; } },
    { name: 'add_todo', title: '新建待办', write: true, description: '新建一条待办；为推进某条需求的，填 requirement_id（来自 list_requirements）',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, requirement_id: { type: 'string' }, deadline: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['title'] },
      handler: a => { const t = services.addTodo(a); pushCounts(); return { ok: true, id: t.id }; } },
    { name: 'set_todo_status', title: '完成 / 重开待办', write: true, description: '把一条待办标为完成（done）或重新打开（open）',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['done', 'open'] } }, required: ['id', 'status'] },
      handler: a => { services.setTask(String(a.id), a.status === 'done' ? 'done' : 'open'); pushCounts(); return { ok: true }; } },
  ];
}

function setKey(id, v) { const sec = store.read('secrets.json', {}); sec.keys ||= {}; if (v) sec.keys[id] = safeStorage.encryptString(v).toString('base64'); else delete sec.keys[id]; store.write('secrets.json', sec); }
function migrateModels() {
  const s = settings();
  if (providers.migrate(s)) {
    const sec = store.read('secrets.json', {}); if (sec.model) { sec.keys = { ...(sec.keys || {}), deepseek: sec.model }; delete sec.model; store.write('secrets.json', sec); }
    store.write('settings.json', s);
  }
}
let router = null, usage = null;
const chatJSON = (system, user, opts = {}) => router.chat(system, user, { task: 'customize', ...opts }).then(r => r.data);
const hasModel = task => router.candidates(task).length > 0;

/* ---------- AI 定制：只产出数据（布局 / 形象参数），经校验后由用户确认应用 ---------- */
async function aiLayout(request) {
  const cat = Object.entries(CATALOG).map(([id, a]) => `${id}｜${a.label}｜${a.tip}`).join('\n');
  const sys = `你在帮用户调整桌面精灵的气泡菜单。只输出一个 JSON 对象：{"layout":{"version":1,"groups":[{"id":"小写英文","label":"1-5个字","icon":"图标名","color":["#hex","#hex"],"tip":"一句说明","items":["动作id",...]}]},"summary":"一句话说明改了什么"}。
规则：只能使用下列动作 id，每个动作最多出现一次；分组 1-6 个，每组最多 8 个；必须保留 app.settings；图标只能从 ${ICONS.join('、')} 中选。
可用动作（id｜名称｜说明）：\n${cat}`;
  const out = await chatJSON(sys, `当前布局：${JSON.stringify(loadLayout())}\n用户要求：${request}`);
  const v = validateLayout(out.layout);
  return { ok: v.ok, errors: v.errors, layout: v.layout, summary: String(out.summary || '').slice(0, 120) };
}
async function aiCharacter(request) {
  const sys = `你在帮用户定制原创桌面精灵「星灵」的外观参数。只输出 JSON：{"params":{"body":"#hex","body2":"#hex","belly":"#hex","cheek":"#hex","eye":"#hex","star":"#hex","antenna":"star|leaf|none","tail":true|false,"size":0.8-1.3},"summary":"一句话"}。
只能调整这些参数。如果用户想要某个现成的动漫/游戏角色，不要模仿它，只借用颜色气质做一个原创配色，并在 summary 里说明。`;
  const out = await chatJSON(sys, `当前参数：${JSON.stringify(loadCharacter().params)}\n用户要求：${request}`);
  return { ok: true, params: sanitizeParams(out.params), summary: String(out.summary || '').slice(0, 120) };
}

/* ---------- 窗口 ---------- */
function defaultPos() { const wa = screen.getPrimaryDisplay().workArea; return { x: wa.x + wa.width - STAGE - 10, y: wa.y + wa.height - STAGE - 10 }; }
function onScreen(p) { const cx = p.x + STAGE / 2, cy = p.y + STAGE / 2; return screen.getAllDisplays().some(d => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height); }
function createSprite() {
  const saved = settings().pos, p = saved && onScreen(saved) ? saved : defaultPos();
  sprite = new BrowserWindow({
    x: p.x, y: p.y, width: STAGE, height: STAGE, frame: false, transparent: true, hasShadow: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, minimizable: false, maximizable: false, show: false,
    type: 'panel', backgroundColor: '#00000000', title: 'JM Desk 精灵',
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  sprite.setAlwaysOnTop(true, 'floating');
  try { sprite.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  remoteMain.enable(sprite.webContents);
  const u = pathToFileURL(R('sprite.html')); u.searchParams.set('rp', path.join(HERE, '..'));
  sprite.loadURL(u.href);
  sprite.once('ready-to-show', () => sprite.showInactive());
  sprite.on('closed', () => { sprite = null; });
}
/* 面板主色跟随当前形象：内置星灵取它的身体色；形象包可在 manifest 里写 theme: ["#a1", "#a2"] */
function themeFor(ch = loadCharacter()) {
  const c = CHARACTERS[ch.id] || {}, hex = /^#[0-9a-fA-F]{6}$/;
  if (Array.isArray(c.theme) && c.theme.length === 2 && c.theme.every(x => hex.test(x))) return c.theme;
  if (ch.id === 'lumi') return [ch.params.body || '#a78bfa', ch.params.body2 || '#60a5fa'];
  return ['#f472b6', '#a78bfa'];
}
/* 面板窗口启动时就建好（隐藏），点开时只是挪位置、换内容、显示 */
const PANEL_W = 434;
let panelReady = false, pendingShow = null;
function createPanel() {
  panelReady = false;
  panel = new BrowserWindow({
    width: PANEL_W, height: 600, show: false, frame: false, transparent: true, resizable: true, alwaysOnTop: true, hasShadow: false,
    type: process.platform === 'darwin' ? 'panel' : undefined, // 不激活整个应用：第一次打开不卡、也不会把别的窗口带到前面
    skipTaskbar: true, fullscreenable: false, minimizable: false, maximizable: false, backgroundColor: '#00000000', title: 'JM Desk',
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  panel.setAlwaysOnTop(true, 'floating');
  panel.loadURL(pathToFileURL(R('panel.html')).href + '#app.settings');
  panel.webContents.once('did-finish-load', () => {
    // 透明窗口第一次显示要额外 100 多毫秒：启动时先完全透明地显示一下再藏起来，之后点开就是即时的
    if (!pendingShow) {
      try { panel.setOpacity(0); panel.showInactive(); } catch {}
      setTimeout(() => { if (panel && !panel.isDestroyed()) { if (!showTimer && !pendingShow) panel.hide(); panel.setOpacity(1); } panelReady = true; if (pendingShow) { const p = pendingShow; pendingShow = null; openPanel(p); } }, 400);
      return;
    }
    panelReady = true; const p = pendingShow; pendingShow = null; openPanel(p);
  });
  /* 点别处收起：只有焦点真的离开了 JM Desk（不是切到精灵、提示层或别的 JM Desk 窗口），并且不是刚打开的一瞬间；钉住时不收 */
  panel.on('blur', () => {
    if (!panel || panel.isDestroyed() || panel.webContents.isDevToolsOpened() || panel.__pinned) return;
    if (Date.now() - (panel.__shownAt || 0) < 600) return;
    setTimeout(() => {
      if (!panel || panel.isDestroyed() || panel.__pinned || panel.isFocused() || !panel.isVisible()) return;
      const f = BrowserWindow.getFocusedWindow(); if (f && f !== panel && !f.isDestroyed()) return; // 焦点还在 JM Desk 自己的窗口里
      panel.webContents.send('panel:hiding'); setTimeout(() => { if (panel && !panel.isDestroyed() && !panel.isFocused() && !panel.__pinned) panel.hide(); }, 120);
    }, 150);
  });
  panel.on('show', () => { panel.__shownAt = Date.now(); });
  panel.on('closed', () => { panel = null; });
}
let showTimer = null;
ipcMain.on('panel:ready', () => { DBG('ack', !!showTimer); if (!panel || panel.isDestroyed() || !showTimer) return; clearTimeout(showTimer); showTimer = null; const t = Date.now(); panel.show(); const t1 = Date.now(); panel.focus(); DBG('show', t1 - t, 'focus', Date.now() - t1); });
const DBG = process.env.JM_DESK_DEBUG ? (...a) => console.log('[panel]', Date.now() % 100000, ...a) : () => {};
function openPanel(page) {
  DBG('open', page, 'ready', panelReady);
  if (!panel || panel.isDestroyed()) createPanel();
  if (!panelReady) { pendingShow = page; return; }
  const sb = sprite && !sprite.isDestroyed() ? sprite.getBounds() : { x: 200, y: 200, width: STAGE, height: STAGE };
  const cx = sb.x + sb.width / 2, cy = sb.y + sb.height / 2, R0 = 72; // 精灵泡泡的大致半径
  const d = screen.getDisplayNearestPoint({ x: cx, y: cy }).workArea, W = PANEL_W, H = Math.min(620, d.height - 16);
  const right = cx + R0 + W <= d.x + d.width;                 // 面板放在精灵右边？
  const x = right ? cx + R0 - 6 : Math.max(d.x + 4, cx - R0 + 6 - W);
  const y = Math.max(d.y + 8, Math.min(cy - H / 2, d.y + d.height - H - 8));
  const ch = loadCharacter();
  const keep = panel.__pinned && panel.isVisible(); // 钉住时留在用户放的位置
  if (!keep) panel.setBounds({ x: Math.round(x), y: Math.round(y), width: W, height: Math.round(H) });
  // 小泡泡串的位置：对准精灵中心，但不超出面板圆角
  const ty = Math.round(Math.max(48, Math.min(H - 48, cy - y)));
  panel.webContents.send('panel:go', { page, side: right ? 'left' : 'right', ty, theme: themeFor(ch), sub: `${(CHARACTERS[ch.id] || {}).name || ''}的小窗` });
  clearTimeout(showTimer);
  DBG('sent go');
  showTimer = setTimeout(() => { DBG('fallback show'); showTimer = null; if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); } }, 150); // 兜底
  if (panel.isVisible()) { clearTimeout(showTimer); showTimer = null; panel.focus(); }
}
function broadcast(ch, v) { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ch, v); }

/* ---------- 动作 ---------- */
function runAction(id) {
  if (String(id).startsWith('reminder:')) return openReminder(String(id).slice(9));
  const a = CATALOG[id];
  if (!a) return;
  if (a.kind === 'app') return openPanel(id);
  if (id === 'app.work') return openBig('work');
  if (id === 'app.clues') return openBig('list');
  if (id === 'mail.compose') return shell.openExternal('mailto:');
  if (id === 'mail.open') {
    const client = settings().mailClient;
    if (client) return shell.openPath(client);
    const ms = mailspringApp();
    if (fs.existsSync(ms)) return shell.openPath(ms);
    return shell.openExternal('mailto:');
  }
}

/* ---------- IPC ---------- */
ipcMain.on('jm:layout', e => { e.returnValue = resolveLayout(loadLayout()); });
ipcMain.on('jm:character', e => { e.returnValue = loadCharacter(); });
ipcMain.on('jm:theme', e => { const ch = loadCharacter(); e.returnValue = { theme: themeFor(ch), name: (CHARACTERS[ch.id] || {}).name || 'JM Desk', version: app.getVersion() }; });
ipcMain.on('jm-buddy-float', (e, json) => {
  let m; try { m = JSON.parse(json); } catch { return; }
  if (m.type === 'action') runAction(m.id);
  else if (m.type === 'savePos') { const s = settings(); s.pos = { x: Math.round(m.x), y: Math.round(m.y) }; store.write('settings.json', s); }
  else if (m.type === 'move' && sprite) sprite.setPosition(Math.round(m.x), Math.round(m.y));
  else if (m.type === 'quit') app.quit();
});
ipcMain.handle('panel:state', () => (scanCharacters(), { theme: themeFor(),
  layout: loadLayout(), catalog: CATALOG, icons: ICONS, character: loadCharacter(), characters: Object.values(CHARACTERS).map(({ id, name, author, license, kind, builtin }) => ({ id, name, author, license, kind, builtin: !!builtin })),
  dataDir: store.dir, platform: process.platform, version: app.getVersion(),
}));
ipcMain.handle('panel:save-layout', (_e, l) => { const v = validateLayout(l); if (v.ok) { store.write('layout.json', v.layout); broadcast('jm:layout', resolveLayout(v.layout)); } return v; });
ipcMain.handle('panel:reset-layout', () => { store.write('layout.json', DEFAULT_LAYOUT); broadcast('jm:layout', resolveLayout(DEFAULT_LAYOUT)); return DEFAULT_LAYOUT; });
ipcMain.handle('panel:save-character', (_e, c) => { scanCharacters(); const v = { id: CHARACTERS[c.id] ? c.id : 'lumi', params: sanitizeParams(c.params) }; store.write('character.json', v); reloadSprite(); return v; });
ipcMain.handle('panel:ai-layout', async (_e, req) => { try { return await aiLayout(String(req).slice(0, 500)); } catch (err) { return { ok: false, errors: [err.message] }; } });
ipcMain.handle('panel:ai-character', async (_e, req) => { try { return await aiCharacter(String(req).slice(0, 500)); } catch (err) { return { ok: false, errors: [err.message] }; } });
/* 模型设置：列表、添加 / 修改 / 删除、测试、路由、政策、用量 */
const providerView = p => ({ ...p, hasKey: p.kind === 'api' ? !!getKey(p) : undefined, local: providers.isLocal(p), kindLabel: providers.KINDS[p.kind] || p.kind });
ipcMain.handle('models:state', async () => { const s = settings(); return { providers: (s.providers || []).map(providerView), routing: s.modelRouting || {}, policy: s.modelPolicy || {}, tasks: providers.TASKS, usage: usage.summary(), detected: await providers.detect(net.fetch) }; });
ipcMain.handle('models:save', safe((_e, p) => {
  const s = settings(), list = s.providers || [];
  const id = String(p.id || '').trim() || `${p.kind}-${Date.now().toString(36).slice(-4)}`;
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id) || !providers.KINDS[p.kind]) throw new Error('模型来源的 id 或类型不合法');
  if (p.kind === 'api' && !/^https?:\/\//.test(p.baseUrl || '')) throw new Error('API 地址要以 http(s):// 开头');
  if (p.kind === 'cmd' && !String(p.command || '').trim()) throw new Error('请填写命令');
  const clean = { id, name: String(p.name || id).slice(0, 30), kind: p.kind, enabled: p.enabled !== false, dailyTokens: Math.max(0, Math.floor(Number(p.dailyTokens) || 0)) };
  for (const k of ['baseUrl', 'model', 'command', 'keyEnvFile', 'keyEnvName']) if (p[k]) clean[k] = String(p[k]).trim();
  if (p.kind === 'cmd') { clean.args = Array.isArray(p.args) ? p.args.map(String) : String(p.args || '').split(/\s+/).filter(Boolean); clean.local = p.local !== false; }
  const i = list.findIndex(x => x.id === id); if (i >= 0) list[i] = { ...list[i], ...clean }; else list.push(clean);
  s.providers = list; store.write('settings.json', s);
  if (p.key) setKey(id, String(p.key).trim());
  return providerView(clean);
}));
ipcMain.handle('models:remove', safe((_e, id) => { const s = settings(); s.providers = (s.providers || []).filter(x => x.id !== id); for (const t of Object.keys(s.modelRouting || {})) s.modelRouting[t] = s.modelRouting[t].filter(x => x !== id); store.write('settings.json', s); setKey(id, ''); return true; }));
ipcMain.handle('models:routing', safe((_e, routing, policy) => {
  const s = settings(), ids = new Set((s.providers || []).map(p => p.id));
  s.modelRouting = Object.fromEntries(Object.keys(providers.TASKS).map(t => [t, (routing?.[t] || []).filter(id => ids.has(id))]));
  s.modelPolicy = { privateLocalOnly: !!policy?.privateLocalOnly };
  store.write('settings.json', s); return true;
}));
ipcMain.handle('models:test', safe(async (_e, id) => {
  const p = (settings().providers || []).find(x => x.id === id); if (!p) throw new Error('没有这个模型来源');
  const t = Date.now(), r = await providers.CALLERS[p.kind](p, '你只输出 JSON。', '只输出 {"ok":true}', { getKey });
  const ok = providers.parseJSON(r.text).ok === true, used = (r.in || 0) + (r.out || 0);
  usage.add({ provider: p.id, task: 'test', in: r.in ?? 0, out: r.out ?? 0, est: r.in == null });
  return { ok, secs: Math.round((Date.now() - t) / 100) / 10, tokens: used };
}));
ipcMain.handle('panel:open-data-dir', () => shell.openPath(store.dir));
ipcMain.handle('svc:summary-last', safe((_e, kind) => services.lastSummary(kind)));
ipcMain.handle('svc:summary-run', safe(async (_e, kind) => { sayToSprite('✨ 正在汇总', '读邮件、飞书消息和会议纪要…'); const r = await services.summarize({ sources: kind === 'mail' ? ['mail'] : null }); pushCounts(); sayToSprite(`整理出 ${r.items.length} 件事`, r.overview || '', 6000); return r; }));
ipcMain.handle('svc:tasks', safe(() => services.tasks()));
ipcMain.handle('svc:task-set', safe((_e, id, st) => { const l = services.setTask(id, st); pushCounts(); return l; }));
ipcMain.handle('svc:collect', safe(async () => { const r = await services.collect(); const items = services.ticker(12).filter(t => t.kind !== 'error').map(t => t.text); if (items.length) toSprite({ type: 'ticker', title: '📦 搬运完成', items, tail: '' }); return r; }));
ipcMain.handle('svc:pool', safe(() => services.pool()));
ipcMain.handle('svc:signals', safe((_e, f) => services.signals(f || {})));
ipcMain.handle('svc:signal', safe((_e, id) => services.signal(String(id))));
ipcMain.handle('svc:signal-ignore', safe((_e, id, on) => services.setIgnored(String(id), !!on)));
ipcMain.on('list:open', (_e, focusId) => openBig('list', focusId));
ipcMain.on('work:open', (_e, focusId) => openBig('work', focusId));
ipcMain.handle('work:tree', safe((_e, o) => services.workTree(o || {})));
ipcMain.handle('work:item', safe((_e, id) => services.workItem(String(id))));
ipcMain.handle('work:edit', safe((_e, id, patch) => { const r = services.editWork(String(id), patch || {}); pushCounts(); return r; }));
ipcMain.handle('work:reorg', safe(async () => { if (!hasModel('summary')) throw new Error('还没有可用的模型（设置 › 模型）'); const r = await services.reorganize(); pushCounts(); return r; }));
ipcMain.handle('work:sync-taxonomy', safe(() => services.syncTaxonomy()));
ipcMain.handle('mp2:open-pool', () => { const st = mp2link.linkStatus(), web = st.webBase || settings().mp2Url || st.baseUrl; if (web) shell.openExternal(web.replace(/\/+$/, '') + '/requirement/my-pool'); return !!web; });
ipcMain.handle('svc:req-pool', safe(() => services.requirementPool()));
ipcMain.handle('svc:candidates', safe((_e, st) => services.candidates(st)));
ipcMain.handle('svc:source-set', safe((_e, n, on) => services.setSource(n, on)));
ipcMain.handle('svc:ticker', safe(() => services.ticker(40)));
ipcMain.handle('svc:mail-stats', safe(() => services.mailStats()));
ipcMain.handle('svc:kb-list', () => (settings().knowledge || []).map(k => ({ id: k.id, name: k.name, kind: k.kind, enabled: k.enabled !== false, tool: k.tool || null })));
ipcMain.handle('svc:kb-toggle', (_e, id, on) => { const s = settings(); const k = (s.knowledge || []).find(x => x.id === id); if (k) { k.enabled = !!on; store.write('settings.json', s); } return true; });
ipcMain.handle('svc:kb-ask', safe(async (_e, q) => { q = String(q || '').trim().slice(0, 500); if (!q) throw new Error('请输入问题'); return knowledge.ask(settings().knowledge, q, hasModel('knowledge') ? (sy, us) => chatJSON(sy, us, { task: 'knowledge' }) : null); }));
/* 接入管理 */
const integView = i => {
  let c = {}; try { c = JSON.parse(fs.readFileSync(integCacheFile(), 'utf8'))[i.id] || null; } catch { c = null; }
  const sec = i.builtin ? {} : integSecret(i.id), pol = (settings().toolPolicy || {})[i.id] || {};
  const cred = i.credential ? { label: i.credential.label || '凭据', help: i.credential.help || '', set: !!(sec.token || sec.tokenFile), file: sec.tokenFile ? String(sec.tokenFile).replace(os.homedir(), '~') : null, fileOk: sec.tokenFile ? !!integCredential(i) : null, inherited: !!sec.inherited } : null;
  return { ...i, cred, kindLabel: integrations.KINDS[i.kind], secretKeys: { env: Object.keys(sec.env || {}), headers: Object.keys(sec.headers || {}), token: !!sec.token && !i.credential },
    checkedAt: c?.at || null, server: c?.info || null, tools: (c?.tools || []).map(t => ({ name: t.name, title: t.title, description: t.description, write: t.write, dynamic: !!t.dynamic, mode: integrations.modeOf(t, pol) })) };
};
ipcMain.handle('integ:state', () => ({ list: allIntegrations().map(integView), kinds: integrations.KINDS, modes: integrations.MODES, mp2Linked: !!mp2Mcp() }));
ipcMain.handle('integ:save', safe((_e, x) => {
  const s = settings(), list = s.integrations || [];
  const id = String(x.id || '').trim() || `${x.kind === 'api' ? 'api' : 'mcp'}-${Date.now().toString(36).slice(-5)}`;
  if (id === 'mp2' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(id) || !integrations.KINDS[x.kind]) throw new Error('接入的 id 或类型不合法');
  const c = { id, name: String(x.name || id).trim().slice(0, 30), kind: x.kind, enabled: x.enabled !== false };
  if (x.kind === 'mcp-stdio') { if (!String(x.command || '').trim()) throw new Error('请填写启动命令'); c.command = String(x.command).trim(); c.args = Array.isArray(x.args) ? x.args.map(String) : String(x.args || '').split(/\s+/).filter(Boolean); if (x.cwd) c.cwd = String(x.cwd).trim(); }
  if (x.kind === 'mcp-http') { if (!integrations.allowedUrl(x.url)) throw new Error('MCP 网址必须是 https（本机 127.0.0.1 / localhost 除外）'); c.url = String(x.url).trim(); }
  if (x.kind === 'api') {
    if (x.baseUrl && !integrations.allowedUrl(x.baseUrl)) throw new Error('接口地址必须是 https（本机 127.0.0.1 / localhost 除外）');
    if (!x.baseUrl && !x.openapi) throw new Error('请填写接口地址或 OpenAPI 文档');
    if (x.baseUrl) c.baseUrl = String(x.baseUrl).trim(); if (x.openapi) c.openapi = String(x.openapi).trim();
    c.auth = { type: ['bearer', 'header', 'query'].includes(x.auth?.type) ? x.auth.type : 'none', name: String(x.auth?.name || '').trim().slice(0, 60) || undefined };
  }
  const i = list.findIndex(y => y.id === id); if (i >= 0) list[i] = c; else list.push(c);
  s.integrations = list; store.write('settings.json', s);
  // 密钥：留空表示不改；传了就整体替换
  const old = integSecret(id), sec = { ...old };
  if (x.secret?.env) sec.env = x.secret.env; if (x.secret?.headers) sec.headers = x.secret.headers; if (x.secret?.token != null && x.secret.token !== '') sec.token = String(x.secret.token);
  setIntegSecret(id, sec); hub.drop(id);
  return integView(c);
}));
ipcMain.handle('integ:credential', safe((_e, id, c) => {
  const i = allIntegrations().find(x => x.id === id); if (!i?.credential) throw new Error('这个接入不需要凭据');
  const sec = integSecret(id);
  if (c?.token) { sec.token = String(c.token).trim(); delete sec.tokenFile; } else if (c?.tokenFile) { sec.tokenFile = String(c.tokenFile).trim(); delete sec.token; } else { delete sec.token; delete sec.tokenFile; } delete sec.inherited;
  setIntegSecret(id, sec); hub.drop(id); return integView(i);
}));
ipcMain.handle('integ:remove', safe((_e, id) => {
  const it = allIntegrations().find(x => x.id === id);
  if (it?.builtin || it?.preset) throw new Error('内置和预置的接入不能删除，可以停用');
  const s = settings(); s.integrations = (s.integrations || []).filter(i => i.id !== id); if (s.toolPolicy) delete s.toolPolicy[id]; store.write('settings.json', s);
  setIntegSecret(id, null); hub.drop(id);
  try { const c = JSON.parse(fs.readFileSync(integCacheFile(), 'utf8')); delete c[id]; fs.writeFileSync(integCacheFile(), JSON.stringify(c, null, 1)); } catch {}
  return true;
}));
ipcMain.handle('integ:toggle', safe((_e, id, on) => {
  const s = settings();
  const it = allIntegrations().find(x => x.id === id);
  if (it?.builtin || it?.preset) { const o = new Set(s.integrationsOff || []); on ? o.delete(id) : o.add(id); s.integrationsOff = [...o]; }
  else { const i = (s.integrations || []).find(x => x.id === id); if (i) i.enabled = !!on; }
  store.write('settings.json', s); if (!on) hub.drop(id); return true;
}));
ipcMain.handle('integ:test', safe(async (_e, id) => {
  const i = allIntegrations().find(x => x.id === id); if (!i) throw new Error('没有这个接入');
  const t = Date.now(), c = await hub.refresh(i);
  return { tools: c.tools.length, server: c.info, secs: Math.round((Date.now() - t) / 100) / 10 };
}));
ipcMain.handle('integ:policy', safe((_e, id, tool, mode) => {
  if (!integrations.MODES[mode]) throw new Error('模式不对');
  const s = settings(); s.toolPolicy ||= {}; s.toolPolicy[id] ||= {}; s.toolPolicy[id][String(tool)] = mode; store.write('settings.json', s); return true;
}));
/* 从 Claude Code / Claude Desktop / Cursor / Codex 导入：界面只拿到名字和变量名，值直接加密保存，不经过界面 */
ipcMain.handle('integ:detect', () => {
  const have = new Set(allIntegrations().map(i => i.command ? i.command + ' ' + (i.args || []).join(' ') : i.url));
  return integrations.detectExternal().map((d, n) => ({ n, from: d.from, name: d.name, kind: d.kind, kindLabel: integrations.KINDS[d.kind], command: d.command, args: d.args, url: d.url,
    envKeys: Object.keys(d.env), headerKeys: Object.keys(d.headers), exists: have.has(d.command ? d.command + ' ' + d.args.join(' ') : d.url) }));
});
ipcMain.handle('integ:import', safe((_e, picks) => {
  const all = integrations.detectExternal(), s = settings(), list = s.integrations || [], done = [];
  for (const n of picks || []) {
    const d = all[n]; if (!d) continue;
    if (d.kind === 'mcp-http' && !integrations.allowedUrl(d.url)) continue;
    let id = d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'mcp'; if (id === 'mp2') id = 'mp2-ext';
    while (list.some(x => x.id === id)) id += '-2';
    const c = { id, name: d.name, kind: d.kind, enabled: true, importedFrom: d.from, ...(d.kind === 'mcp-stdio' ? { command: d.command, args: d.args, ...(d.cwd ? { cwd: d.cwd } : {}) } : { url: d.url }) };
    list.push(c); setIntegSecret(id, { env: d.env, headers: d.headers }); done.push(c.name);
  }
  s.integrations = list; store.write('settings.json', s); return done;
}));

/* 助手：用接入的工具办事；需要确认的操作弹窗问人 */
const pendingConfirm = new Map(); let confirmSeq = 0;
ipcMain.handle('agent:confirm-reply', (_e, id, ok) => { const p = pendingConfirm.get(id); if (p) { pendingConfirm.delete(id); p(!!ok); } return true; });
/* 问知识：交给助手，只用标了 knowledge 的接入（知识库 MCP）；它会先查有哪些平台再带平台检索。没有知识库 MCP 时退回旧的直连方式 */
ipcMain.handle('kb:ask', safe(async (e, question) => {
  const q = String(question || '').trim().slice(0, 500); if (!q) throw new Error('请输入问题');
  const c = await hub.catalog(), tools = c.tools.filter(t => t.integ.knowledge).map(t => ({ ...t, needsConfirm: args => integrations.needsConfirm(t.tool, args, t.mode) === true }));
  if (!tools.length) { const r = await knowledge.ask(settings().knowledge, q, hasModel('knowledge') ? (sy, us) => chatJSON(sy, us, { task: 'knowledge' }) : null); return { legacy: true, ...r, problems: c.problems }; }
  if (!hasModel('knowledge')) throw new Error('还没有可用的模型（设置 › 模型）');
  const wc = e.sender;
  const r = await agent.run({ question: q, tools, maxSteps: 8,
    hint: '这是知识问答。问题没说清是哪个平台或业务对象时，先用 business_catalog 看有哪些平台，再用 knowledge_search（或 knowledge_ask）带上最相关的 platform 检索；可以换关键词多查一两次。回答只依据检索到的资料，写明依据的资料名称；资料里没有就直说缺什么。如果检索返回「指代不足」或「未完成」，换个关键词（中英文、全称缩写）再查，或改用 knowledge_task_start 发起异步检索，再用同一个 task_id 调 knowledge_task_result 取结果。',
    chat: (sy, us) => chatJSON(sy, us, { task: 'knowledge' }), call: (t, args) => hub.call(t.integ, t.tool, args), confirm: async () => false,
    onStep: s => { if (!wc.isDestroyed()) wc.send('agent:step', { ...s, result: s.result ? String(s.result).slice(0, 1500) : undefined }); } });
  return { ...r, problems: c.problems };
}));
ipcMain.handle('agent:tools', safe(async () => { const c = await hub.catalog({ ensure: false }); return { count: c.tools.length, integrations: [...new Set(c.tools.map(t => t.integ.name))] }; }));
ipcMain.handle('agent:ask', safe(async (e, question) => {
  const q = String(question || '').trim().slice(0, 1000); if (!q) throw new Error('请输入要办的事');
  if (!hasModel('assistant')) throw new Error('还没有可用的模型（设置 › 模型）');
  const c = await hub.catalog();
  if (!c.tools.length) throw new Error('还没有可用的工具：先在「接入」里添加平台 API 或 MCP，并点一次「测试」' + (c.problems.length ? '（' + c.problems.join('；') + '）' : ''));
  const tools = c.tools.map(t => ({ ...t, needsConfirm: args => integrations.needsConfirm(t.tool, args, t.mode) === true }));
  const wc = e.sender;
  const r = await agent.run({
    question: q, tools,
    chat: (sy, us) => chatJSON(sy, us, { task: 'assistant' }),
    call: (t, args) => hub.call(t.integ, t.tool, args),
    confirm: req => new Promise(res => {
      const id = ++confirmSeq; pendingConfirm.set(id, res);
      if (wc.isDestroyed()) return res(false);
      if (panel && !panel.isDestroyed() && wc === panel.webContents && !panel.isVisible()) { panel.show(); panel.focus(); }
      wc.send('agent:confirm', { id, ...req, args: JSON.stringify(req.args, null, 1).slice(0, 3000) });
      setTimeout(() => { if (pendingConfirm.has(id)) { pendingConfirm.delete(id); res(false); } }, 5 * 60e3);
    }),
    onStep: s => { if (!wc.isDestroyed()) wc.send('agent:step', { ...s, result: s.result ? String(s.result).slice(0, 1500) : undefined }); },
  });
  return { ...r, problems: c.problems };
}));
ipcMain.handle('svc:open-url', (_e, u) => { if (/^https?:\/\//.test(u)) shell.openExternal(u); });
/* ---------- 关联需求管理平台（MP2）账号：设备授权 ----------
 * secret 和凭据只留在主进程 / 本机文件里；发给界面的状态只有代码、确认页地址和结果。 */
let linking = null; // { link（含 secret，不外传）, ac, view }
const linkView = () => ({ account: mp2link.linkStatus(), linking: linking ? linking.view : null, lastUrl: settings().mp2Url || mp2link.linkStatus().baseUrl || '' });
function pushLink() { if (panel && !panel.isDestroyed()) panel.webContents.send('mp2:link', linkView()); }
const openHttp = u => { if (process.env.JM_DESK_NO_BROWSER) return; if (/^https?:\/\//i.test(u || '')) shell.openExternal(u); }; // JM_DESK_NO_BROWSER 仅用于自动化测试
ipcMain.handle('mp2:state', () => linkView());
ipcMain.handle('mp2:link-start', async (_e, url) => {
  if (linking) { linking.ac.abort(); linking = null; }
  let link;
  try { link = await mp2link.begin(url); } catch (err) { return { ok: false, error: err.message, code: err.code }; }
  const s = settings(); s.mp2Url = link.base; store.write('settings.json', s);
  const ac = new AbortController();
  linking = { link, ac, view: { phase: 'waiting', user_code: link.user_code, verification_url: link.verification_url, expires_at: link.expires_at, base: link.base } };
  openHttp(link.verification_url); pushLink();
  const me = linking;
  mp2link.waitFor(link, { signal: ac.signal, onStatus: st => { if (linking === me && st.status === 'slow_down') { me.view = { ...me.view, note: 'MP2 要求放慢查询' }; pushLink(); } } })
    .then(r => {
      if (linking !== me) return;
      me.view = { ...me.view, phase: r.status };
      if (r.status === 'connected') { sayToSprite('已关联需求管理平台', '搬运会送进你的个人需求池', 5000); linking = null; }
      pushLink();
    })
    .catch(err => { if (linking !== me || err.code === 'cancelled') return; me.view = { ...me.view, phase: 'error', message: err.message }; pushLink(); });
  return { ok: true, view: linkView() };
});
ipcMain.handle('mp2:link-cancel', () => { if (linking) { linking.ac.abort(); linking = null; } return linkView(); });
ipcMain.handle('mp2:link-reopen', () => { if (linking) openHttp(linking.view.verification_url); });
ipcMain.handle('mp2:unlink', () => { if (linking) { linking.ac.abort(); linking = null; } mp2link.unlink(); return linkView(); });
ipcMain.handle('mp2:open-revoke', () => { const b = mp2link.linkStatus().baseUrl || settings().mp2Url; if (b) openHttp(b.replace(/\/+$/, '') + '/ai-access'); });

function toSprite(m) { if (sprite && !sprite.isDestroyed()) sprite.webContents.send('jm', JSON.stringify(m)); }
function sayToSprite(title, sub, ms = 0) { toSprite({ type: 'say', title, sub, ms, trick: 'wave' }); }
async function pushCounts() {
  try { const m = await services.mailStats(); const tasks = services.tasks().filter(t => t.status === 'open').length;
    toSprite({ type: 'counts', unread: m.available ? m.human : 0, tasks }); toSprite({ type: 'badge', n: tasks }); } catch {}
}
ipcMain.handle('panel:pin', (_e, v) => { if (!panel || panel.isDestroyed()) return false; panel.__pinned = !!v; return panel.__pinned; });
ipcMain.handle('panel:pin-state', () => !!(panel && !panel.isDestroyed() && panel.__pinned));
function unpinPanel() { if (panel && !panel.isDestroyed() && panel.__pinned) { panel.__pinned = false; panel.webContents.send('panel:pinned', false); } }
ipcMain.on('panel:close', () => { if (!panel) return; unpinPanel(); panel.hide(); });
ipcMain.on('panel:action', (_e, id) => runAction(id));
ipcMain.handle('svc:has-model', (_e, task) => hasModel(task || 'summary'));

/* ---------- 形象库 ---------- */
const charDir = () => path.join(store.dir, 'extensions', 'character');
const sourcesFile = () => store.file('character-sources.json');
function galleryView() {
  const packs = scanCharacters();
  const sources = gallery.listSources(path.join(HERE, '..', 'builtin', 'characters.json'), sourcesFile());
  return { current: loadCharacter().id, sourcesFile: sourcesFile(),
    sources: sources.map(x => ({ ...x, installed: !!packs[x.id] })),
    packs: Object.values(packs).map(({ id, name, license, kind, builtin }) => ({ id, name, license, kind, builtin: !!builtin })) };
}
function useCharacter(id) { store.write('character.json', { id, params: loadCharacter().params }); reloadSprite(); }
ipcMain.handle('char:gallery', () => galleryView());
ipcMain.handle('char:install-source', safe(async (_e, id) => {
  const src = gallery.listSources(path.join(HERE, '..', 'builtin', 'characters.json'), sourcesFile()).find(x => x.id === id);
  if (!src) throw new Error('形象库里没有这个形象');
  const buf = await gallery.download(net.fetch, src.url);
  gallery.installPack(charDir(), { id: src.id, name: src.name, buf, source: src.url, page: src.page, license: src.license, size: src.size || 1.5 });
  useCharacter(src.id); return galleryView();
}));
ipcMain.handle('char:install-url', safe(async (_e, url, name) => {
  const u = String(url || '').trim(), id = gallery.slug(name || new URL(u).pathname.split('/').pop());
  if (scanCharacters()[id]) throw new Error(`已经有一个叫 ${id} 的形象`);
  const buf = await gallery.download(net.fetch, u);
  gallery.installPack(charDir(), { id, name: String(name || id).trim(), buf, source: u });
  useCharacter(id); return galleryView();
}));
ipcMain.handle('char:install-file', safe(async (_e, name) => {
  const r = await dialog.showOpenDialog(panel && !panel.isDestroyed() ? panel : undefined, { title: '选择 3D 模型', properties: ['openFile'], filters: [{ name: 'glTF 模型', extensions: ['glb'] }] });
  if (r.canceled || !r.filePaths[0]) return galleryView();
  const f = r.filePaths[0], id = gallery.slug(name || path.basename(f));
  if (scanCharacters()[id]) throw new Error(`已经有一个叫 ${id} 的形象`);
  if (fs.statSync(f).size > 60 * 1024 * 1024) throw new Error('模型太大，上限 60 MB');
  gallery.installPack(charDir(), { id, name: String(name || path.basename(f, '.glb')).trim(), buf: fs.readFileSync(f), source: 'file' });
  useCharacter(id); return galleryView();
}));
ipcMain.handle('char:use', safe((_e, id) => { if (!scanCharacters()[id]) throw new Error('没有这个形象'); useCharacter(id); return galleryView(); }));
ipcMain.handle('char:remove', safe((_e, id) => { gallery.removePack(charDir(), id); if (loadCharacter().id === id || store.read('character.json', {}).id === id) useCharacter('lumi'); return galleryView(); }));
ipcMain.handle('char:open-page', (_e, u) => { if (/^https:\/\//i.test(u || '')) shell.openExternal(u); });
ipcMain.handle('char:open-sources', () => { if (!fs.existsSync(sourcesFile())) fs.writeFileSync(sourcesFile(), '[]\n'); shell.openPath(sourcesFile()); });

/* ---------- 应用内升级 ----------
 * 版本文件地址：settings.json 的 updateFeed 优先，其次安装包里的 builtin/update.json（打包时由发布方写入）。 */
function feedUrl() {
  const s = settings().updateFeed; if (s) return s;
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'builtin', 'update.json'), 'utf8')).feed || ''; } catch { return ''; }
}
const upd = { status: 'idle', info: null, progress: 0, error: null, file: null, checkedAt: null };
const updView = () => ({ ...upd, current: app.getVersion(), feed: feedUrl(), skipped: settings().updateSkip || null });
function pushUpd() { if (panel && !panel.isDestroyed()) panel.webContents.send('upd:state', updView()); }
async function checkUpdate({ manual = false } = {}) {
  const feed = feedUrl();
  if (!feed) { Object.assign(upd, { status: 'nofeed', error: null }); pushUpd(); return updView(); }
  if (['downloading', 'ready'].includes(upd.status)) return updView();
  Object.assign(upd, { status: 'checking', error: null }); pushUpd();
  try {
    const info = await updater.check(net.fetch, { feedUrl: feed, current: app.getVersion() });
    Object.assign(upd, { status: info ? (info.unsupported ? 'unsupported' : 'available') : 'none', info, checkedAt: new Date().toISOString() });
  } catch (err) { Object.assign(upd, { status: 'error', error: err.message, checkedAt: new Date().toISOString() }); }
  pushUpd();
  if (upd.status === 'available' && !manual) {
    const s = settings(), info = upd.info;
    if (info.mandatory) openPanel('app.update');
    else if (s.updateSkip !== info.version && !(s.updateSnoozeUntil && Date.now() < s.updateSnoozeUntil))
      toSprite({ type: 'say', title: `✨ 新版本 ${info.version}`, sub: info.notes[0] || '点我看看更新了什么', ms: 0, trick: 'loop', action: { id: 'app.update' } });
  }
  return updView();
}
async function downloadAndInstall() {
  if (upd.status !== 'available' && upd.status !== 'error') return updView();
  const info = upd.info; if (!info || info.unsupported) return updView();
  Object.assign(upd, { status: 'downloading', progress: 0, error: null }); pushUpd();
  try {
    upd.file = await updater.download(net.fetch, info, path.join(app.getPath('userData'), 'updates'), p => { upd.progress = p; pushUpd(); });
    Object.assign(upd, { status: 'ready', progress: 1 }); pushUpd();
  } catch (err) { Object.assign(upd, { status: 'error', error: err.message }); pushUpd(); return updView(); }
  if (!app.isPackaged) { shell.showItemInFolder(upd.file); return updView(); } // 开发运行时只展示下载好的文件
  const how = updater.install(upd.file, { openPath: f => shell.openPath(f), logFile: path.join(app.getPath('userData'), 'updates', 'install.log') });
  if (how === 'restarting') { sayToSprite('正在升级…', '马上回来', 3000); setTimeout(() => app.exit(0), 600); }
  else { upd.status = 'opened'; pushUpd(); }
  return updView();
}
ipcMain.handle('upd:state', () => updView());
ipcMain.handle('upd:check', () => checkUpdate({ manual: true }));
ipcMain.handle('upd:install', () => downloadAndInstall());
ipcMain.handle('upd:skip', () => { const s = settings(); if (upd.info) s.updateSkip = upd.info.version; store.write('settings.json', s); return updView(); });
ipcMain.handle('upd:later', () => { const s = settings(); s.updateSnoozeUntil = Date.now() + 24 * 3600e3; store.write('settings.json', s); return updView(); });

/* 大窗口：线索（list）、工作台（work）。普通窗口，可调大小，适合翻看全部 */
const bigWins = {};
function openBig(page, focusId) {
  let listWin = bigWins[page];
  if (listWin && !listWin.isDestroyed()) { listWin.webContents.send('list:focus', focusId || null); listWin.show(); listWin.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea, W = Math.min(1120, wa.width - 80), H = Math.min(760, wa.height - 60);
  listWin = new BrowserWindow({
    width: W, height: H, minWidth: 760, minHeight: 480, x: Math.round(wa.x + (wa.width - W) / 2) + (page === 'work' ? 0 : 24), y: Math.round(wa.y + (wa.height - H) / 2) + (page === 'work' ? 0 : 24), show: false, title: page === 'work' ? 'JM Desk · 工作台' : 'JM Desk · 线索',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', backgroundColor: '#fbf8ff', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  bigWins[page] = listWin;
  const u = pathToFileURL(R(page + '.html')); if (focusId) u.searchParams.set('focus', focusId);
  u.searchParams.set('a1', themeFor()[0]); u.searchParams.set('a2', themeFor()[1]);
  listWin.loadURL(u.href);
  listWin.once('ready-to-show', () => { listWin.show(); if (panel && !panel.isDestroyed() && !panel.__pinned) panel.hide(); });
  listWin.on('closed', () => { bigWins[page] = null; });
}

/* ---------- 员工提醒（见 reminders.mjs）：每 20 秒看一次，到点精灵冒气泡；点气泡打开订餐页面等 ---------- */
const remCfg = () => reminders.normalize(settings().reminders);
const remState = () => store.read('reminders-state.json', { fired: {} });
function fireReminder(it, { test = false } = {}) {
  const cfg = remCfg(), url = reminders.urlFor(cfg, it);
  const icon = it.openMeal ? '🍱' : /下班/.test(it.label) ? '🌙' : /饭/.test(it.label) ? '🍚' : '⏰';
  toSprite({ type: 'say', title: `${icon} ${it.label} · ${it.time}`, sub: it.message || (url ? '点我打开' : '到时间啦'), ms: 0, trick: 'wave', action: { id: 'reminder:' + it.id } });
  if (cfg.notify && Notification.isSupported()) { const n = new Notification({ title: `${it.label} · ${it.time}`, body: it.message || '到时间啦', silent: false }); n.on('click', () => openReminder(it.id)); n.show(); }
  if (!test) { const st = remState(); st.fired = { ...st.fired, [it.id]: reminders.dayKey(new Date()) }; store.write('reminders-state.json', st); }
}
function openReminder(id) {
  const cfg = remCfg(), it = cfg.items.find(x => x.id === id); if (!it) return;
  const url = reminders.urlFor(cfg, it);
  if (url) shell.openExternal(url); else if (it.openMeal) openPanel('app.reminders'); // 还没配订餐页面：打开提醒设置
}
function checkReminders() { try { for (const it of reminders.due(remCfg(), new Date(), remState())) fireReminder(it); } catch (e) { console.warn('reminders', e.message); } }
ipcMain.handle('rem:state', () => { const cfg = remCfg(); return { ...cfg, today: reminders.today(cfg, new Date(), remState()), daysText: Object.fromEntries(cfg.items.map(i => [i.id, reminders.daysText(i.days)])) }; });
ipcMain.handle('rem:save', safe((_e, r) => { const s = settings(); s.reminders = reminders.normalize(r); store.write('settings.json', s); return s.reminders; }));
ipcMain.handle('rem:test', safe((_e, id) => { const it = remCfg().items.find(x => x.id === id); if (!it) throw new Error('没有这条提醒'); fireReminder(it, { test: true }); return true; }));

function reloadSprite() { if (!sprite) return createSprite(); const b = sprite.getBounds(); sprite.destroy(); const s = settings(); s.pos = { x: b.x, y: b.y }; store.write('settings.json', s); createSprite(); }

/* ---------- 托盘 ---------- */
function createTray() {
  const img = nativeImage.createFromPath(path.join(HERE, '..', 'builtin', 'tray', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('JM Desk');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示精灵', click: () => (sprite ? sprite.showInactive() : createSprite()) },
    { label: '回到右下角', click: () => { if (!sprite) createSprite(); else { sprite.showInactive(); toSprite({ type: 'corner' }); } } },
    { label: '设置…', click: () => openPanel('app.settings') },
    { label: '检查更新…', click: () => { openPanel('app.update'); checkUpdate({ manual: true }); } },
    { label: '打开数据目录', click: () => shell.openPath(store.dir) },
    { type: 'separator' },
    { label: '退出 JM Desk', click: () => app.quit() },
  ]));
}

app.whenReady().then(() => {
  store = makeStore(path.join(app.getPath('userData'), 'workspace'));
  if (!fs.existsSync(store.file('layout.json'))) store.write('layout.json', DEFAULT_LAYOUT);
  store.watch('layout.json', () => broadcast('jm:layout', resolveLayout(loadLayout())));   // 外部 AI 改文件也立即生效
  store.watch('character.json', () => reloadSprite());
  migrateModels();
  try { inheritCredentials(); } catch (e) { console.warn('inherit credentials', e.message); }
  usage = providers.makeUsage(store.file('usage.jsonl'));
  router = providers.createRouter({ getSettings: settings, getKey, usage });
  services = createServices({ dataStore: store, chatJSON: (sy, us) => chatJSON(sy, us, { task: 'summary' }), getSettings: settings });
  createSprite(); createTray(); createPanel();
  setTimeout(pushCounts, 4000); setInterval(pushCounts, 5 * 60 * 1000);
  setTimeout(checkReminders, 8000); setInterval(checkReminders, 20000); // 员工提醒
  setTimeout(() => peerHub.ensureLoop(), 3000); // 串门收信
  setTimeout(() => checkUpdate(), 15000); setInterval(() => checkUpdate(), 6 * 3600e3); // 启动后 15 秒检查一次，之后每 6 小时
  if (process.env.JM_DESK_OPEN) setTimeout(() => openPanel(process.env.JM_DESK_OPEN), 1500);
});
app.on('second-instance', () => openPanel('app.settings'));
app.on('window-all-closed', e => e.preventDefault?.());
