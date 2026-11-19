/* 用户数据：<userData>/layout.json、character.json、settings.json。外部 AI 直接改这些文件也会被热加载。 */
import fs from 'node:fs';
import path from 'node:path';
export function makeStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = n => path.join(dir, n);
  const read = (n, dflt) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return structuredClone(dflt); } };
  const write = (n, v) => { const t = file(n) + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, file(n)); };
  const watch = (n, cb) => { let t = null; try { fs.watch(dir, (ev, f) => { if (f === n) { clearTimeout(t); t = setTimeout(cb, 150); } }); } catch {} };
  return { dir, file, read, write, watch };
}
