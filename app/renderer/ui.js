/* 下拉框：用场景样式的浮层代替系统原生的下拉菜单。<select> 本身保留（值、change 事件、禁用状态照旧），只是不让系统弹它自己的菜单。
 * 浮层顶上有搜索框（1.4.4）：输入就模糊筛选——空格分开的每个词都要命中，连续命中的排前面，不连续的（按顺序出现的字）也算；命中的字标粉。
 * 在关着的下拉框上直接打字，会打开并把字放进搜索框。 */
(() => {
  let pop = null, owner = null, list = null, box = null, shown = [], hl = -1;
  /** 模糊匹配：返回 { score, pos }（pos 是命中的字的位置）或 null */
  function fuzzy(text, query) {
    const t = String(text || '').toLowerCase(), words = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) return { score: 0, pos: [] };
    let score = 0; const pos = new Set();
    for (const w of words) {
      const i = t.indexOf(w);
      if (i >= 0) { score += 200 - Math.min(i, 100) + w.length * 4; for (let k = 0; k < w.length; k++) pos.add(i + k); continue; }
      let j = 0, last = -1, gaps = 0; const p = [];
      for (let k = 0; k < t.length && j < w.length; k++) if (t[k] === w[j]) { if (last >= 0) gaps += k - last - 1; last = k; p.push(k); j++; }
      if (j < w.length) return null;
      score += 60 - Math.min(gaps, 59); p.forEach(x => pos.add(x));
    }
    return { score, pos: [...pos] };
  }
  window.jmFuzzy = fuzzy;
  const close = () => { if (pop) { pop.remove(); pop = null; owner = null; list = null; box = null; shown = []; hl = -1; } };
  const pick = i => { const sel = owner; if (!sel || i == null || sel.options[i]?.disabled) return; if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); } close(); sel.focus(); };
  const mark = k => { if (!list) return; hl = k; [...list.children].forEach((e, n) => e.classList.toggle('hl', n === k)); list.children[k]?.scrollIntoView({ block: 'nearest' }); };
  function render() {
    const sel = owner, q = box.value, rows = [];
    [...sel.options].forEach((o, i) => { const m = fuzzy(o.textContent, q); if (m) rows.push({ i, m }); });
    if (q.trim()) rows.sort((a, b) => b.m.score - a.m.score || a.i - b.i);
    shown = rows.map(r => r.i);
    list.replaceChildren(...rows.map(({ i, m }) => {
      const o = sel.options[i], it = document.createElement('div'), txt = o.textContent || '\u00a0', hit = new Set(m.pos);
      it.className = 'so' + (i === sel.selectedIndex ? ' on' : '') + (o.disabled ? ' dis' : ''); it.title = txt;
      if (hit.size) for (let k = 0; k < txt.length; k++) { const ch = txt[k]; if (hit.has(k)) { const bb = document.createElement('b'); bb.textContent = ch; it.append(bb); } else it.append(ch); } else it.textContent = txt;
      it.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); pick(i); });
      return it;
    }));
    if (!rows.length) { const n = document.createElement('div'); n.className = 'none'; n.textContent = '没有匹配的选项'; list.append(n); }
    const cur = shown.indexOf(sel.selectedIndex), first = shown.findIndex(i => !sel.options[i].disabled);
    mark(q.trim() ? first : cur >= 0 ? cur : first);
  }
  function open(sel, typed = '') {
    close(); if (sel.disabled || sel.multiple || !sel.options.length) return;
    owner = sel; pop = document.createElement('div'); pop.className = 'selpop sel';
    box = document.createElement('input'); box.className = 'sq'; box.placeholder = '输入筛选…'; box.value = typed; box.setAttribute('autocomplete', 'off');
    list = document.createElement('div'); list.className = 'sl';
    pop.append(box, list); document.body.append(pop);
    const r = sel.getBoundingClientRect(), W = Math.min(Math.max(r.width, 200), innerWidth - 16), below = innerHeight - r.bottom - 10, above = r.top - 10, up = below < 180 && above > below;
    pop.style.width = W + 'px'; pop.style.maxHeight = Math.max(130, Math.min(340, up ? above : below)) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - W - 8)) + 'px';
    if (up) pop.style.bottom = (innerHeight - r.top + 4) + 'px'; else pop.style.top = (r.bottom + 4) + 'px';
    box.addEventListener('input', render);
    render(); box.focus(); box.setSelectionRange(box.value.length, box.value.length);
  }
  document.addEventListener('mousedown', e => {
    const sel = e.target.closest && e.target.closest('select');
    if (sel) { e.preventDefault(); sel.focus(); owner === sel ? close() : open(sel); return; }
    if (pop && !pop.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', e => {
    if (!pop) {
      const sel = e.target.tagName === 'SELECT' ? e.target : null; if (!sel) return;
      if ([' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(sel); }
      else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); open(sel, e.key); } // 直接打字：打开并开始筛选
      return;
    }
    if (e.target !== box) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const s = owner; close(); s.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); const n = shown.length; if (!n) return; let k = hl;
      for (let t = 0; t < n; t++) { k = (k + (e.key === 'ArrowDown' ? 1 : n - 1) + n) % n; if (!owner.options[shown[k]].disabled) break; } mark(k);
    }
    else if (e.key === 'Enter') { e.preventDefault(); if (hl >= 0) pick(shown[hl]); }
    else if (e.key === 'Tab') { const s = owner; close(); s.focus(); }
  }, true);
  addEventListener('blur', close); addEventListener('resize', close);
  document.addEventListener('scroll', e => { if (pop && !pop.contains(e.target)) close(); }, true);
})();

/* 日期：用场景样式的小日历代替系统的日期选择器。<input type="date"> 本身保留（值是 YYYY-MM-DD，键盘照常可以直接输入），点一下弹出日历。 */
(() => {
  let pop = null, owner = null, view = null;
  const pad = n => String(n).padStart(2, '0'), fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? new Date(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) : null;
  const close = () => { if (pop) { pop.remove(); pop = null; owner = null; } };
  const set = v => { const inp = owner; if (!inp) return; if (inp.value !== v) { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); } close(); inp.focus(); };
  const el = (tag, cls, text, on) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (on) e.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); on(); }); return e; };
  function draw() {
    const cur = owner.value, today = fmt(new Date()), y = view.getFullYear(), m = view.getMonth();
    const hd = el('div', 'dh'); hd.append(el('b', 'nav', '‹', () => { view = new Date(y, m - 1, 1); draw(); }), el('span', '', `${y} 年 ${m + 1} 月`), el('b', 'nav', '›', () => { view = new Date(y, m + 1, 1); draw(); }));
    const grid = el('div', 'dg'); for (const w of '一二三四五六日') grid.append(el('i', '', w));
    const first = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
    for (let k = 0; k < first; k++) grid.append(el('span'));
    for (let d = 1; d <= days; d++) { const v = `${y}-${pad(m + 1)}-${pad(d)}`; grid.append(el('em', (v === cur ? 'on' : '') + (v === today ? ' td' : ''), String(d), () => set(v))); }
    const ft = el('div', 'df'); ft.append(el('b', '', '今天', () => set(today)), el('b', '', '清空', () => set('')));
    pop.replaceChildren(hd, grid, ft);
  }
  function open(inp) {
    close(); if (inp.disabled || inp.readOnly) return;
    owner = inp; view = parse(inp.value) || new Date(); view = new Date(view.getFullYear(), view.getMonth(), 1);
    pop = el('div', 'selpop datepop'); document.body.append(pop); draw();
    const r = inp.getBoundingClientRect(), W = 252, H = pop.offsetHeight, up = innerHeight - r.bottom < H + 12 && r.top > H + 12;
    pop.style.width = W + 'px'; pop.style.left = Math.max(8, Math.min(r.left, innerWidth - W - 8)) + 'px';
    if (up) pop.style.bottom = (innerHeight - r.top + 4) + 'px'; else pop.style.top = (r.bottom + 4) + 'px';
  }
  document.addEventListener('mousedown', e => {
    const inp = e.target.closest && e.target.closest('input[type=date]');
    if (inp) { e.preventDefault(); inp.focus(); owner === inp ? close() : open(inp); return; }
    if (pop && !pop.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', e => { if (pop && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const i = owner; close(); i.focus(); } else if (pop && e.key === 'Tab') close(); }, true);
  addEventListener('blur', close); addEventListener('resize', close);
  document.addEventListener('scroll', e => { if (pop && !pop.contains(e.target)) close(); }, true);
})();
