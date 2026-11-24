/* 打包前：把企业预置的接入写进 builtin/integrations.json；打包后（--reset）清空，仓库里永远是空的。
 *   JM_DESK_PRESET=/path/to/integrations.json npm run dist:mac
 * 预置文件格式见 builtin/integrations.json 与 AGENTS.md；里面只能放地址和工具白名单，不能放凭据。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'builtin', 'integrations.json');
const EMPTY = { _note: '安装包预置的接入。开源默认为空；企业打包时用 JM_DESK_PRESET=<文件> npm run dist:mac 写入，打完自动清空。', integrations: [] };
/* 预置文件顶层的 update：升级地址（latest.json 的 https 地址），写进 builtin/update.json 并做上标记；--reset 时只清掉带标记的，
 * 用 set-update-feed 手工设置的公开地址不受影响。企业的升级地址常带下载口令，所以同样只在打包时注入，不留在仓库里。 */
const updateFile = path.join(path.dirname(target), 'update.json');
const readUpdate = () => { try { return JSON.parse(fs.readFileSync(updateFile, 'utf8')); } catch { return { feed: '' }; } };
if (process.argv.includes('--reset')) {
  fs.writeFileSync(target, JSON.stringify(EMPTY, null, 2) + '\n'); console.log('预置接入已清空');
  if (readUpdate().fromPreset) { fs.writeFileSync(updateFile, JSON.stringify({ feed: '' }, null, 2) + '\n'); console.log('预置的升级地址已清空'); }
  process.exit(0);
}
const src = process.env.JM_DESK_PRESET;
if (!src) { console.log('没有设置 JM_DESK_PRESET：不预置接入'); process.exit(0); }
const j = JSON.parse(fs.readFileSync(src, 'utf8'));
for (const i of j.integrations || []) {
  const s = JSON.stringify(i);
  if (/Bearer\s+\S{8,}|"token"\s*:|"secret"|"password"|"apiKey"/i.test(s)) { console.error(`预置接入 ${i.id} 里像是带了凭据，拒绝写入`); process.exit(1); }
}
if (j.relay && !/^https:\/\//.test(j.relay)) { console.error('预置的串门中转地址必须是 https'); process.exit(1); }
if (j.update != null) {
  if (typeof j.update !== 'string' || !/^https:\/\/\S+$/.test(j.update)) { console.error('预置的升级地址（update）必须是 https:// 开头的 latest.json 地址'); process.exit(1); }
  fs.writeFileSync(updateFile, JSON.stringify({ feed: j.update, fromPreset: true }, null, 2) + '\n');
}
fs.writeFileSync(target, JSON.stringify({ ...EMPTY, integrations: j.integrations || [], ...(j.relay ? { relay: j.relay } : {}) }, null, 2) + '\n');
console.log(`已预置 ${(j.integrations || []).length} 个接入：${(j.integrations || []).map(i => i.name).join('、')}${j.relay ? '；串门中转：' + j.relay : ''}${j.update ? '；升级地址已写入' : ''}`);
