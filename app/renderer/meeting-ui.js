/* 助手里的「会议纪要」：开始记录 → 实时字幕 → 结束 → 整段转写 → AI 整理（摘要 / 决策 / 待办 / 可能的需求）→ 进线索池。
 * 在 chat.js 之后加载，复用它的 h / $ / call / ipcRenderer。界面盖在对话区上面，关掉回到对话；录音中顶栏按钮显示红点和计时。 */
(() => {
  const M = { st: null, phase: 'idle', lines: [], startedAt: null, result: null, err: '', timer: 0, dl: null, open: false };
  const btn = h('button', { id: 'meetbtn', title: '用本机麦克风记录会议，结束后整理成纪要' }, h('i', { class: 'rec' }), h('span', {}, '会议纪要'));
  $('#integ').before(btn);
  const view = h('div', { id: 'meet', class: 'hide' }); $('#conv').append(view);
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const elapsed = () => M.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(M.startedAt)) / 1000)) : 0;
  function show(on) { M.open = on; view.classList.toggle('hide', !on); $('#conv').classList.toggle('meeting', on); if (on) refresh(); }
  btn.onclick = () => show(!M.open || M.phase === 'recording' ? true : false);
  async function refresh() { try { M.st = await call('meet:status'); if (M.st.open && !M.open) { M.open = true; view.classList.remove('hide'); $('#conv').classList.add('meeting'); }
    if (M.st.active && M.phase === 'idle') { M.phase = 'recording'; M.startedAt = M.st.active.startedAt; M.lines = M.st.active.lines.map(text => ({ text })); } M.dl = M.st.download; } catch (e) { M.err = e.message; } draw(); }
  function tick() { clearInterval(M.timer); if (M.phase === 'recording') M.timer = setInterval(() => { const t = view.querySelector('.clock'); if (t) t.textContent = fmt(elapsed()); btn.querySelector('span').textContent = fmt(elapsed()); }, 1000); else btn.querySelector('span').textContent = '会议纪要'; btn.classList.toggle('on', M.phase === 'recording'); }

  const MISS = { platform: '会议纪要目前只支持 macOS', whisper: '没装转写引擎 whisper.cpp', ffmpeg: '没装录音工具 ffmpeg', model: '还没有转写模型' };
  function setup() {
    const miss = M.st?.missing || [];
    const cmd = miss.some(k => k === 'whisper' || k === 'ffmpeg') ? h('div', { class: 'cmd' }, h('code', {}, M.st.install), h('button', { class: 'sm', onclick: e => { require('electron').clipboard.writeText(M.st.install); e.target.textContent = '已复制'; } }, '复制')) : null;
    const dl = M.dl, model = miss.includes('model') ? h('div', { class: 'cmd' },
      dl?.running ? h('div', { class: 'bar' }, h('i', { style: `width:${dl.total ? Math.round(dl.got / dl.total * 100) : 2}%` }), h('span', {}, `下载中 ${Math.round(dl.got / 1048576)} / ${Math.round((dl.total || 487e6) / 1048576)} MB`))
        : h('button', { class: 'pri', onclick: async () => { try { M.dl = await call('meet:download'); draw(); } catch (e) { M.err = e.message; draw(); } } }, '下载转写模型（约 480 MB）'),
      dl?.error ? h('div', { class: 'err' }, dl.error) : null) : null;
    return h('div', { class: 'mcard' }, h('h3', {}, '先准备一下'), h('p', { class: 'muted' }, '会议纪要用本机的 whisper 转写：免费、不限时长，音频只在本机，转完就删。'),
      h('ul', { class: 'miss' }, ...miss.map(k => h('li', {}, MISS[k] || k))), cmd ? h('p', { class: 'muted' }, '在「终端」里运行下面这条命令安装：') : null, cmd, model,
      h('div', { class: 'row' }, h('button', { onclick: refresh }, '装好了，再检查一次')));
  }
  function idle() {
    const topic = h('input', { placeholder: '会议主题（可不填，AI 会根据内容起名）', maxlength: 60 });
    const go = h('button', { class: 'pri big', onclick: async () => {
      go.disabled = true; M.err = '';
      try { const r = await call('meet:start', { topic: topic.value }); M.phase = 'recording'; M.startedAt = r.startedAt; M.lines = []; M.mic = r.mic; M.result = null; } catch (e) { M.err = e.message; }
      draw();
    } }, h('i', { class: 'rec' }), '开始记录');
    topic.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) go.click(); });
    return h('div', { class: 'mcard' }, h('div', { class: 'mic' }, h('div', { class: 'orb' })), h('h3', {}, '记录一场会议'),
      h('p', { class: 'muted' }, `开着就行：边开边出字幕，结束后整段再转一遍，AI 整理成摘要、决策、待办和可能的需求，放进「线索」（只在本机）。转写模型：${M.st?.model || '—'}`),
      topic, h('div', { class: 'row c' }, go), M.err ? h('div', { class: 'err' }, M.err) : null);
  }
  function recording() {
    const cap = h('div', { class: 'caps' }, ...(M.lines.length ? M.lines.slice(-80).map(l => h('p', {}, l.text)) : [h('p', { class: 'muted' }, '在听……开始说话后字幕会出现在这里（实时字幕只是参考，结束后会整段重新转写）')]));
    setTimeout(() => { cap.scrollTop = cap.scrollHeight; });
    return h('div', { class: 'mcard wide' }, h('div', { class: 'rechd' }, h('i', { class: 'rec live' }), h('b', { class: 'clock' }, fmt(elapsed())), h('span', { class: 'muted grow' }, M.mic ? `麦克风：${M.mic}` : ''),
      h('button', { class: 'ghost', onclick: async () => { if (!confirm2()) return; await call('meet:cancel').catch(() => null); M.phase = 'idle'; draw(); } }, '放弃'),
      h('button', { class: 'pri', onclick: stop }, '结束并整理')), cap, M.err ? h('div', { class: 'err' }, M.err) : null);
  }
  let armed = 0; const confirm2 = () => { if (Date.now() - armed < 3000) return true; armed = Date.now(); M.err = '再点一次「放弃」确认：这场会议不保存'; draw(); return false; };
  async function stop() { M.phase = 'transcribing'; M.err = ''; draw(); try { M.result = await call('meet:stop'); M.phase = 'done'; } catch (e) { M.err = e.message; M.phase = 'idle'; } draw(); }
  function working() {
    const steps = [['transcribing', '整段转写'], ['summarizing', 'AI 整理纪要']], i = steps.findIndex(s => s[0] === M.phase);
    return h('div', { class: 'mcard' }, h('h3', {}, '正在整理'), h('ol', { class: 'steps2' }, h('li', { class: 'ok' }, '录音已收好'),
      ...steps.map(([k, n], j) => h('li', { class: j < i ? 'ok' : j === i ? 'now' : '' }, n))), h('p', { class: 'muted' }, '一小时的会议，转写大约需要几分钟；可以先去干别的，整理好精灵会说一声。'));
  }
  function done() {
    const r = M.result || {}, m = r.minutes;
    const sec = (title, list, fn) => list?.length ? h('section', {}, h('h4', {}, title), h('ul', {}, ...list.map(fn))) : null;
    const toWork = h('button', { class: 'pri', onclick: async () => { toWork.disabled = true; toWork.textContent = '整理中…'; try { const s = await call('meet:to-work'); toWork.textContent = `已整理出 ${s.items?.length || 0} 件事，去工作台看`; toWork.disabled = false; toWork.onclick = () => ipcRenderer.send('work:open', null); } catch (e) { M.err = e.message; draw(); } } }, '整理进工作台');
    return h('div', { class: 'mcard wide' }, h('div', { class: 'rechd' }, h('b', { class: 'grow' }, r.title || '会议纪要'), h('span', { class: 'muted' }, `${fmt(r.durationSec || 0)} · ${r.chars || 0} 字`)),
      r.aiError ? h('div', { class: 'err' }, 'AI 整理没成功（逐字稿已保存）：' + r.aiError) : null,
      m?.summary ? h('p', { class: 'sum' }, m.summary) : null,
      sec('决策', m?.decisions, d => h('li', {}, d)),
      sec('待办', m?.todos, t => h('li', {}, t.text, t.who ? h('em', {}, t.who) : null, t.due ? h('em', {}, t.due) : null, t.quote ? h('q', {}, t.quote) : null)),
      sec('可能的需求', m?.requirements, q => h('li', {}, h('b', {}, q.title), q.detail ? h('span', {}, ' — ' + q.detail) : null, q.quote ? h('q', {}, q.quote) : null)),
      sec('还要确认', m?.questions, d => h('li', {}, d)),
      h('details', {}, h('summary', {}, '逐字稿'), h('pre', { class: 'args' }, r.transcript || '')),
      h('div', { class: 'row' }, toWork, h('button', { onclick: () => ipcRenderer.send('list:open', r.id) }, '在线索里查看'), h('button', { class: 'ghost', onclick: () => { M.phase = 'idle'; M.result = null; draw(); } }, '再记一场')),
      M.err ? h('div', { class: 'err' }, M.err) : null);
  }
  function draw() {
    tick(); if (!M.open) return;
    const close = h('button', { class: 'ghost close', title: M.phase === 'recording' ? '回到对话（会议继续记录）' : '回到对话', onclick: () => show(false) }, '← 回到对话');
    const body = !M.st ? h('div', { class: 'loading' }, h('i'), h('i'), h('i')) : M.phase === 'recording' ? recording() : M.phase === 'transcribing' || M.phase === 'summarizing' ? working() : M.phase === 'done' ? done() : M.st.ok ? idle() : setup();
    view.replaceChildren(h('div', { class: 'mtop' }, close), body);
  }
  ipcRenderer.on('meet:live', (_e, l) => { M.lines.push(l); if (M.lines.length > 400) M.lines.splice(0, 100); if (M.open && M.phase === 'recording') { const c = view.querySelector('.caps'); if (c) { if (c.querySelector('.muted')) c.replaceChildren(); c.append(h('p', {}, l.text)); c.scrollTop = c.scrollHeight; } } });
  ipcRenderer.on('meet:state', (_e, s) => {
    if (s.phase === 'error') { M.err = s.error; draw(); return; }
    if (s.phase === 'recording' && M.phase !== 'recording') { M.phase = 'recording'; M.startedAt = s.startedAt; M.mic = s.mic; M.lines = []; }
    else if (['transcribing', 'summarizing'].includes(s.phase) && M.phase !== 'done') M.phase = s.phase;
    draw();
  });
  ipcRenderer.on('meet:open', () => show(true));
  ipcRenderer.on('meet:download', (_e, d) => { M.dl = d; if (d.done) refresh(); else draw(); });
  refresh();
})();
