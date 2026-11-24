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
