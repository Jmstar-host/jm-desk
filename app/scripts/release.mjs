/* 生成升级用的 latest.json（放在 ../dist/）。打完安装包后运行：
 *   node scripts/release.mjs --notes "新增形象库" --notes "面板打开更快" [--mandatory] [--min 1.0.0] [--base https://cdn.example.com/jm-desk/]
 * 然后把 dist/ 里本版本的 .dmg / .exe 和 latest.json 一起上传到升级地址所在的目录。
 * --base 不填时 latest.json 里写相对路径（安装包和 latest.json 放同一目录即可）。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), dist = path.join(app, '..', 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')), v = pkg.version, name = pkg.build?.productName || pkg.productName;
const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const notes = args.flatMap((a, i) => (a === '--notes' ? [args[i + 1]] : [])).filter(Boolean);
const base = opt('--base');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const files = {};
// Intel 版打出来的文件名不带架构后缀；发布时通常改名成 -x64.dmg（下载页按这个名字识别），两种名字都认，优先用改过名的
for (const [key, ...names] of [['darwin-arm64', `${name}-${v}-arm64.dmg`], ['darwin-x64', `${name}-${v}-x64.dmg`, `${name}-${v}.dmg`], ['win32-x64', `${name} Setup ${v}.exe`]]) {
  const file = names.find(n => fs.existsSync(path.join(dist, n))); if (!file) continue;
  const f = path.join(dist, file);
  files[key] = { url: base ? new URL(encodeURIComponent(file), base.endsWith('/') ? base : base + '/').href : encodeURIComponent(file), sha256: sha(f), size: fs.statSync(f).size };
}
if (!Object.keys(files).length) { console.error(`dist/ 里没有 ${v} 版本的安装包，先运行 npm run dist:mac / dist:win`); process.exit(1); }
const out = { version: v, date: new Date().toISOString().slice(0, 10), notes, mandatory: args.includes('--mandatory'), minVersion: opt('--min'), files };
fs.writeFileSync(path.join(dist, 'latest.json'), JSON.stringify(out, null, 2));
console.log(`dist/latest.json → ${v}：${Object.keys(files).join('、')}`);
console.log('上传这些文件到升级地址所在目录：', ['latest.json', ...Object.values(files).map(f => decodeURIComponent(path.basename(f.url)))].join('，'));
