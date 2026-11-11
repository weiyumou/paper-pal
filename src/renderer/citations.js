// Citation links: when an in-text citation is clicked, read the bibliography entry it points at
// and show that paper in the right panel instead of jumping to the reference list.

const CITE_NAME = /^(cite\.|bib|CR\d|ref[-_.:]?\d|reference|citation|[BbRc]\d+$)/i;
const OTHER_NAME =
  /^(section|subsection|subsubsection|paragraph|appendix|chapter|part|figure|subfigure|table|equation|page|item|theorem|lemma|proposition|corollary|definition|assumption|remark|example|algorithm|ALC@|lstlisting|lstnumber|Hfootnote|footnote|Doc-Start|AMS|toc|sec|fig|tab|eq|app)[.:\-_@]?/i;
const REFS_HEADING = /^\s*(\d+\.?\s*|[A-Z]\.?\s+)?(references|bibliography|literature cited|works cited|references and notes)\s*$/i;
const NEW_ENTRY = /^\s*(\[\d{1,3}\]|\d{1,3}\.\s|\[[A-Za-z+\-]{2,}\s?\d{2,4}[a-z]?\])/;
const YEAR = /\b(19|20)\d\d[a-z]?\b/;

// Group a page's text items into visual lines (PDF coordinates: y grows upward).
export function buildLines(items) {
  const lines = [];
  let cur = null;
  let endX = 0;
  for (const item of items) {
    if (!item.str) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const h = item.height || Math.abs(item.transform[3]) || 10;
    const sameLine = cur && Math.abs(y - cur.y) <= 2 && x >= endX - 5 && x - endX <= 25;
    if (!sameLine) {
      if (!item.str.trim()) continue;
      cur = { x0: x, x1: x + item.width, y, h, font: item.fontName, text: '' };
      lines.push(cur);
    } else if (x - endX > 1.5 && !cur.text.endsWith(' ')) {
      cur.text += ' ';
    }
    cur.text += item.str;
    cur.x1 = Math.max(cur.x1, x + item.width);
    endX = x + item.width;
  }
  return lines.filter((l) => l.text.trim());
}

function joinLines(lines) {
  let out = '';
  for (const { text } of lines) {
    const t = text.trim();
    // Undo end-of-line hyphenation.
    if (/[a-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
    else out += (out ? ' ' : '') + t;
  }
  return out.replace(/\s+/g, ' ').trim();
}

const sameRef = (a, b) => a && b && typeof a === 'object' && typeof b === 'object' && a.num === b.num && a.gen === b.gen;

function destPosition(explicit) {
  const [, kind, ...args] = explicit;
  switch (kind?.name) {
    case 'XYZ':
      return { left: args[0] ?? null, top: args[1] ?? null };
    case 'FitH':
    case 'FitBH':
      return { left: null, top: args[0] ?? null };
    case 'FitR':
      return { left: args[0] ?? null, top: args[3] ?? null };
    default:
      return { left: null, top: null };
  }
}

export function initCitations(ctx) {
  const caches = new WeakMap(); // per PDF document

  function cacheFor(pdf) {
    if (!caches.has(pdf)) caches.set(pdf, { lines: new Map(), refsStart: undefined, dests: undefined });
    return caches.get(pdf);
  }

  async function pageLines(pdf, pageIndex) {
    const cache = cacheFor(pdf).lines;
    if (!cache.has(pageIndex)) {
      const page = await pdf.getPage(pageIndex + 1);
      const content = await page.getTextContent();
      cache.set(pageIndex, buildLines(content.items));
    }
    return cache.get(pageIndex);
  }

  // Where the reference list begins: the last "References"-style heading in the document.
  async function refsStart(pdf) {
    const cache = cacheFor(pdf);
    if (cache.refsStart !== undefined) return cache.refsStart;
    cache.refsStart = null;
    const first = Math.max(0, pdf.numPages - 150);
    for (let i = pdf.numPages - 1; i >= first; i--) {
      const heading = (await pageLines(pdf, i)).find((l) => REFS_HEADING.test(l.text));
      if (heading) {
        cache.refsStart = { pageIndex: i, y: heading.y };
        break;
      }
    }
    return cache.refsStart;
  }

  async function allDests(pdf) {
    const cache = cacheFor(pdf);
    if (!cache.dests) {
      const dests = await pdf.getDestinations().catch(() => null);
      const entries = dests instanceof Map ? [...dests] : Object.entries(dests || {});
      cache.dests = entries.filter(([, explicit]) => Array.isArray(explicit));
    }
    return cache.dests;
  }

  // Text of the bibliography entry that starts at (left, top) on a page.
  async function entryText(pdf, target) {
    const { pageIndex, left, top, ref } = target;
    const lines = await pageLines(pdf, pageIndex);
    const near = lines.filter((l) => l.y <= top + 3 && l.y >= top - 40 && (left == null || l.x0 >= left - 15));
    if (!near.length) return '';
    // Leftmost line just below the anchor is the entry's first line (other columns sit further right).
    const start = near.reduce((a, b) => (b.x0 < a.x0 - 3 || (Math.abs(b.x0 - a.x0) <= 3 && b.y > a.y) ? b : a));
    const column = lines
      .filter((l) => Math.abs(l.x0 - start.x0) <= 45 && l.y <= start.y + 1)
      .sort((a, b) => b.y - a.y);

    // Best case: the next citation anchor in the same column marks where this entry ends.
    let boundary = null;
    for (const [, explicit] of await allDests(pdf)) {
      if (!sameRef(explicit[0], ref)) continue;
      const pos = destPosition(explicit);
      if (pos.top == null || pos.top >= top - 4) continue;
      if (left != null && pos.left != null && Math.abs(pos.left - left) > 45) continue;
      if (boundary == null || pos.top > boundary) boundary = pos.top;
    }
    if (boundary != null) {
      const picked = column.filter((l) => l.y > boundary - 3);
      if (picked.length && picked.length <= 25) return joinLines(picked);
    }

    // Otherwise infer the end from layout: a new label, a paragraph gap, or the end of a hanging indent.
    const picked = [column[0]];
    const gap = column.length > 1 ? column[0].y - column[1].y : 0;
    const hanging = column.length > 1 && column[1].x0 > column[0].x0 + 3;
    for (let i = 1; i < column.length && picked.length < 12; i++) {
      const line = column[i];
      if (NEW_ENTRY.test(line.text)) break;
      if (column[i - 1].y - line.y > gap * 1.4 + 1) break;
      if (hanging && line.x0 <= column[0].x0 + 1) break;
      picked.push(line);
    }
    return joinLines(picked);
  }

  // Returns { text } when `dest` points at a bibliography entry, otherwise null.
  async function resolveCitation(dest) {
    const pdf = ctx.doc?.pdf;
    if (!pdf) return null;
    const name = typeof dest === 'string' ? dest : null;
    if (name && OTHER_NAME.test(name) && !CITE_NAME.test(name)) return null;
    const explicit = name ? await pdf.getDestination(name) : await dest;
    if (!Array.isArray(explicit)) return null;
    const ref = explicit[0];
    const pageIndex = Number.isInteger(ref) ? ref : await pdf.getPageIndex(ref);
    const { left, top } = destPosition(explicit);
    if (top == null) return null;

    const namedCite = Boolean(name && CITE_NAME.test(name));
    if (!namedCite) {
      // Unlabelled link: only treat it as a citation if it lands inside the reference list.
      const start = await refsStart(pdf);
      const inRefs = start && (pageIndex > start.pageIndex || (pageIndex === start.pageIndex && top <= start.y + 5));
      if (!inRefs) return null;
    }
    const text = await entryText(pdf, { pageIndex, left, top, ref });
    if (!namedCite && !YEAR.test(text)) return null;
    return { text };
  }

  // Hold ⌘ / Alt / Ctrl while clicking to jump to the reference list as usual.
  let bypass = false;
  ctx.container.addEventListener('mousedown', (e) => (bypass = e.metaKey || e.altKey || e.ctrlKey), true);

  const goToDestination = ctx.linkService.goToDestination.bind(ctx.linkService);
  ctx.linkService.goToDestination = async (dest) => {
    if (!bypass) {
      try {
        const hit = await resolveCitation(dest);
        if (hit) {
          ctx.panel.showCitation({ text: hit.text, jump: () => goToDestination(dest) });
          return;
        }
      } catch (err) {
        console.warn('Citation lookup failed, following the link instead', err);
      }
    }
    return goToDestination(dest);
  };
}
