// Highlights and notes: creation from text selections, rendering, the notes sidebar, and autosave.

// Mark colours are mid-tone on purpose: each is at least 1.7:1 against white paper in greyscale,
// so marks stay visible on monochrome and e-ink screens, and black text on them stays above 8:1.
export const COLORS = {
  yellow: '#f7b500',
  orange: '#ffa94d',
  green: '#69db7c',
  blue: '#74c0fc',
  pink: '#f783ac',
  gray: '#adb5bd',
};

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// Place a floating element at viewport (x, y), kept on screen.
export function placeFloating(node, x, y) {
  node.hidden = false;
  const { width, height } = node.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
}

// Selection rects come one per text span; join the ones on the same line.
function mergeRects(rects) {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of sorted) {
    const last = out.find(
      (o) => Math.abs(o.y + o.h / 2 - (r.y + r.h / 2)) < Math.min(o.h, r.h) * 0.5 && r.x <= o.x + o.w + 0.012 && r.x + r.w >= o.x - 0.012
    );
    if (!last) {
      out.push({ ...r });
      continue;
    }
    const x2 = Math.max(last.x + last.w, r.x + r.w);
    const y2 = Math.max(last.y + last.h, r.y + r.h);
    last.x = Math.min(last.x, r.x);
    last.y = Math.min(last.y, r.y);
    last.w = x2 - last.x;
    last.h = y2 - last.y;
  }
  const round = (n) => Math.round(n * 1e5) / 1e5;
  return out.map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }));
}

export function initAnnotations(ctx) {
  const { api, pdfViewer, eventBus, container } = ctx;
  const selToolbar = $('sel-toolbar');
  const ctxMenu = $('ctx-menu');
  const popover = $('hl-popover');
  const status = $('save-status');

  let data = null; // annotation file for the open document
  let docId = null;
  let saveTimer = null;
  let dirty = false;
  let lastColor = localStorage.getItem('hl-color') || 'yellow';
  if (!COLORS[lastColor]) lastColor = 'yellow';
  let tool = 'select'; // 'select' (pointer) or 'marker' (every selection becomes a mark)
  let selection = null; // captured text selection the floating UI acts on
  let temp = []; // temporary highlights (translated passages); never saved

  // ---------- persistence ----------

  function scheduleSave() {
    if (!docId) return;
    dirty = true;
    status.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (!dirty || !docId) return;
    dirty = false;
    try {
      await api.saveAnnotations(docId, data);
      if (!dirty) status.textContent = 'Saved';
    } catch (err) {
      dirty = true;
      status.textContent = 'Save failed';
      console.error(err);
    }
  }
  window.addEventListener('beforeunload', flush);
  window.addEventListener('blur', flush);

  async function load(doc) {
    hideFloating();
    setTool('select');
    temp = [];
    viewReady = false;
    docId = doc.id;
    const saved = await api.loadAnnotations(doc.id);
    data = { version: 1, docNote: '', highlights: [], view: null, ...(saved || {}), name: doc.name, path: doc.path };
    $('doc-note').value = data.docNote || '';
    status.textContent = '';
    renderList();
  }

  // Reading position is saved too, so a paper reopens where you left it.
  let viewReady = false; // false while a document is still restoring its saved position
  const rememberView = () => {
    if (!data || !viewReady) return;
    data.view = { page: pdfViewer.currentPageNumber, scale: pdfViewer.currentScaleValue };
    scheduleSave();
  };
  eventBus.on('pagechanging', rememberView);
  eventBus.on('scalechanging', rememberView);

  // ---------- model helpers ----------

  // A selection spanning pages becomes one highlight per page; `cont` links the extra parts to the first.
  const rootOf = (h) => (h.cont ? data.highlights.find((x) => x.id === h.cont) || h : h);
  const groupOf = (h) => {
    const root = rootOf(h);
    return data.highlights.filter((x) => x === root || x.cont === root.id);
  };
  const pagesOf = (hs) => [...new Set(hs.map((h) => h.page))];

  function changed(pages) {
    pages.forEach(renderPage);
    renderList();
    scheduleSave();
  }

  function addHighlight(sel, color = lastColor) {
    const id = crypto.randomUUID();
    const created = new Date().toISOString();
    const parts = [...sel.byPage.entries()].sort((a, b) => a[0] - b[0]);
    parts.forEach(([page, rects], i) => {
      data.highlights.push(
        i === 0
          ? { id, page, rects, color, text: sel.text, note: '', created }
          : { id: crypto.randomUUID(), cont: id, page, rects, color }
      );
    });
    window.getSelection()?.removeAllRanges();
    changed(parts.map(([page]) => page));
    return data.highlights.find((h) => h.id === id);
  }

  function removeHighlight(h) {
    const group = groupOf(h);
    data.highlights = data.highlights.filter((x) => !group.includes(x));
    changed(pagesOf(group));
  }

  function useColor(color) {
    lastColor = color;
    localStorage.setItem('hl-color', color);
    renderToolColors();
  }

  function setColor(h, color) {
    useColor(color);
    const group = groupOf(h);
    group.forEach((x) => (x.color = color));
    changed(pagesOf(group));
  }

  // ---------- rendering on pages ----------

  function renderPage(pageNumber) {
    const div = pdfViewer.getPageView(pageNumber - 1)?.div;
    if (!div || !data) return;
    let layer = div.querySelector(':scope > .pp-hl-layer');
    if (!layer) {
      layer = el('div', { className: 'pp-hl-layer' });
      const canvas = div.querySelector(':scope > .canvasWrapper');
      if (canvas) canvas.after(layer); // above the page image, below the selectable text
      else div.prepend(layer);
    }
    const nodes = [];
    for (const h of data.highlights) {
      if (h.page !== pageNumber) continue;
      const hasNote = Boolean(rootOf(h).note);
      for (const r of h.rects) {
        const node = el('div', { className: `pp-hl${hasNote ? ' has-note' : ''}` });
        node.dataset.id = h.id;
        node.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;--c:${COLORS[h.color] || COLORS.yellow}`;
        nodes.push(node);
      }
    }
    for (const t of temp) {
      for (const part of t.parts) {
        if (part.page !== pageNumber) continue;
        for (const r of part.rects) {
          const node = el('div', { className: 'pp-hl pp-temp' });
          node.dataset.id = t.id;
          node.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`;
          nodes.push(node);
        }
      }
    }
    layer.replaceChildren(...nodes);
  }

  // Temporary highlights mark passages sent for translation while the translations panel is open.
  const tempPages = (items) => [...new Set(items.flatMap((t) => t.parts.map((p) => p.page)))];
  function addTemp(id, byPage) {
    const parts = [...byPage].sort((a, b) => a[0] - b[0]).map(([page, rects]) => ({ page, rects }));
    temp.push({ id, parts });
    tempPages([{ parts }]).forEach(renderPage);
  }
  function removeTemp(id) {
    const gone = temp.filter((t) => id == null || t.id === id);
    temp = temp.filter((t) => !gone.includes(t));
    tempPages(gone).forEach(renderPage);
  }
  function scrollToTemp(id) {
    const t = temp.find((x) => x.id === id);
    if (t) scrollTo({ id, page: t.parts[0].page, rects: t.parts[0].rects });
  }

  // pdf.js rebuilds page contents when it (re)renders, so highlights are re-applied each time.
  eventBus.on('pagerendered', (e) => renderPage(e.pageNumber));

  // Page-relative box that highlight coordinates are measured against.
  const pageBox = (pageEl) => (pageEl.querySelector('.textLayer') || pageEl).getBoundingClientRect();

  function highlightAt(event) {
    const pageEl = event.target.closest?.('.page');
    if (!pageEl || !data) return null;
    const box = pageBox(pageEl);
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const page = Number(pageEl.dataset.pageNumber);
    return (
      data.highlights.find(
        (h) => h.page === page && h.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
      ) || null
    );
  }

  function scrollTo(h) {
    const div = pdfViewer.getPageView(h.page - 1)?.div;
    if (!div) return;
    const top = Math.min(...h.rects.map((r) => r.y));
    container.scrollTop = div.offsetTop + top * div.clientHeight - container.clientHeight / 3;
    // The page may not be rendered yet; flash once its highlight nodes exist.
    let tries = 0;
    const flash = () => {
      const nodes = div.querySelectorAll(`.pp-hl[data-id="${h.id}"]`);
      if (!nodes.length && tries++ < 20) return setTimeout(flash, 100);
      nodes.forEach((n) => {
        n.classList.remove('flash');
        void n.offsetWidth;
        n.classList.add('flash');
      });
    };
    flash();
  }

  // ---------- text selection ----------

  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const rootNode = range.commonAncestorContainer;
    const root = rootNode.nodeType === Node.TEXT_NODE ? rootNode.parentNode : rootNode;
    if (!container.contains(root)) return null;
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;

    const raw = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!range.intersectsNode(node)) continue;
      const layer = node.parentElement?.closest('.textLayer');
      const pageEl = layer?.closest('.page');
      if (!pageEl) continue;
      const part = document.createRange();
      part.selectNodeContents(node);
      if (node === range.startContainer) part.setStart(node, range.startOffset);
      if (node === range.endContainer) part.setEnd(node, range.endOffset);
      const box = layer.getBoundingClientRect();
      const page = Number(pageEl.dataset.pageNumber);
      for (const r of part.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        if (!raw.has(page)) raw.set(page, []);
        raw.get(page).push({
          x: (r.left - box.left) / box.width,
          y: (r.top - box.top) / box.height,
          w: r.width / box.width,
          h: r.height / box.height,
        });
      }
    }
    if (!raw.size) return null;
    const byPage = new Map([...raw].map(([page, rects]) => [page, mergeRects(rects)]));
    return { text, byPage, rect: range.getBoundingClientRect() };
  }

  // ---------- floating UI: selection toolbar, context menu, note popover ----------

  function hideFloating() {
    selToolbar.hidden = ctxMenu.hidden = popover.hidden = true;
  }

  const colorDots = (onPick, current) =>
    Object.entries(COLORS).map(([name, hex]) => {
      const dot = el('button', { className: `dot${name === current ? ' current' : ''}`, title: `Highlight ${name}` });
      dot.style.background = hex;
      dot.onclick = () => onPick(name);
      return dot;
    });

  function highlightSelection(color, withNote = false) {
    if (!selection) return;
    if (color) useColor(color);
    const { rect } = selection;
    const h = addHighlight(selection, lastColor);
    selection = null;
    hideFloating();
    if (withNote) openPopover(h, rect.left, rect.bottom + 6, true);
  }

  function showSelToolbar() {
    selToolbar.replaceChildren(
      ...colorDots((name) => highlightSelection(name)),
      el('button', { className: 'tb small', textContent: 'Note', title: 'Highlight and add a note', onclick: () => highlightSelection(null, true) }),
      el('button', { className: 'tb small', textContent: 'Search', title: 'Search the web for this text', onclick: () => runAndHide(() => ctx.panel.showSearch(selection.text)) }),
      el('button', { className: 'tb small', textContent: 'Translate', title: 'Translate this text in the right panel', onclick: translateSelection })
    );
    const r = selection.rect;
    placeFloating(selToolbar, r.left + r.width / 2 - 130, r.top - 44 < 60 ? r.bottom + 8 : r.top - 44);
  }

  function translateSelection() {
    if (!selection) return;
    ctx.panel.translate(selection);
    selection = null;
    window.getSelection()?.removeAllRanges();
    hideFloating();
  }

  // Marker tool: the selection is marked straight away, and a small tooltip offers a note.
  function markSelection() {
    const { rect } = selection;
    const h = addHighlight(selection, lastColor);
    selection = null;
    hideFloating();
    selToolbar.replaceChildren(
      el('button', { className: 'tb small', textContent: 'Add note', onclick: () => openPopover(h, rect.left, rect.bottom + 6, true) }),
      el('button', { className: 'tb small danger', textContent: 'Remove', title: 'Remove this mark', onclick: () => runAndHide(() => removeHighlight(h)) })
    );
    placeFloating(selToolbar, rect.right - 60, rect.bottom + 6);
  }

  // ---------- toolbar tools ----------

  function setTool(name) {
    tool = name;
    document.body.dataset.tool = name;
    $('tool-select').classList.toggle('active', name === 'select');
    $('tool-marker').classList.toggle('active', name === 'marker');
    $('tool-select').setAttribute('aria-pressed', String(name === 'select'));
    $('tool-marker').setAttribute('aria-pressed', String(name === 'marker'));
    if (name === 'select') selToolbar.hidden = true;
    else window.getSelection()?.removeAllRanges();
  }

  function renderToolColors() {
    document.body.style.setProperty('--mark', COLORS[lastColor]);
    // Picking a colour in the toolbar also picks up the marker.
    $('tool-colors').replaceChildren(...colorDots((name) => { useColor(name); setTool('marker'); }, lastColor));
  }

  $('tool-select').onclick = () => setTool('select');
  $('tool-marker').onclick = () => setTool('marker');
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, [contenteditable]')) return;
    if (e.key === 'v') setTool('select');
    if (e.key === 'm') setTool('marker');
  });

  function runAndHide(fn) {
    fn();
    hideFloating();
  }

  function showMenu(x, y, items) {
    ctxMenu.replaceChildren(
      ...items.map((item) =>
        item === '-'
          ? el('hr')
          : el('button', { className: 'menu-item', textContent: item.label, onclick: () => runAndHide(item.run) })
      )
    );
    placeFloating(ctxMenu, x, y);
  }

  function openPopover(h, x, y, focus = false) {
    const root = rootOf(h);
    const note = el('textarea', { placeholder: 'Add a note…', value: root.note || '' });
    note.oninput = () => {
      root.note = note.value;
      changed(pagesOf(groupOf(root)));
    };
    popover.replaceChildren(
      el('div', { className: 'row' }, ...colorDots((name) => { setColor(root, name); openPopover(root, x, y); }, root.color),
        el('span', { className: 'spacer' }),
        el('button', { className: 'tb small danger', textContent: 'Delete', onclick: () => runAndHide(() => removeHighlight(root)) })),
      note
    );
    selToolbar.hidden = ctxMenu.hidden = true;
    placeFloating(popover, x, y);
    if (focus) note.focus();
  }

  // Keep the text selection alive while clicking the floating controls.
  for (const node of [selToolbar, ctxMenu]) node.addEventListener('mousedown', (e) => e.preventDefault());

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.floating')) hideFloating();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideFloating();
  });
  container.addEventListener('scroll', () => (selToolbar.hidden = ctxMenu.hidden = true), { passive: true });

  container.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    // Wait a tick: the browser finalizes the selection after mouseup.
    setTimeout(() => {
      selection = captureSelection();
      if (!selection) return;
      if (tool === 'marker') markSelection();
      else showSelToolbar();
    });
  });

  container.addEventListener('click', (e) => {
    if (!window.getSelection()?.isCollapsed || e.target.closest('a')) return;
    const h = highlightAt(e);
    if (h) openPopover(h, e.clientX + 8, e.clientY + 8);
  });

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selToolbar.hidden = popover.hidden = true;
    selection = captureSelection();
    if (selection) {
      const text = selection.text;
      const short = text.length > 28 ? `${text.slice(0, 28)}…` : text;
      showMenu(e.clientX, e.clientY, [
        { label: `Search Google for “${short}”`, run: () => ctx.panel.showSearch(text) },
        { label: 'Search Google Scholar', run: () => ctx.panel.showSearch(text, 'scholar') },
        { label: 'Translate', run: translateSelection },
        { label: 'Look up as a paper', run: () => ctx.panel.showCitation({ text }) },
        '-',
        { label: 'Highlight', run: () => highlightSelection() },
        { label: 'Highlight and add note', run: () => highlightSelection(null, true) },
        '-',
        { label: 'Copy', run: () => navigator.clipboard.writeText(text) },
      ]);
      return;
    }
    const h = highlightAt(e);
    if (h) {
      showMenu(e.clientX, e.clientY, [
        { label: 'Edit note', run: () => setTimeout(() => openPopover(h, e.clientX, e.clientY, true)) },
        { label: 'Search Google for this highlight', run: () => ctx.panel.showSearch(rootOf(h).text) },
        '-',
        { label: 'Delete highlight', run: () => removeHighlight(h) },
      ]);
    }
  });

  // ---------- sidebar ----------

  function renderList() {
    const list = $('hl-list');
    if (!data) return list.replaceChildren();
    const roots = data.highlights
      .filter((h) => !h.cont)
      .sort((a, b) => a.page - b.page || a.rects[0].y - b.rects[0].y);
    if (!roots.length) {
      return list.replaceChildren(el('p', { className: 'hint', textContent: 'Select text in the PDF to highlight it or add a note.' }));
    }
    list.replaceChildren(
      ...roots.map((h) => {
        const item = el('div', { className: 'hl-item' },
          el('div', { className: 'hl-page', textContent: `Page ${h.page}` }),
          el('div', { className: 'hl-text', textContent: h.text }));
        if (h.note) item.append(el('div', { className: 'hl-note', textContent: h.note }));
        item.style.borderLeftColor = COLORS[h.color] || COLORS.yellow;
        item.onclick = () => scrollTo(h);
        return item;
      })
    );
  }

  $('doc-note').addEventListener('input', (e) => {
    if (!data) return;
    data.docNote = e.target.value;
    scheduleSave();
  });

  async function exportMarkdown() {
    if (!data) return;
    const lines = [`# Notes: ${data.name}`, ''];
    if (data.docNote?.trim()) lines.push(data.docNote.trim(), '');
    const roots = data.highlights.filter((h) => !h.cont).sort((a, b) => a.page - b.page || a.rects[0].y - b.rects[0].y);
    if (roots.length) lines.push('## Highlights', '');
    for (const h of roots) {
      lines.push(`> ${h.text}`, '', `— page ${h.page}`, '');
      if (h.note?.trim()) lines.push(`**Note:** ${h.note.trim()}`, '');
    }
    await api.exportMarkdown(data.name, lines.join('\n'));
  }
  $('btn-export').onclick = exportMarkdown;

  renderToolColors();
  setTool('select');

  return {
    load,
    flush,
    exportMarkdown,
    setTool,
    addTemp,
    removeTemp,
    scrollToTemp,
    savedView: () => data?.view || null,
    viewRestored: () => (viewReady = true),
  };
}
