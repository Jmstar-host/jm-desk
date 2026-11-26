/* JM Desk 串门中转：只转发端到端加密的消息，看不到内容，不落盘，重启即清空。
 *   node relay/server.mjs            # 默认监听 127.0.0.1:8787；PORT / HOST 环境变量可改
 * 部署到公网时放在 https 反向代理后面；JM Desk 只接受 https（本机 127.0.0.1 / localhost 除外）。
 *
 * 接口（全部 JSON）：
 *   POST /v1/pair/offer  { pub, name, box }            → { code, expires_in }   结伴码 6 位数字，10 分钟有效，用一次即失效
 *   POST /v1/pair/claim  { code, pub, name, box }       → { pub, name, box }     同时把认领方信息投进发起方的信箱
 *   POST /v1/send        { to, from, data }             → { ok }                 data 是密文（base64），不超过 256 KB
 *   POST /v1/poll        { key, wait }                  → { messages: [...] }    key 的 sha256 就是信箱号；最多等 wait 秒（≤25）
 * 信箱号 box = sha256(key)：只有持有 key 的一方能取信，别人只能往里投。
 * 可选：DL_DIR=<目录> [DL_KEY=<口令>] [DL_REPO=<开源仓库 https 地址>] 时，GET /dl/[<口令>/] 是安装包下载页
 * （只读，只列 .dmg/.exe/.zip；按「安装包 / 源码（*-source.zip）/ 完整包」分区显示）。
 * 同一个目录里放了 latest.json（scripts/release.mjs 生成）时，GET /dl/[<口令>/]latest.json 就是应用内升级的地址：
 * 已安装的 JM Desk 定时来读它，发现新版本就提示、下载同目录的安装包并校验 sha256。下载页顶部也会显示当前版本和更新点。 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BODY = 300 * 1024, MAX_BOX = 50, MSG_TTL = 60 * 60e3, CODE_TTL = 10 * 60e3;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const isBox = b => typeof b === 'string' && /^[0-9a-f]{64}$/.test(b);
const isPub = p => typeof p === 'string' && /^[A-Za-z0-9+/=_-]{20,200}$/.test(p);
const clip = (s, n) => String(s ?? '').slice(0, n);

/* 可选的下载页（给同事分发安装包）：设置 DL_DIR 才开启，只读这个目录里的 .dmg / .exe / .zip，不进子目录。
 * 设置 DL_KEY 时地址要带上它：/dl/<DL_KEY>/，不知道的人打不开。 */
const DL_FILE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}\.(dmg|exe|zip)$/;
function listDl(dir) { try { return fs.readdirSync(dir).filter(f => DL_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort(); } catch { return []; } }
const FEED = 'latest.json';
const MOD_FILE = /^[a-z0-9][a-z0-9._-]{0,80}\.glb$/;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function createRelay({ now = () => Date.now(), dlDir = null, dlKey = '', dlRepo = '' } = {}) {
  function download(req, res, send) {
    let rest;
    try { rest = decodeURIComponent(req.url.split('?')[0].slice(3)); } catch { return send(404, { error: 'not_found' }); }
    if (dlKey) { if (!rest.startsWith('/' + dlKey + '/') && rest !== '/' + dlKey) return send(404, { error: 'not_found' }); rest = rest.slice(dlKey.length + 1); }
    const name = rest.replace(/^\/+/, '');
    if (name.startsWith('mods/')) { // MOD 库（1.8.4）：DL_DIR/mods/ 里的 index.json（形象清单）和 .glb 模型，只读、不进更深的目录
      const f = name.slice(5), file = path.join(dlDir, 'mods', f);
      if (f === 'index.json') { let body; try { body = fs.readFileSync(file); JSON.parse(body); } catch { return send(404, { error: 'not_found' }); }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); return res.end(req.method === 'HEAD' ? undefined : body); }
      let st; try { st = MOD_FILE.test(f) && fs.lstatSync(file); } catch {} if (!st || !st.isFile()) return send(404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
    if (name === FEED) { // 应用内升级读的版本文件：原样返回，不缓存
      let body; try { body = fs.readFileSync(path.join(dlDir, FEED)); JSON.parse(body); } catch { return send(404, { error: 'not_found' }); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (!name) { // 下载页
      const base = dlKey ? `${encodeURIComponent(dlKey)}/` : '';
      const files = listDl(dlDir), mb = f => (fs.statSync(path.join(dlDir, f)).size / 1048576).toFixed(1);
      const hint = f => /arm64\.dmg$/.test(f) ? 'Mac · Apple 芯片（M1–M4）' : /x64\.dmg$/.test(f) ? 'Mac · Intel 芯片' : /\.dmg$/.test(f) ? 'Mac' : /\.exe$/.test(f) ? 'Windows' : /source\.zip$/.test(f) ? '源码，MIT 协议，可以随意修改和再分发' : '完整包：全部安装包 + 说明 + 源码';
      const li = f => `<li><a href="${base}${encodeURIComponent(f)}">${esc(f)}</a> <small>${esc(hint(f))} · ${mb(f)} MB</small></li>`;
      const sec = (title, list, note = '') => list.length || note ? `<h3>${title}</h3><ul>${list.map(li).join('')}${note}</ul>` : '';
      const apps = files.filter(f => /\.(dmg|exe)$/.test(f)), src = files.filter(f => /source\.zip$/.test(f)), full = files.filter(f => /\.zip$/.test(f) && !src.includes(f));
      let latest = ''; // 当前版本和更新点（来自 latest.json，没有就不显示）
      try { const j = JSON.parse(fs.readFileSync(path.join(dlDir, FEED), 'utf8')); if (j?.version) latest = `<p><b>当前版本 ${esc(clip(j.version, 20))}</b>${j.date ? ` <small>${esc(clip(j.date, 20))}</small>` : ''}</p>${Array.isArray(j.notes) && j.notes.length ? `<ul>${j.notes.slice(0, 10).map(n => `<li><small>${esc(clip(n, 200))}</small></li>`).join('')}</ul>` : ''}`; } catch {}
      const repo = /^https:\/\/[^\s"<>]+$/.test(dlRepo) ? `<li><a href="${esc(dlRepo)}">${esc(dlRepo)}</a> <small>开源仓库（MIT）</small></li>` : '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>JM Desk 下载</title><style>body{font:15px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:600px;margin:48px auto;padding:0 16px;color:#2e1f40}a{color:#7c3aed}li{margin:10px 0}small{color:#888}h3{margin:28px 0 4px;font-size:15px}</style><h2>JM Desk 下载</h2>${latest}${sec('安装包', apps)}${sec('源码（开源）', src, repo)}${sec('完整包', full)}${files.length ? '' : '<p>暂无文件</p>'}<p><small>Mac 第一次打开要在「应用程序」里右键 → 打开（安装包没有签名）。不知道是哪种芯片：左上角苹果菜单 → 关于本机。</small></p>`);
    }
    if (!DL_FILE.test(name) || !listDl(dlDir).includes(name)) return send(404, { error: 'not_found' });
    const file = path.join(dlDir, name), st = fs.statSync(file);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
  const codes = new Map(), boxes = new Map(), waiters = new Map(), hits = new Map();
  const deliver = (box, msg) => {
    const q = boxes.get(box) || []; q.push({ ...msg, at: now() }); while (q.length > MAX_BOX) q.shift(); boxes.set(box, q);
    const w = waiters.get(box); if (w) { waiters.delete(box); w(); }
  };
  const take = box => { const q = (boxes.get(box) || []).filter(m => now() - m.at < MSG_TTL); boxes.delete(box); return q; };
  const limited = (ip, kind, max) => { // 每个来源 IP 每分钟的次数上限
    const k = ip + kind, t = now(), h = (hits.get(k) || []).filter(x => t - x < 60e3); h.push(t); hits.set(k, h); return h.length > max;
  };
  const sweep = setInterval(() => {
    const t = now();
    for (const [c, o] of codes) if (t - o.at > CODE_TTL) codes.delete(c);
    for (const [b, q] of boxes) { const k = q.filter(m => t - m.at < MSG_TTL); k.length ? boxes.set(b, k) : boxes.delete(b); }
    for (const [k, h] of hits) if (!h.some(x => t - x < 60e3)) hits.delete(k);
  }, 30e3); sweep.unref?.();

  async function handle(req, res) {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/v1/health') return send(200, { ok: true, service: 'jm-desk-relay' });
    if ((req.method === 'GET' || req.method === 'HEAD') && dlDir && req.url.startsWith('/dl')) return download(req, res, send);
    if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(413, { error: 'too_large' }); chunks.push(c); }
    let b; try { b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(400, { error: 'bad_json' }); }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    if (req.url === '/v1/pair/offer') {
      if (limited(ip, 'offer', 10)) return send(429, { error: 'rate_limited' });
      if (!isPub(b.pub) || !isBox(b.box)) return send(400, { error: 'bad_request' });
      let code; do { code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); } while (codes.has(code));
      codes.set(code, { pub: b.pub, name: clip(b.name, 30), box: b.box, at: now(), tries: 0 });
      return send(200, { code, expires_in: CODE_TTL / 1000 });
    }
    if (req.url === '/v1/pair/claim') {
      if (limited(ip, 'claim', 10)) return send(429, { error: 'rate_limited' });
      const o = codes.get(String(b.code || ''));
      if (!o || now() - o.at > CODE_TTL) return send(404, { error: 'code_not_found' });
      if (!isPub(b.pub) || !isBox(b.box) || b.box === o.box) return send(400, { error: 'bad_request' });
      codes.delete(String(b.code)); // 用一次即失效
      deliver(o.box, { from: b.box, type: 'pair-claimed', pub: b.pub, name: clip(b.name, 30) });
      return send(200, { pub: o.pub, name: o.name, box: o.box });
    }
    if (req.url === '/v1/send') {
      if (limited(ip, 'send', 120)) return send(429, { error: 'rate_limited' });
      if (!isBox(b.to) || !isBox(b.from) || typeof b.data !== 'string' || b.data.length > 256 * 1024) return send(400, { error: 'bad_request' });
      deliver(b.to, { from: b.from, type: 'sealed', data: b.data });
      return send(200, { ok: true });
    }
    if (req.url === '/v1/poll') {
      if (typeof b.key !== 'string' || b.key.length < 32) return send(400, { error: 'bad_request' });
      const box = sha(b.key), wait = Math.max(0, Math.min(25, Number(b.wait) || 0)) * 1000;
      if (!(boxes.get(box) || []).length && wait) {
        await new Promise(r => { const t = setTimeout(() => { if (waiters.get(box) === done) waiters.delete(box); r(); }, wait); const done = () => { clearTimeout(t); r(); }; waiters.get(box)?.(); waiters.set(box, done); req.on('close', done); });
      }
      return send(200, { messages: take(box) });
    }
    return send(404, { error: 'not_found' });
  }
  const server = http.createServer((req, res) => handle(req, res).catch(() => { try { res.writeHead(500).end(); } catch {} }));
  server.on('close', () => clearInterval(sweep));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1';
  createRelay({ dlDir: process.env.DL_DIR || null, dlKey: process.env.DL_KEY || '', dlRepo: process.env.DL_REPO || '' }).listen(port, host, () => console.log(`jm-desk relay on http://${host}:${port}`));
}
