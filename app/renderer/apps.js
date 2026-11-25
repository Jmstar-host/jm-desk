/* 精灵旁边打开的应用页：搬运、提醒、升级、邮箱统计。汇总 / 待办 / 需求池并进了工作台，问知识并进了助手，收集并进了线索（1.3.0）。
 * 在 panel.js 之前加载；h / $ / ipcRenderer 由 panel.js 定义，只在函数里使用。 */
const SRC = { mail: '邮件', feishu_im: '飞书', feishu_meeting: '会议' };
const when = t => { if (!t) return ''; const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };
const call = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (!r.ok) throw new Error(r.error); return r.data; };
const errBox = e => h('div', { class: 'err' }, e.message || String(e));
const busyBtn = (label, cls, fn) => {
  const b = h('button', { class: cls }, label);
  b.onclick = async () => { b.disabled = true; const t = b.textContent; b.textContent = '处理中…'; try { await fn(); } finally { b.disabled = false; b.textContent = t; } };
  return b;
};
const empty = text => h('div', { class: 'card muted', style: 'text-align:center;padding:18px' }, text);

async function pageMailStats(body) {
  try {
    const m = await call('svc:mail-stats');
    if (!m.available) { body.append(empty('没有找到 Mailspring 的本地数据。装好 Mailspring 并登录邮箱后再看。')); return; }
    body.append(h('div', { class: 'card' }, h('h3', {}, `收件箱未读 ${m.total}`),
      h('div', { class: 'stats' }, ...[['今天', m.today], ['昨天', m.yesterday], ['本周更早', m.week], ['更早', m.older]].map(([n, v]) => h('div', {}, h('b', {}, String(v)), h('span', {}, n)))),
      h('div', { class: 'muted' }, `来自人的 ${m.human} · 系统通知 ${m.auto} · 带附件 ${m.attach}`)),
      h('div', { class: 'card' }, h('h3', {}, '谁发得最多'), ...m.top.map(t => h('div', { class: 'row' }, h('span', { style: 'flex:1' }, t.name), h('b', {}, String(t.count))))),
      h('div', { class: 'card' }, h('h3', {}, '最近的未读'), ...m.threads.filter(t => !t.auto).slice(0, 15).map(t => h('div', { class: 'li' }, h('div', { class: 'lt' }, t.subject), h('div', { class: 'meta' }, h('span', {}, t.from), h('span', {}, when(t.at)))))),
      h('div', { class: 'row' }, h('button', { class: 'pri', onclick: () => ipcRenderer.send('panel:action', 'mail.open') }, '打开邮箱'), h('button', { onclick: () => ipcRenderer.send('panel:action', 'app.work') }, '在工作台汇总')));
  } catch (e) { body.append(errBox(e)); }
}

/* 升级：状态由主进程推送（upd:state），这里原地更新，不重新排版 */
let updDraw = null;
require('electron').ipcRenderer.on('upd:state', (_e, v) => { if (updDraw && page === 'app.update') updDraw(v); }); // 本文件比 panel.js 先加载，这里不能用 panel.js 里的 ipcRenderer
async function pageUpdate(body) {
  const box = h('div');
  const mb = n => (n ? (n / 1048576).toFixed(1) + ' MB' : '');
  updDraw = v => {
    const i = v.info, st = v.status;
    const head = h('div', { class: 'card upd' }, h('div', { class: 'ver' }, h('span', { class: 'muted' }, '当前'), h('b', {}, v.current),
      i && !i.unsupported ? [h('span', { class: 'arrow' }, '→'), h('b', { class: 'new' }, i.version)] : null));
    const act = h('div', { class: 'row' });
    if (st === 'checking') head.append(h('div', { class: 'loading' }, h('i'), h('i'), h('i')));
    else if (st === 'nofeed') head.append(h('div', { class: 'muted' }, '还没有设置升级地址。'));
    else if (st === 'none' || st === 'idle') { head.append(h('div', { class: 'muted' }, st === 'none' ? '已经是最新版本 ✨' : '还没有检查过')); act.append(h('button', { onclick: () => ipcRenderer.invoke('upd:check') }, '检查更新')); }
    else if (st === 'unsupported') head.append(h('div', { class: 'muted' }, `新版本 ${i.version} 还没有提供这台电脑能用的安装包。`));
    else if (st === 'error') { head.append(h('div', { class: 'err' }, v.error)); act.append(h('button', { class: i ? 'pri' : '', onclick: () => ipcRenderer.invoke(i ? 'upd:install' : 'upd:check') }, i ? '重试' : '重新检查')); }
    else if (st === 'downloading' || st === 'ready') {
      const pct = Math.round((v.progress || 0) * 100);
      head.append(h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })), h('div', { class: 'muted' }, st === 'ready' ? '下载完成，校验通过，正在安装…' : `正在下载 ${pct}%${i.size ? ' · ' + mb(i.size) : ''}`));
    } else if (st === 'opened') head.append(h('div', { class: 'muted' }, '已打开安装包：把新版本拖进「应用程序」替换旧版本即可。'));
    if (st === 'available') {
      act.append(h('button', { class: 'pri', onclick: () => ipcRenderer.invoke('upd:install') }, i.mandatory ? '立即升级（必需）' : '立即升级'));
      if (!i.mandatory) act.append(h('button', { onclick: async () => { await ipcRenderer.invoke('upd:later'); ipcRenderer.send('panel:close'); } }, '明天再说'),
        h('button', { class: 'ghost', onclick: async () => { await ipcRenderer.invoke('upd:skip'); ipcRenderer.send('panel:close'); } }, '跳过这个版本'));
    }
    if (act.children.length) head.append(act);
    const cards = [head];
    if (i && !i.unsupported && i.notes.length) cards.push(h('div', { class: 'card' }, h('h3', {}, `${i.version} 更新了什么${i.date ? ' · ' + i.date : ''}`), ...i.notes.map(n => h('div', { class: 'li' }, n))));
    if (st === 'available') cards.push(h('div', { class: 'muted', style: 'padding:0 4px' }, `下载 ${mb(i.size) || '安装包'}，校验后自动替换并重开；数据都保留。`));
    box.replaceChildren(...cards);
  };
  updDraw(await ipcRenderer.invoke('upd:state'));
  body.append(box);
}

/* 员工提醒：订饭、吃饭、下班……时间、星期、订餐页面都可以自己设 */
async function pageReminders(body) {
  let R = await ipcRenderer.invoke('rem:state');
  const msg = h('div'), list = h('div');
  const WD = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [7, '日']];
  const meal = h('input', { value: R.mealUrl, placeholder: 'https://订餐页面地址', style: 'flex:1' });
  const save = async (quiet) => {
    try { R = { ...R, mealUrl: meal.value.trim(), ...(await call('rem:save', { enabled: R.enabled, notify: R.notify, mealUrl: meal.value.trim(), items: R.items })) }; if (!quiet) msg.replaceChildren(h('div', { class: 'ok' }, '已保存')); }
    catch (e) { msg.replaceChildren(errBox(e)); }
  };
  const draw = () => list.replaceChildren(...R.items.map((it, i) => {
    const row = h('div', { class: 'rem' + (it.enabled ? '' : ' off') },
      h('div', { class: 'rh' }, h('input', { type: 'checkbox', checked: it.enabled, title: '启用', onchange: e => { it.enabled = e.target.checked; row.classList.toggle('off', !it.enabled); save(true); } }),
        h('input', { value: it.label, class: 'rl', onchange: e => { it.label = e.target.value; save(true); } }),
        h('input', { type: 'time', value: it.time, class: 'rt', onchange: e => { it.time = e.target.value; save(true); } }),
        h('button', { class: 'ghost', title: '现在提醒一次看看', onclick: () => ipcRenderer.invoke('rem:test', it.id) }, '试一下'),
        h('button', { class: 'ghost', title: '删除', onclick: () => { R.items.splice(i, 1); save(true); draw(); } }, '×')),
      h('div', { class: 'wd' }, ...WD.map(([d, n]) => h('b', { class: it.days.includes(d) ? 'on' : '', onclick: e => { it.days = it.days.includes(d) ? it.days.filter(x => x !== d) : [...it.days, d].sort(); e.target.classList.toggle('on'); save(true); } }, n))),
      h('input', { value: it.message, placeholder: '提醒的话', class: 'rm', onchange: e => { it.message = e.target.value; save(true); } }),
      h('label', { class: 'rk' }, h('input', { type: 'checkbox', checked: it.openMeal, onchange: e => { it.openMeal = e.target.checked; save(true); } }), '点提醒打开订餐页面'));
    return row;
  }));
  draw();
  body.append(
    h('div', { class: 'card' }, h('h3', {}, '订餐页面'), h('div', { class: 'row' }, meal),
      h('div', { class: 'row' }, h('button', { class: 'pri', onclick: () => save() }, '保存'), h('button', { onclick: () => meal.value.trim() && ipcRenderer.invoke('svc:open-url', meal.value.trim()) }, '打开看看')), msg),
    h('div', { class: 'card' }, h('h3', {}, '提醒'),
      h('div', { class: 'row' }, h('input', { type: 'checkbox', checked: R.enabled, onchange: e => { R.enabled = e.target.checked; save(true); } }), h('span', {}, '开启提醒'),
        h('input', { type: 'checkbox', checked: R.notify, onchange: e => { R.notify = e.target.checked; save(true); } }), h('span', {}, '同时发系统通知')),
      list,
      h('div', { class: 'row' }, h('button', { onclick: () => { R.items.push({ id: 'r' + Date.now().toString(36).slice(-5), label: '提醒', time: '15:00', days: [1, 2, 3, 4, 5], message: '', openMeal: false, enabled: true }); save(true); draw(); } }, '＋ 加一条')),
      h('div', { class: 'muted' }, '到点精灵冒气泡；电脑睡着错过的，30 分钟内醒来会补提醒。')));
}

/* 串门：和同事的桌面加好友；让精灵去对方桌面找资料，再搬回来 */
let peerRedraw = null;
require('electron').ipcRenderer.on('peer:update', () => peerRedraw && peerRedraw());
async function pagePeers(body) {
  const box = h('div'); body.append(box);
  const inv = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (r && r.ok === false) throw new Error(r.error); return r && 'data' in r ? r.data : r; };
  const msg = h('div');
  const ST = { going: '飞过去了…', arrived: '到了，等对方开门', searching: '正在对方那里找', done: '回来了' };
  let askDraft = '', pick = null, pickSec = null, pickItem = '', asked = new Set();
  async function draw() {
    const S = await ipcRenderer.invoke('peer:state');
    const cards = [];
    if (!S.relay) {
      const r = h('input', { value: S.relaySetting, placeholder: 'https://你的中转地址', style: 'flex:1' });
      cards.push(h('div', { class: 'card' }, h('h3', {}, '先设置中转'), h('div', { class: 'muted' }, '两台桌面通过中转互通，内容端到端加密。'), h('div', { class: 'row' }, r),
        h('div', { class: 'row' }, h('button', { class: 'pri', onclick: async () => { try { await inv('peer:config', { relay: r.value }); draw(); } catch (e) { msg.replaceChildren(errBox(e)); } } }, '保存')), msg));
      return box.replaceChildren(...cards);
    }
    // 出门中 / 来访中
    for (const t of S.trips) cards.push(h('div', { class: 'card trip' }, h('h3', {}, `${t.status === 'done' ? '🏠' : '🛸'} 去 ${t.peer} 那里`), t.scope ? h('div', { class: 'muted' }, '范围：' + t.scope) : null, h('div', {}, t.ask),
      h('div', { class: 'muted' }, t.status === 'done' ? (t.result?.status === 'ok' ? '搬回来了，结果在下面' : '空手回来：' + (t.result?.note || '')) : ST[t.status] || t.status)));
    for (const g of S.guests) cards.push(h('div', { class: 'card trip' }, h('h3', {}, `👋 ${g.peer} 的精灵来了`), h('div', { class: 'muted' }, g.scope ? '想搬的范围：' + g.scope : '没有指定范围（对方是旧版本），会在你开放的全部范围里找'), h('div', {}, g.ask),
      g.status === 'arrived' ? h('div', { class: 'row' }, h('button', { class: 'pri', onclick: () => inv('peer:decide', g.id, true) }, '帮它找'), h('button', { onclick: () => inv('peer:decide', g.id, false) }, '请它回去')) : h('div', { class: 'muted' }, '正在帮它找…')));
    // 去搬运：总是在最前面；还没好友时也显示，引导先加好友
    {
      const has = S.peers.length > 0, goMsg = h('div');
      pick = S.peers.some(p => p.id === pick) ? pick : S.peers[0]?.id || null;
      const sel = h('select', { disabled: !has, onchange: e => { pick = e.target.value; pickSec = null; pickItem = ''; draw(); } }, ...(has ? S.peers.map(p => h('option', { value: p.id, selected: p.id === pick }, p.name)) : [h('option', {}, '还没有好友')]));
      // 先选搬哪一块：目录由对方的 JM Desk 自动给（加好友后、打开这一页时各要一次），只有名字没有内容
      const peer = S.peers.find(p => p.id === pick), secs = peer?.catalog?.sections || [];
      if (peer && !asked.has(peer.id)) { asked.add(peer.id); inv('peer:catalog', peer.id).catch(() => {}); }
      const sec = secs.find(x => x.id === pickSec) || secs[0] || null; pickSec = sec?.id || null;
      if (sec && pickItem && !sec.items.some(i => i.id === pickItem)) pickItem = '';
      const KIND = { knowledge: '知识库', requirements: '需求池', todos: '待办' };
      const secSel = h('select', { style: 'flex:1;min-width:0', onchange: e => { pickSec = e.target.value; pickItem = ''; draw(); } }, ...secs.map(x => h('option', { value: x.id, selected: x.id === pickSec }, `${KIND[x.kind] === x.name ? '' : (KIND[x.kind] || '') + ' · '}${x.name}`)));
      const itemSel = sec?.items.length ? h('select', { style: 'flex:1;min-width:0', onchange: e => { pickItem = e.target.value; } }, h('option', { value: '' }, sec.kind === 'knowledge' ? '整个知识库' : '全部'), ...sec.items.map(i => h('option', { value: i.id, selected: i.id === pickItem }, i.label + (i.note ? `（${i.note}）` : '')))) : null;
      const ta = h('textarea', { rows: 3, placeholder: sec ? `要从「${sec.name}」里搬什么内容？写具体些，例如：绑定失败的排查步骤` : '要搬什么？例如：eIM 绑定失败的排查资料', oninput: e => { askDraft = e.target.value; } }); ta.value = askDraft;
      const busy = S.trips.some(t => t.status !== 'done');
      const scopeRows = !peer ? [] : secs.length ? [h('div', { class: 'row' }, h('span', { class: 'muted' }, '搬哪块'), secSel), itemSel ? h('div', { class: 'row' }, h('span', { class: 'muted' }, '范围'), itemSel) : null]
        : peer.catalog ? [h('div', { class: 'muted' }, '对方现在没有开放可以搬的内容。'), h('div', { class: 'row' }, h('button', { onclick: () => inv('peer:catalog', peer.id, true).catch(() => {}) }, '刷新目录'))]
        : [h('div', { class: 'muted' }, '还没拿到对方的目录：对方不在线，或者版本低于 1.2.0。拿到之前只能让对方在全部开放范围里找，比较慢。'), h('div', { class: 'row' }, h('button', { onclick: async () => { try { await inv('peer:catalog', peer.id, true); goMsg.replaceChildren(h('div', { class: 'muted' }, '已经去要了，对方在线的话几秒钟就到')); } catch (e) { goMsg.replaceChildren(errBox(e)); } } }, '再要一次目录'))];
      cards.unshift(h('div', { class: 'card go' }, h('h3', {}, '去好友那里搬'),
        h('div', { class: 'row' }, h('span', { class: 'muted' }, '找谁'), sel), ...scopeRows, ta,
        h('div', { class: 'row' }, h('button', { class: 'pri', disabled: !has || busy || (peer?.catalog && !secs.length), onclick: async () => { try { await inv('peer:visit', pick, ta.value, sec ? { section: sec.id, item: pickItem || null } : null); askDraft = ''; goMsg.replaceChildren(); draw(); } catch (e) { goMsg.replaceChildren(errBox(e)); } } }, busy ? '精灵出门中…' : '出发'),
          h('span', { class: 'muted' }, !has ? '先在下面「加好友」' : sec ? '精灵飞到对方桌面，对方同意后只在这个范围里找' : '好友同意后，精灵在他开放的范围里找')), goMsg));
    }
    // 好友
    cards.push(h('div', { class: 'card' }, h('h3', {}, `我的好友 ${S.peers.length}`),
      ...(S.peers.length ? S.peers.map(p => h('div', { class: 'row peer' }, h('b', {}, p.name), h('span', { class: 'muted', title: '加好友时核对过的暗号' }, p.fp.join(' · ')),
        h('select', { style: 'margin-left:auto', title: '好友等级：普通好友只能搬你开放的需求池、待办；知识好友还能问你接入的知识库', onchange: e => inv('peer:set', p.id, { tier: e.target.value }) },
          ...Object.entries(S.tiers || {}).map(([k, n]) => h('option', { value: k, selected: (p.tier === 'basic' ? 'basic' : 'knowledge') === k }, n))),
        h('select', { title: '它的精灵来串门时', onchange: e => inv('peer:set', p.id, { trust: e.target.value }) }, h('option', { value: 'ask', selected: p.trust !== 'trust' }, '每次问我'), h('option', { value: 'trust', selected: p.trust === 'trust' }, '完全信任')),
        h('button', { class: 'ghost', onclick: async e => { if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = '确认解除'; return; } await inv('peer:remove', p.id); draw(); } }, '解除'),
        h('div', { class: 'folders' }, h('span', { class: 'muted' }, '开放的文件夹'),
          ...(p.folders || []).map(f => h('span', { class: 'chip', title: f.path + '\n好友只能在里面按词找，拿到文件名和命中的几句，拿不到整份文件' }, '📁 ' + f.label, h('i', { class: 'x', title: '不再开放', onclick: async () => { await inv('peer:folder-remove', p.id, f.id); draw(); } }, '×'))),
          h('button', { class: 'sm', title: '选一个只给这个好友看的文件夹', onclick: async ev => { try { await inv('peer:folder-add', p.id); draw(); } catch (err) { ev.target.after(h('span', { class: 'err' }, err.message)); } } }, '＋ 文件夹'))))
      : [h('div', { class: 'muted' }, '还没有好友：用下面的好友码和同事加好友。')])));
    // 加好友
    const P = S.pending, pair = h('div', { class: 'card' }, h('h3', {}, '加好友'));
    if (P?.peer) pair.append(h('div', {}, `对方：${P.peer.name}`), h('div', { class: 'muted' }, '和对方核对暗号，两边一样才点确认：'), h('div', { class: 'fp' }, ...P.fp.map(w => h('span', {}, w))),
      h('div', { class: 'row' }, h('button', { class: 'pri', onclick: () => inv('peer:confirm').then(draw) }, '暗号一致，加好友'), h('button', { onclick: () => inv('peer:cancel').then(draw) }, '不一致，取消')));
    else if (P?.role === 'offer') pair.append(h('div', { class: 'muted' }, '把好友码告诉同事，让他在「串门 › 加好友」里输入：'), h('div', { class: 'code' }, P.code.slice(0, 3) + ' ' + P.code.slice(3)),
      h('div', { class: 'muted' }, `10 分钟内有效 · 等对方输入…`), h('div', { class: 'row' }, h('button', { onclick: () => inv('peer:cancel').then(draw) }, '取消')));
    else {
      const code = h('input', { placeholder: '输入同事给的 6 位好友码', style: 'flex:1', inputmode: 'numeric' });
      pair.append(h('div', { class: 'row' }, h('button', { class: 'pri', onclick: async () => { try { await inv('peer:offer'); draw(); } catch (e) { msg.replaceChildren(errBox(e)); } } }, '生成好友码')),
        h('div', { class: 'row' }, code, h('button', { onclick: async () => { try { await inv('peer:claim', code.value); draw(); } catch (e) { msg.replaceChildren(errBox(e)); } } }, '加入')), msg);
    }
    cards.push(pair);
    { const go = cards.findIndex(c => c.classList?.contains('go')); if (go > 0) cards.unshift(cards.splice(go, 1)[0]); }
    // 开放给好友的范围
    const share = { ...S.share };
    const mine = h('div');
    cards.push(h('div', { class: 'card' }, h('h3', {}, '开放给好友'), h('div', { class: 'muted' }, '好友的精灵只能在这里找；邮件和聊天原文永远不开放。勾选的内容会自动生成一份目录（只有名字）发给好友，好友搬运前从里面选范围。'),
      ...Object.entries(S.scopes).map(([k, label]) => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!share[k], onchange: e => { share[k] = e.target.checked; inv('peer:config', { share }); } }), label)),
      h('div', { class: 'row' }, h('button', { onclick: async () => { try { const c = await inv('peer:my-catalog'); mine.replaceChildren(...(c.length ? c.map(x => h('div', { class: 'muted' }, `${x.name}：${x.items.length ? x.items.slice(0, 12).map(i => i.label).join('、') + (x.items.length > 12 ? ` 等 ${x.items.length} 项` : '') : '整体作为一个范围'}`)) : [h('div', { class: 'muted' }, '现在没有开放任何内容')])); } catch (e) { mine.replaceChildren(errBox(e)); } } }, '看看好友能看到的目录')), mine,
      h('div', { class: 'row' }, h('span', { class: 'muted' }, '我的名字'), h('input', { value: S.me.name, style: 'flex:1', onchange: e => inv('peer:config', { name: e.target.value }) }))));
    // 记录
    if (S.history.length) cards.push(h('div', { class: 'card' }, h('h3', {}, '串门记录'),
      ...S.history.slice(0, 10).map(x => h('div', { class: 'li' }, h('div', { class: 'lt' }, h('span', { class: 'tag' + (x.status === 'ok' ? ' ok' : ' warn') }, x.dir === 'out' ? `去 ${x.peer}` : `${x.peer} 来访`), h('span', { class: 'st', title: x.scope ? '范围：' + x.scope : '' }, (x.scope ? `【${x.scope}】` : '') + x.ask)),
        x.answer ? h('details', { open: x === S.history[0] && x.dir === 'out' }, h('summary', { class: 'muted' }, x.dir === 'out' ? '搬回来的内容' : '给它的内容'), h('div', { class: 'ans' }, x.answer)) : h('div', { class: 'muted' }, x.note || ({ denied: '没让它找', empty: '没找到', timeout: '对方不在' }[x.status] || ''))))));
    box.replaceChildren(...cards);
  }
  peerRedraw = draw; await draw();
}

const APPS = {
  'app.peers': ['搬运', pagePeers],
  'app.reminders': ['提醒', pageReminders],
  'app.update': ['升级', pageUpdate],
  'mail.stats': ['邮箱未读', pageMailStats],
};
