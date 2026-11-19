/* 把仓库根目录的 src/（收集器、MP2 契约，命令行和桌面应用共用）复制到 app/core/：打包只能包含 app/ 里的文件。
 * 改共享代码请改根目录 src/，不要改 app/core/（会被覆盖）。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(app, '..', 'src'), to = path.join(app, 'core');
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true, filter: f => !/\.DS_Store$/.test(f) && !/cli\.mjs$/.test(f) });
fs.writeFileSync(path.join(to, 'README.md'), '自动生成：由 scripts/sync-core.mjs 从 ../src 复制。不要直接修改。\n');
console.log('core synced:', fs.readdirSync(to).join(' '));
