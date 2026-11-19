/* 应用内升级：读发布方放在网上的 latest.json，有新版本时提示；下载、校验 sha256 后安装并重启。
 * 不依赖代码签名（未签名的 Mac 应用也能用）。
 *
 * latest.json（由 scripts/release.mjs 生成，和安装包一起上传到同一个目录）：
 * {
 *   "version": "2.0.0", "date": "2026-12-01", "notes": ["新增……", "修复……"],
 *   "mandatory": false,                  // true：低于 minVersion 的版本必须升级
 *   "minVersion": null,
 *   "files": { "darwin-arm64": { "url": "JM Desk-2.0.0-arm64.dmg", "sha256": "…", "size": 123 },
 *              "win32-x64":    { "url": "JM Desk Setup 2.0.0.exe", "sha256": "…", "size": 123 } }
 * }
 * url 可以是相对 latest.json 的路径。只接受 https（本机 127.0.0.1 / localhost 除外，方便测试）。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export function cmpVersion(a, b) {
  const p = v => String(v || '0').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}
export function allowedUrl(u, base) {
  let x; try { x = new URL(String(u), base); } catch { return null; }
  if (x.protocol === 'https:') return x.href;
  if (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname)) return x.href;
  return null;
}
export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

/* 解析并校验 latest.json，返回 null（没有新版本 / 没有本平台安装包）或升级信息 */
export function parseFeed(j, { feedUrl, current, platform, arch }) {
  if (!j || typeof j !== 'object' || !j.version) throw new Error('版本文件格式不对');
  const f = j.files && j.files[platformKey(platform, arch)];
  if (cmpVersion(j.version, current) <= 0) return null;
  if (!f) return { version: String(j.version), unsupported: true };
  const url = allowedUrl(f.url, feedUrl);
  if (!url) throw new Error('安装包地址必须是 https');
  if (!/^[0-9a-f]{64}$/i.test(f.sha256 || '')) throw new Error('版本文件缺少安装包的 sha256');
  return {
    version: String(j.version), date: j.date ? String(j.date).slice(0, 20) : null,
    notes: (Array.isArray(j.notes) ? j.notes : j.notes ? [j.notes] : []).map(n => String(n).slice(0, 200)).slice(0, 20),
    mandatory: !!j.mandatory || (j.minVersion ? cmpVersion(current, j.minVersion) < 0 : false),
    url, sha256: f.sha256.toLowerCase(), size: Number(f.size) || null, name: decodeURIComponent(path.basename(new URL(url).pathname)),
  };
}

export async function check(fetchImpl, { feedUrl, current, platform = process.platform, arch = process.arch }) {
  const u = allowedUrl(feedUrl);
  if (!u) throw new Error('升级地址必须是 https');
  const res = await fetchImpl(u + (u.includes('?') ? '&' : '?') + 't=' + Date.now(), { signal: AbortSignal.timeout(20000), cache: 'no-store' });
  if (!res.ok) throw new Error(`检查更新失败：HTTP ${res.status}`);
  return parseFeed(await res.json(), { feedUrl: u, current, platform, arch });
}

/* 下载到 dir，边下边算 sha256；不一致就删掉并报错 */
export async function download(fetchImpl, info, dir, onProgress = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, info.name.replace(/[\\/:*?"<>|]/g, '_')), part = dest + '.part';
  if (fs.existsSync(dest) && sha256File(dest) === info.sha256) { onProgress(1, info.size, info.size); return dest; }
  const res = await fetchImpl(info.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || info.size || 0;
  const hash = crypto.createHash('sha256'), out = fs.createWriteStream(part);
  let got = 0, last = 0;
  try {
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk); hash.update(b); got += b.length;
      if (!out.write(b)) await new Promise(r => out.once('drain', r));
      const now = Date.now(); if (now - last > 150) { last = now; onProgress(total ? got / total : 0, got, total); }
    }
  } finally { await new Promise(r => out.end(r)); }
  const sum = hash.digest('hex');
  if (sum !== info.sha256) { fs.rmSync(part, { force: true }); throw new Error('安装包校验不通过（sha256 不一致），已删除，请稍后重试'); }
  fs.renameSync(part, dest); onProgress(1, got, got);
  return dest;
}
export function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

/* 安装：
 * - macOS：退出后由一个小脚本挂载 dmg、替换当前 .app、去掉隔离标记、重新打开；没有写权限时只打开 dmg 让用户拖拽。
 * - Windows：静默运行 NSIS 安装包（/S），装完自动启动（--force-run）。
 * 返回 'restarting'（调用方应立即退出应用）或 'opened'（已打开安装包，交给用户）。 */
export function install(file, { execPath = process.execPath, pid = process.pid, openPath, logFile } = {}) {
  if (process.platform === 'darwin') {
    const bundle = execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
    let writable = false;
    try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); writable = bundle.endsWith('.app'); } catch {}
    if (!writable) { openPath(file); return 'opened'; }
    const script = path.join(path.dirname(file), 'install-update.sh');
    fs.writeFileSync(script, `#!/bin/sh
# 由 JM Desk 生成：等旧版本退出后替换应用并重新打开
PID="$1"; DMG="$2"; BUNDLE="$3"
i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.2; i=$((i+1)); done
MP=$(hdiutil attach -nobrowse -readonly -noautoopen "$DMG" | awk -F'\\t' '/\\/Volumes\\//{print $NF}' | tail -1)
SRC=$(ls -d "$MP"/*.app 2>/dev/null | head -1)
if [ -z "$SRC" ]; then [ -n "$MP" ] && hdiutil detach "$MP" -quiet; open "$DMG"; exit 1; fi
rm -rf "$BUNDLE.new" "$BUNDLE.old"
if ditto "$SRC" "$BUNDLE.new" && mv "$BUNDLE" "$BUNDLE.old" && mv "$BUNDLE.new" "$BUNDLE"; then rm -rf "$BUNDLE.old"; else rm -rf "$BUNDLE.new"; [ -d "$BUNDLE.old" ] && [ ! -d "$BUNDLE" ] && mv "$BUNDLE.old" "$BUNDLE"; fi
hdiutil detach "$MP" -quiet
xattr -dr com.apple.quarantine "$BUNDLE" 2>/dev/null
open "$BUNDLE"
`, { mode: 0o700 });
    const out = logFile ? fs.openSync(logFile, 'a') : 'ignore';
    spawn('/bin/sh', [script, String(pid), file, bundle], { detached: true, stdio: ['ignore', out, out] }).unref();
    return 'restarting';
  }
  if (process.platform === 'win32') {
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return 'restarting';
  }
  openPath(file); return 'opened';
}
