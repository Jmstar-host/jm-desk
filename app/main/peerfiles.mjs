/* 搬运：给某个好友开放的本机文件夹（1.4.2）。好友的精灵只能在这个文件夹里按词找，回的是「文件名 + 命中的几句」，不发整份文件。
 * 规矩：只读；只看文本类文件；跳过隐藏文件、符号链接、node_modules 之类；不能开放主目录、磁盘根、系统目录；文件和文件夹数量、大小都有上限。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { matchRows } from './peers.mjs';

export const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.log', '.ini', '.toml',
  '.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.py', '.java', '.go', '.rs', '.sql', '.sh', '.css', '.properties', '.conf']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
const LIMIT = { files: 3000, depth: 6, size: 512 * 1024, hits: 12, snippet: 160 };

export function badDir(dir) {
  const d = path.resolve(dir), home = process.env.HOME || '';
  return d === path.parse(d).root || d === home || (home && home.startsWith(d + path.sep)) || d.split(path.sep).filter(Boolean).length < 2
    || /^\/(System|usr|bin|sbin|etc|var|private|Library|Applications|Volumes\/[^/]+)$/.test(d) || /^\/(System|usr|bin|sbin|etc|Library)(\/|$)/.test(d)
    || /^[A-Za-z]:\\(Windows|Program Files)/i.test(d);
}
/** 新开放一个文件夹：检查能不能开放，返回 { id, path, label } */
export function folderEntry(dir) {
  const real = fs.realpathSync(dir);
  if (!fs.statSync(real).isDirectory()) throw new Error('只能开放文件夹');
  if (badDir(real)) throw new Error('不能开放主目录、磁盘根目录或系统目录：选一个专门放给好友看的文件夹');
  return { id: crypto.createHash('sha256').update(real).digest('hex').slice(0, 10), path: real, label: path.basename(real).slice(0, 30) };
}

/** 列出文件夹里能搜的文本文件（相对路径）。不跟随符号链接、不出文件夹 */
export function listFiles(root) {
  const base = fs.realpathSync(root), out = [];
  const walk = (dir, depth) => {
    if (depth > LIMIT.depth || out.length >= LIMIT.files) return;
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= LIMIT.files) return;
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(f, depth + 1); continue; }
      if (!e.isFile() || !TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
      out.push(path.relative(base, f));
    }
  };
  walk(base, 0);
  return out;
}
const read = (base, rel) => {
  const f = path.join(base, rel), real = fs.realpathSync(f);
  if (!real.startsWith(base + path.sep)) return ''; // 防止绕出文件夹
  const st = fs.statSync(real); if (st.size > LIMIT.size) return fs.readFileSync(real, 'utf8').slice(0, LIMIT.size);
  return fs.readFileSync(real, 'utf8');
};
/** 在文件夹里按词找：文件名和内容都算；返回 [{ file, snippet }]，最多 12 个 */
export function searchFolder(root, ask) {
  const base = fs.realpathSync(root), rows = [];
  for (const rel of listFiles(base)) { let text = ''; try { text = read(base, rel); } catch {} rows.push({ title: rel, text }); }
  const hits = matchRows(rows, ask, r => r.title + '\n' + r.text).slice(0, LIMIT.hits);
  const terms = [...new Set([...(String(ask).toLowerCase().match(/[a-z0-9]{2,}/g) || []), ...(String(ask).match(/[\u4e00-\u9fff]{2,}/g) || []).flatMap(w => w.length > 2 ? w.match(/.{2}/g) : [w])])];
  return hits.map(r => {
    const low = r.text.toLowerCase(), at = Math.max(0, Math.min(...terms.map(t => { const i = low.indexOf(t); return i < 0 ? Infinity : i; }).concat(Infinity)));
    const snippet = Number.isFinite(at) ? r.text.slice(Math.max(0, at - 40), at + LIMIT.snippet - 40).replace(/\s+/g, ' ').trim() : '';
    return { file: r.title, snippet };
  });
}
