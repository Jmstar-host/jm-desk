/* 下拉框：用场景样式的浮层代替系统原生的下拉菜单。<select> 本身保留（值、change 事件、禁用状态照旧），只是不让系统弹它自己的菜单。 */
(() => {
  let pop = null, owner = null, hl = -1;
  const close = () => { if (pop) { pop.remove(); pop = null; owner = null; hl = -1; } };
  const pick = i => { const sel = owner; if (!sel || sel.options[i]?.disabled) return; if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); } close(); sel.focus(); };
  const mark = i => { if (!pop) return; hl = i; [...pop.children].forEach((e, k) => e.classList.toggle('hl', k === i)); pop.children[i]?.scrollIntoView({ block: 'nearest' }); };
  function open(sel) {
    close(); if (sel.disabled || sel.multiple || !sel.options.length) return;
    owner = sel; pop = document.createElement('div'); pop.className = 'selpop';
    [...sel.options].forEach((o, i) => { const it = document.createElement('div'); it.className = 'so' + (i === sel.selectedIndex ? ' on' : '') + (o.disabled ? ' dis' : ''); it.textContent = o.textContent || '\u00a0'; it.title = o.textContent;
      it.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); pick(i); }); pop.append(it); });
    document.body.append(pop);
    const r = sel.getBoundingClientRect(), W = Math.min(Math.max(r.width, 170), innerWidth - 16), below = innerHeight - r.bottom - 10, above = r.top - 10, up = below < 150 && above > below;
    pop.style.width = W + 'px'; pop.style.maxHeight = Math.max(90, Math.min(300, up ? above : below)) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - W - 8)) + 'px';
    if (up) pop.style.bottom = (innerHeight - r.top + 4) + 'px'; else pop.style.top = (r.bottom + 4) + 'px';
    mark(sel.selectedIndex);
  }
  document.addEventListener('mousedown', e => {
    const sel = e.target.closest && e.target.closest('select');
    if (sel) { e.preventDefault(); sel.focus(); owner === sel ? close() : open(sel); return; }
    if (pop && !pop.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', e => {
    const sel = e.target.tagName === 'SELECT' ? e.target : null;
    if (!pop) { if (sel && [' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(sel); } return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const s = owner; close(); s.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = pop.children.length; let i = hl; for (let k = 0; k < n; k++) { i = (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; if (!owner.options[i].disabled) break; } mark(i); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(hl); }
    else if (e.key === 'Tab') close();
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
