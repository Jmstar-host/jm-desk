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
 * 可选：DL_DIR=<目录> [DL_KEY=<口令>] 时，GET /dl/[<口令>/] 是安装包下载页（只读，只列 .dmg/.exe/.zip）。 */
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
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function createRelay({ now = () => Date.now(), dlDir = null, dlKey = '' } = {}) {
  function download(req, res, send) {
    let rest;
    try { rest = decodeURIComponent(req.url.split('?')[0].slice(3)); } catch { return send(404, { error: 'not_found' }); }
    if (dlKey) { if (!rest.startsWith('/' + dlKey + '/') && rest !== '/' + dlKey) return send(404, { error: 'not_found' }); rest = rest.slice(dlKey.length + 1); }
    const name = rest.replace(/^\/+/, '');
    if (!name) { // 下载页
      const base = dlKey ? `${encodeURIComponent(dlKey)}/` : '';
      const rows = listDl(dlDir).map(f => { const mb = (fs.statSync(path.join(dlDir, f)).size / 1048576).toFixed(1); return `<li><a href="${base}${encodeURIComponent(f)}">${esc(f)}</a> <small>${mb} MB</small></li>`; }).join('');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>JM Desk 下载</title><style>body{font:15px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#2e1f40}a{color:#7c3aed}li{margin:10px 0}small{color:#888}</style><h2>JM Desk 下载</h2><ul>${rows || '<li>暂无文件</li>'}</ul><p><small>Mac 选 .dmg（第一次打开要右键 → 打开），Windows 选 .exe；.zip 是完整包（含两个安装包和说明）。</small></p>`);
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
  createRelay({ dlDir: process.env.DL_DIR || null, dlKey: process.env.DL_KEY || '' }).listen(port, host, () => console.log(`jm-desk relay on http://${host}:${port}`));
}
