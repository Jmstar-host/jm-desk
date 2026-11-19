/* 本地状态：~/.jm-desk-space（0700）。收集到的原文只放在本机 outbox，权限 0600。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.JM_DESK_HOME || path.join(os.homedir(), '.jm-desk-space');
const P = n => path.join(HOME, n);

export const DEFAULT_CONFIG = {
  // 信息源授权：每一项单独开关，只读
  // 信息源默认全部关闭：用户在「搬运」页自己勾选后才读取（开源版不预设任何账号或命令行）
  sources: {
    feishu_im: { enabled: false, label: '飞书消息（@我 + 单聊）' },
    feishu_meeting: { enabled: false, label: '飞书会议纪要' },
    mail: { enabled: false, label: '邮件（Mailspring 本地）' },
  },
  // 第一次运行时往回看多久（小时）
  firstLookbackHours: 24,
  // MP2：未配置时只收集到本地 outbox，不发送
  mp2: { baseUrl: null, credentialFile: null },
};

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(P('outbox'), { recursive: true, mode: 0o700 });
}
function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return structuredClone(dflt); } }
function writeJson(file, v) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); }

export function config() {
  ensureHome();
  const c = readJson(P('config.json'), DEFAULT_CONFIG);
  const merged = { ...structuredClone(DEFAULT_CONFIG), ...c, sources: { ...DEFAULT_CONFIG.sources, ...(c.sources || {}) }, mp2: { ...DEFAULT_CONFIG.mp2, ...(c.mp2 || {}) } };
  if (!fs.existsSync(P('config.json'))) writeJson(P('config.json'), merged);
  return merged;
}
export function saveConfig(c) { ensureHome(); writeJson(P('config.json'), c); }

export function state() { ensureHome(); return readJson(P('state.json'), { cursors: {}, runs: [] }); }
export function saveState(s) { s.runs = (s.runs || []).slice(-50); writeJson(P('state.json'), s); }

/* outbox：一条信号一个文件，status: queued | submitted | failed */
export function putSignal(sig) {
  const f = P(`outbox/${sig.id}.json`);
  if (fs.existsSync(f)) return false; // 同一来源只收一次
  writeJson(f, { ...sig, status: 'queued', collectedAt: new Date().toISOString() });
  return true;
}
export function listSignals(status) {
  ensureHome();
  return fs.readdirSync(P('outbox')).filter(n => n.endsWith('.json'))
    .map(n => readJson(P('outbox/' + n), null)).filter(Boolean)
    .filter(s => !status || s.status === status)
    .sort((a, b) => (a.occurred_at || '').localeCompare(b.occurred_at || ''));
}
export function updateSignal(id, patch) {
  const f = P(`outbox/${id}.json`); const s = readJson(f, null); if (!s) return;
  writeJson(f, { ...s, ...patch });
}

/* 搬运记录：给精灵气泡滚动展示用，只放标题级信息，不放正文 */
export function log(kind, text, extra = {}) {
  ensureHome();
  fs.appendFileSync(P('ticker.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, text, ...extra }) + '\n', { mode: 0o600 });
}
export function ticker(n = 20) {
  try { return fs.readFileSync(P('ticker.jsonl'), 'utf8').trim().split('\n').slice(-n).map(l => JSON.parse(l)); } catch { return []; }
}
