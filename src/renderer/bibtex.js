// Toolbar button that copies a BibTeX entry for the open paper. The entry is looked up in the
// background when a paper opens (free scholarly indexes only) and saved with the paper's notes;
// if that finds nothing, clicking the button lets the OpenRouter model search the web for it.

import { buildLines } from './citations.js';

const $ = (id) => document.getElementById(id);

// What identifies the paper: its metadata title, the largest text on page one, and the first pages' text.
async function describe(pdf) {
  const meta = await pdf.getMetadata().catch(() => null);
  const pages = [];
  for (let p = 1; p <= Math.min(2, pdf.numPages); p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    pages.push(buildLines(content.items).map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })));
  }
  // The title is normally the biggest type on the first page (the sideways arXiv stamp aside).
  const first = (pages[0] || []).filter((l) => l.text.split(' ').length >= 2 && !/arxiv:/i.test(l.text));
  const biggest = Math.max(0, ...first.map((l) => l.h));
  const titleGuess = first.filter((l) => l.h >= biggest * 0.95).slice(0, 4).map((l) => l.text).join(' ');
  return {
    metaTitle: String(meta?.info?.Title || '').trim(),
    titleGuess,
    text: pages.flat().map((l) => l.text).join('\n').slice(0, 12000),
  };
}

export function initBibtex(ctx) {
  const { api } = ctx;
  const button = $('btn-bibtex');
  const LABEL = 'BibTeX';
  let pending = null; // { doc, promise } background lookup for the open paper
  let resetTimer = null;

  function setState(label, title, busy = false) {
    clearTimeout(resetTimer);
    button.textContent = label;
    button.title = title;
    button.classList.toggle('busy', busy);
  }
  const idle = () => {
    const saved = ctx.annotations.getMeta('bibtex');
    setState(LABEL, saved ? `Copy this paper’s BibTeX entry (from ${saved.source})` : 'Copy a BibTeX entry for this paper');
    button.classList.toggle('ready', Boolean(saved));
  };
  const flash = (label, title) => {
    setState(label, title);
    resetTimer = setTimeout(idle, 2500);
  };

  async function find(doc, useAi) {
    let res;
    try {
      res = await api.findBibtex(await describe(doc.pdf), useAi);
    } catch (err) {
      res = { entry: null, error: err.message };
    }
    if (res.entry) ctx.annotations.setMeta(doc.id, 'bibtex', { entry: res.entry, source: res.source, ai: Boolean(res.ai) });
    return res;
  }

  function docChanged() {
    const doc = ctx.doc;
    button.disabled = !doc;
    pending = null;
    idle();
    if (!doc || ctx.annotations.getMeta('bibtex')) return;
    pending = { doc, promise: find(doc, false) };
    pending.promise.then(() => ctx.doc === doc && !button.classList.contains('busy') && idle());
  }

  button.onclick = async () => {
    const doc = ctx.doc;
    if (!doc || button.classList.contains('busy')) return;
    let saved = ctx.annotations.getMeta('bibtex');
    let error = '';
    if (!saved) {
      setState('Finding…', 'Looking for this paper’s BibTeX entry', true);
      let res = pending?.doc === doc ? await pending.promise : await find(doc, false);
      if (!res.entry && (await api.getSettings()).hasOpenRouterKey) {
        setState('Searching…', 'Searching the web for this paper’s BibTeX entry', true);
        res = await find(doc, true);
      }
      if (ctx.doc !== doc) return;
      saved = ctx.annotations.getMeta('bibtex');
      error = res.error || '';
    }
    if (!saved) {
      const why = error || 'No index lists this paper. With an OpenRouter API key in Settings, Paper Pal can search the web for it.';
      return flash('No BibTeX', why);
    }
    await api.copyText(saved.entry);
    button.classList.add('ready');
    flash('Copied ✓', saved.ai ? `Copied. Compiled by ${saved.source}: check it before citing.` : `Copied (from ${saved.source})`);
  };

  docChanged();
  return { docChanged };
}
