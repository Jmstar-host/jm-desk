/* 串门调度（主进程）：伙伴名单、结伴、收信循环、出门 / 接待访客。界面和动画由 main.mjs 注入的回调完成。
 * 数据：DATA/peers.json（伙伴名单，无密钥）、DATA/peer-trips.json（最近串门记录）；身份密钥由 getIdentity/setIdentity 加密保存。 */
import crypto from 'node:crypto';
import * as P from './peers.mjs';

export const TRIP_TIMEOUT = 4 * 60e3, ASK_TIMEOUT = 3 * 60e3;
const rid = () => crypto.randomBytes(6).toString('hex');
const clip = (s, n) => String(s ?? '').slice(0, n);

export function createPeerHub(d) {
  /* d: { store, settings(), saveSettings(fn), relay(), getIdentity(), setIdentity(v), myName(), myLook(),
   *      fetchImpl, onUpdate(), sprite(msg), visitor: { open(v), send(id, msg), close(id) }, search(visit) → { answer, used }, say(title, sub, action) } */
  let client = null, clientFor = null, loop = null, pending = null, stopped = false;
  const trips = new Map();   // 我出门：id → { peer, ask, status, at, timer }
  const guests = new Map();  // 来我这：id → { peer, ask, look, status, timer }

  const peers = () => d.store.read('peers.json', []);
  const savePeers = v => d.store.write('peers.json', v);
  const history = () => d.store.read('peer-trips.json', []);
  const log = e => { const h = history(); h.unshift({ at: new Date().toISOString(), ...e }); d.store.write('peer-trips.json', h.slice(0, 50)); };
  function me() { let id = d.getIdentity(); if (!id?.pub) { id = P.newIdentity(); d.setIdentity(id); } return id; }
  function cli() {
    const r = d.relay(); if (!r) throw new Error('还没有中转地址：在「串门」页填一次（公司版已预置）');
    if (!client || clientFor !== r) { client = P.createClient({ relay: r, fetchImpl: d.fetchImpl }); clientFor = r; }
    return client;
  }
  const peerById = id => peers().find(p => p.id === id && p.status === 'paired');
  const send = (peer, obj) => cli().send(me(), peer, obj);

  /* ---------- 结伴 ---------- */
  async function offer() {
    const r = await cli().offer(me(), d.myName());
    pending = { role: 'offer', code: r.code, expires: Date.now() + r.expires_in * 1000 }; ensureLoop(); d.onUpdate(); return state();
  }
  async function claim(code) {
    const r = await cli().claim(me(), d.myName(), code);
    pending = { role: 'claim', peer: { box: r.box, pub: r.pub, name: clip(r.name, 30) || '伙伴' } };
    pending.fp = P.fingerprint(me().pub, r.pub); ensureLoop(); d.onUpdate(); return state();
  }
  async function confirm() {
    if (!pending?.peer) throw new Error('还没有等到对方');
    const p = pending.peer, list = peers().filter(x => x.box !== p.box);
    const peer = { id: p.box.slice(0, 12), box: p.box, pub: p.pub, name: p.name, status: 'paired', trust: 'ask', fp: P.fingerprint(me().pub, p.pub), since: new Date().toISOString() };
    list.push(peer); savePeers(list); pending = null;
    await send(peer, { type: 'hello', name: d.myName(), look: d.myLook() }).catch(() => {});
    d.onUpdate(); return state();
  }
  function cancelPair() { pending = null; d.onUpdate(); return state(); }
  function setPeer(id, patch) {
    const list = peers(), p = list.find(x => x.id === id); if (!p) throw new Error('没有这个伙伴');
    if (patch.trust) p.trust = patch.trust === 'trust' ? 'trust' : 'ask';
    if (patch.name) p.alias = clip(patch.name, 20);
    savePeers(list); d.onUpdate(); return state();
  }
  async function removePeer(id) {
    const p = peers().find(x => x.id === id); if (!p) return state();
    await send(p, { type: 'bye' }).catch(() => {});
    savePeers(peers().filter(x => x.id !== id)); d.onUpdate(); return state();
  }

  /* ---------- 我出门 ---------- */
  async function visit(peerId, ask) {
    const peer = peerById(peerId); if (!peer) throw new Error('先和对方结伴');
    const q = clip(String(ask || '').trim(), 400); if (!q) throw new Error('说说要去找什么');
    if ([...trips.values()].some(t => t.status !== 'done')) throw new Error('精灵已经出门了，等它回来再去');
    const id = rid();
    await send(peer, { type: 'visit', id, ask: q, name: d.myName(), look: d.myLook() });
    const t = { id, peer, ask: q, status: 'going', at: Date.now() };
    t.timer = setTimeout(() => finishTrip(id, { status: 'timeout', note: `${name(peer)} 好像不在桌面前，没开门` }), TRIP_TIMEOUT);
    trips.set(id, t); ensureLoop();
    d.sprite({ type: 'trip', phase: 'leave', to: name(peer) });
    d.onUpdate(); return { id };
  }
  function finishTrip(id, r) {
    const t = trips.get(id); if (!t || t.status === 'done') return;
    clearTimeout(t.timer); t.status = 'done'; t.result = r;
    log({ dir: 'out', peer: name(t.peer), ask: t.ask, status: r.status, answer: r.answer || '', note: r.note || '', used: r.used || [] });
    const got = r.status === 'ok';
    d.sprite({ type: 'trip', phase: 'return', carry: got });
    setTimeout(() => d.say(got ? `🎁 从 ${name(t.peer)} 那里搬回来了` : `🙈 空手回来了`, got ? clip(t.ask, 30) : r.note || '', { id: 'app.peers' }), 2600);
    setTimeout(() => trips.delete(id), 60e3);
    d.onUpdate();
  }

  /* ---------- 来我这 ---------- */
  async function onVisit(peer, m) {
    const id = clip(m.id, 20); if (!id || guests.has(id)) return;
    if ([...guests.values()].some(g => g.status !== 'gone')) return send(peer, { type: 'visit-denied', id, reason: '正在接待别的精灵，等一会儿再来' }).catch(() => {});
    const g = { id, peer, ask: clip(m.ask, 400), look: m.look || {}, from: clip(m.name, 30) || name(peer), status: 'arrived' };
    guests.set(id, g);
    send(peer, { type: 'visit-ack', id, status: 'arrived' }).catch(() => {});
    d.visitor.open({ id, name: name(peer), ask: g.ask, look: g.look, trusted: peer.trust === 'trust' });
    if (peer.trust === 'trust') setTimeout(() => decide(id, true), 2600);
    else g.timer = setTimeout(() => decide(id, false, '主人不在桌面前'), ASK_TIMEOUT);
    d.onUpdate();
  }
  async function decide(id, ok, reason = '主人这次没空，下次再来') {
    const g = guests.get(id); if (!g || g.status !== 'arrived') return;
    clearTimeout(g.timer);
    if (!ok) {
      g.status = 'gone'; d.visitor.send(id, { type: 'leave', carry: false });
      await send(g.peer, { type: 'visit-denied', id, reason }).catch(() => {});
      log({ dir: 'in', peer: name(g.peer), ask: g.ask, status: 'denied', note: reason }); return d.onUpdate();
    }
    g.status = 'searching'; d.visitor.send(id, { type: 'search' });
    send(g.peer, { type: 'visit-ack', id, status: 'searching' }).catch(() => {});
    let r;
    try { r = await d.search({ ask: g.ask, peer: name(g.peer), share: d.settings().peers?.share || { knowledge: true } }); }
    catch (e) { r = { error: e.message }; }
    g.status = 'gone';
    if (r?.answer) {
      d.visitor.send(id, { type: 'leave', carry: true });
      await send(g.peer, { type: 'visit-result', id, answer: clip(r.answer, 6000), used: (r.used || []).slice(0, 10).map(String) }).catch(() => {});
      log({ dir: 'in', peer: name(g.peer), ask: g.ask, status: 'ok', answer: clip(r.answer, 2000) });
    } else {
      d.visitor.send(id, { type: 'leave', carry: false });
      await send(g.peer, { type: 'visit-denied', id, reason: r?.error ? `这边没找成：${clip(r.error, 80)}` : '这边没找到相关的东西' }).catch(() => {});
      log({ dir: 'in', peer: name(g.peer), ask: g.ask, status: 'empty', note: r?.error || '' });
    }
    d.onUpdate();
  }

  /* ---------- 收信循环 ---------- */
  function handle(items) {
    for (const it of items) {
      if (it.kind === 'pair-claimed') {
        if (pending?.role === 'offer' && !pending.peer) { pending.peer = { box: it.from, pub: it.pub, name: it.name || '伙伴' }; pending.fp = P.fingerprint(me().pub, it.pub); d.onUpdate(); }
        continue;
      }
      const { peer, msg: m } = it;
      if (m.type === 'hello') { const list = peers(), p = list.find(x => x.box === peer.box); if (p) { p.name = clip(m.name, 30) || p.name; savePeers(list); d.onUpdate(); } }
      else if (m.type === 'bye') { savePeers(peers().filter(x => x.box !== peer.box)); d.onUpdate(); }
      else if (m.type === 'visit' && peer.status === 'paired') onVisit(peer, m);
      else if (m.type === 'visit-ack') { const t = trips.get(m.id); if (t && t.status !== 'done') { t.status = m.status === 'searching' ? 'searching' : 'arrived'; d.onUpdate(); } }
      else if (m.type === 'visit-result') finishTrip(m.id, { status: 'ok', answer: clip(m.answer, 6000), used: m.used });
      else if (m.type === 'visit-denied') finishTrip(m.id, { status: 'denied', note: clip(m.reason, 80) });
    }
  }
  const needLoop = () => !!d.relay() && (peers().length > 0 || !!pending);
  function ensureLoop() {
    if (loop || stopped || !needLoop()) return;
    loop = (async () => {
      let backoff = 0;
      while (!stopped && needLoop()) {
        try { const r = await cli().poll(me(), 20); backoff = 0; handle(P.unpack(me(), r.messages, peers(), pending?.peer ? [pending.peer] : pending ? [{ box: '' }] : [])); }
        catch { backoff = Math.min(60e3, (backoff || 2e3) * 2); await new Promise(res => setTimeout(res, backoff)); }
      }
      loop = null;
    })();
  }

  const name = p => p.alias || p.name || '伙伴';
  function state() {
    return {
      relay: d.relay(), me: { name: d.myName(), ready: !!d.getIdentity()?.pub }, share: d.settings().peers?.share || { knowledge: true },
      peers: peers().map(p => ({ id: p.id, name: name(p), fp: p.fp, trust: p.trust, since: p.since })),
      pending: pending ? { role: pending.role, code: pending.code, expires: pending.expires, peer: pending.peer ? { name: pending.peer.name } : null, fp: pending.fp || null } : null,
      trips: [...trips.values()].map(t => ({ id: t.id, peer: name(t.peer), ask: t.ask, status: t.status, result: t.result || null })),
      guests: [...guests.values()].filter(g => g.status !== 'gone').map(g => ({ id: g.id, peer: name(g.peer), ask: g.ask, status: g.status })),
      history: history().slice(0, 20),
    };
  }
  return { state, offer, claim, confirm, cancelPair, setPeer, removePeer, visit, decide, ensureLoop, stop() { stopped = true; }, _handle: handle };
}
