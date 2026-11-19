/* 设置安装包里内置的升级地址（写入 builtin/update.json，打包前运行）：
 *   node scripts/set-update-feed.mjs https://你的地址/jm-desk/latest.json
 *   node scripts/set-update-feed.mjs ""        // 清空（开源默认：不检查更新） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const f = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'builtin', 'update.json');
const u = (process.argv[2] || '').trim();
if (u && !/^https:\/\//.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) { console.error('升级地址必须是 https://'); process.exit(1); }
fs.writeFileSync(f, JSON.stringify({ feed: u }, null, 2) + '\n');
console.log(u ? `升级地址：${u}` : '已清空升级地址');
