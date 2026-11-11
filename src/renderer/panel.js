// Right panel: details of a cited paper, or an embedded web search.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
};

const SEARCH_URL = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  scholar: (q) => `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}`,
};

export function initPanel(ctx) {
  const { api } = ctx;
  const panel = $('panel');
  const resizer = $('panel-resizer');
  const citeBody = $('panel-cite');
  const webBody = $('panel-web');
  const transBody = $('panel-trans');
  const transList = $('trans-list');
  const transTab = $('panel-translations');
  let translations = []; // { id, text, card } kept until the panel is closed
  const lookups = new Map(); // reference text -> lookup promise
  const summaries = new Map(); // paper key -> summary promise
  let settings = api.getSettings();
  let webview = null;
  let requestId = 0;

  // ---------- open / close / resize ----------

  function show(mode) {
    panel.hidden = resizer.hidden = false;
    panel.dataset.mode = mode;
    citeBody.hidden = mode !== 'cite';
    webBody.hidden = mode !== 'web';
    transBody.hidden = mode !== 'translate';
    updateTransTab();
  }
  // Closing the panel is what ends a translation session: cards and their page highlights go away.
  function hide() {
    panel.hidden = resizer.hidden = true;
    clearTranslations();
  }
  $('panel-close').onclick = hide;

  const setWidth = (px) => {
    const width = Math.max(300, Math.min(px, window.innerWidth * 0.7));
    panel.style.width = `${width}px`;
    localStorage.setItem('panel-width', String(Math.round(width)));
  };
  setWidth(Number(localStorage.getItem('panel-width')) || 440);
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing'); // stops the webview from swallowing mouse events
    const move = (ev) => setWidth(window.innerWidth - ev.clientX);
    const up = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // ---------- web search ----------

  function showSearch(query, engine = 'google') {
    const text = (query || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!text) return;
    const url = SEARCH_URL[engine](text);
    $('panel-title').textContent = engine === 'scholar' ? 'Google Scholar' : 'Google';
    show('web');
    if (!webview) {
      webview = document.createElement('webview');
      webview.setAttribute('partition', 'persist:search');
      webview.setAttribute('allowpopups', '');
      webview.src = url;
      webBody.append(webview);
    } else {
      webview.src = url;
    }
  }
  $('web-back').onclick = () => webview?.canGoBack() && webview.goBack();
  $('web-forward').onclick = () => webview?.canGoForward() && webview.goForward();
  $('web-external').onclick = () => webview && api.openExternal(webview.getURL());

  // ---------- citation details ----------

  const link = (text, url, className = '') =>
    el('a', { textContent: text, href: url, className, onclick: (e) => { e.preventDefault(); api.openExternal(url); } });

  function refBlock(text) {
    return el('details', { className: 'ref-text' }, el('summary', { textContent: 'Reference as printed' }), el('p', { textContent: text || '(no text found)' }));
  }

  function actions(paper, text, jump) {
    const query = paper?.title || text;
    return el('div', { className: 'actions' },
      jump ? el('button', { textContent: 'Jump to reference', onclick: jump }) : null,
      el('button', { textContent: 'Google Scholar', onclick: () => showSearch(query, 'scholar') }),
      el('button', { textContent: 'Google', onclick: () => showSearch(query) }),
      paper?.pdfUrl ? el('button', { textContent: 'Open PDF', onclick: () => api.openExternal(paper.pdfUrl) }) : null);
  }

  async function summaryBlock(paper, isCurrent) {
    const box = el('section', { className: 'summary' });
    const label = el('h3', { textContent: 'AI summary' });
    const body = el('p');
    box.append(label, body);
    const { hasOpenRouterKey: hasKey } = await settings;

    if (hasKey && paper.abstract) {
      body.textContent = paper.tldr || 'Summarizing…';
      body.classList.toggle('muted', !paper.tldr);
      const key = paper.doi || paper.title;
      if (!summaries.has(key)) summaries.set(key, api.summarize({ title: paper.title, abstract: paper.abstract }));
      summaries.get(key).then((res) => {
        if (!isCurrent()) return;
        if (res.summary) {
          body.textContent = res.summary;
          body.classList.remove('muted');
          label.textContent = `AI summary (${res.model || 'OpenRouter'})`;
        } else {
          summaries.delete(key);
          if (!paper.tldr) body.textContent = res.error || 'No summary available.';
          else box.append(el('p', { className: 'muted small', textContent: res.error || '' }));
        }
      });
    } else if (paper.tldr) {
      label.textContent = 'AI summary (Semantic Scholar TLDR)';
      body.textContent = paper.tldr;
    } else {
      body.className = 'muted';
      body.textContent = hasKey
        ? 'No abstract was found to summarize.'
        : 'No TLDR is available for this paper. Add an OpenRouter API key in Settings to generate summaries from abstracts.';
    }
    return box;
  }

  async function renderPaper(paper, text, jump, isCurrent) {
    const authors = paper.authors || [];
    const shown = authors.length > 8 ? `${authors.slice(0, 8).join(', ')}, et al.` : authors.join(', ');
    const meta = [paper.venue, paper.year, paper.citationCount != null ? `${paper.citationCount.toLocaleString()} citations` : null]
      .filter(Boolean)
      .join(' · ');
    const doiUrl = paper.doi ? `https://doi.org/${paper.doi}` : '';
    const ids = el('div', { className: 'ids' });
    if (paper.doi) {
      ids.append(el('span', { className: 'id-label', textContent: 'DOI' }), link(paper.doi, doiUrl),
        el('button', { className: 'tb small', textContent: 'Copy', onclick: (e) => { navigator.clipboard.writeText(paper.doi); e.target.textContent = 'Copied'; } }));
    } else {
      ids.append(el('span', { className: 'muted', textContent: 'No DOI found' }));
    }
    if (paper.arxiv) ids.append(el('span', { className: 'id-label', textContent: 'arXiv' }), link(paper.arxiv, `https://arxiv.org/abs/${paper.arxiv}`));

    const summary = await summaryBlock(paper, isCurrent);
    if (!isCurrent()) return;
    citeBody.replaceChildren(
      el('h2', { className: 'paper-title' }, link(paper.title, doiUrl || paper.url || SEARCH_URL.scholar(paper.title))),
      el('p', { className: 'authors', textContent: shown || 'Unknown authors' }),
      meta ? el('p', { className: 'meta', textContent: meta }) : null,
      ids,
      actions(paper, text, jump),
      summary,
      el('section', {}, el('h3', { textContent: 'Abstract' }),
        el('p', { className: paper.abstract ? 'abstract' : 'muted', textContent: paper.abstract || 'No abstract available from Semantic Scholar, OpenAlex or Crossref.' })),
      refBlock(text),
      el('p', { className: 'muted small', textContent: `Matched from the reference text via ${(paper.sources || []).join(', ')}. Check the title against the reference if it looks off.` })
    );
  }

  async function showCitation({ text, jump }) {
    const id = ++requestId;
    const isCurrent = () => id === requestId;
    $('panel-title').textContent = 'Cited paper';
    show('cite');
    citeBody.replaceChildren(
      el('p', { className: 'muted loading', textContent: 'Looking up this reference…' }),
      el('p', { className: 'ref-preview', textContent: text }),
      actions(null, text, jump)
    );
    citeBody.scrollTop = 0;

    if (!lookups.has(text)) lookups.set(text, api.lookupCitation(text));
    let paper;
    try {
      paper = await lookups.get(text);
    } catch (err) {
      paper = { found: false, error: err.message };
    }
    if (!paper.found) lookups.delete(text); // allow a retry on the next click
    if (!isCurrent()) return;

    if (paper.found) return renderPaper(paper, text, jump, isCurrent);
    citeBody.replaceChildren(
      el('h2', { className: 'paper-title', textContent: 'No match found' }),
      el('p', { className: 'muted', textContent: paper.error
        ? `The lookup failed (${paper.error}). Check your connection and click the citation again.`
        : 'None of the scholarly indexes matched this reference. Try a web search instead.' }),
      el('p', { className: 'ref-preview', textContent: text }),
      actions(paper.titleGuess ? { title: paper.titleGuess } : null, text, jump)
    );
  }

  // ---------- translations ----------

  const LANGUAGES = ['Chinese (Simplified)', 'Chinese (Traditional)', 'English', 'Japanese', 'Korean', 'Spanish', 'French', 'German', 'Portuguese', 'Russian', 'Arabic', 'Hindi'];
  const langSelect = $('trans-lang');
  langSelect.append(
    el('option', { value: 'auto', textContent: 'Auto: English ⇄ Chinese' }),
    ...LANGUAGES.map((name) => el('option', { value: name, textContent: name }))
  );
  settings.then((s) => {
    if (s.translateLang !== 'auto' && !LANGUAGES.includes(s.translateLang)) langSelect.append(el('option', { value: s.translateLang, textContent: s.translateLang }));
    langSelect.value = s.translateLang;
  });
  langSelect.onchange = async () => {
    await api.setSettings({ translateLang: langSelect.value });
    settings = api.getSettings();
  };

  function updateTransTab() {
    transTab.hidden = !translations.length || panel.dataset.mode === 'translate';
    transTab.textContent = `Translations (${translations.length})`;
    $('trans-empty').hidden = translations.length > 0;
  }
  transTab.onclick = () => showTranslations();

  function showTranslations() {
    $('panel-title').textContent = 'Translations';
    show('translate');
  }

  function clearTranslations() {
    if (!translations.length) return;
    translations = [];
    transList.replaceChildren();
    ctx.annotations?.removeTemp();
    updateTransTab();
  }

  function removeTranslation(item) {
    translations = translations.filter((t) => t !== item);
    item.card.remove();
    ctx.annotations.removeTemp(item.id);
    updateTransTab();
  }

  async function runTranslation(item) {
    const out = item.card.querySelector('.trans-out');
    out.className = 'trans-out muted loading';
    out.textContent = langSelect.value === 'auto' ? 'Translating…' : `Translating to ${langSelect.value}…`;
    let res;
    try {
      res = await api.translate(item.text);
    } catch (err) {
      res = { error: err.message };
    }
    if (!translations.includes(item)) return;
    out.className = res.translation ? 'trans-out' : 'trans-out muted';
    out.textContent = res.translation || res.error || 'No translation returned.';
    item.card.querySelector('.trans-engine').textContent = res.translation ? res.engine || '' : '';
    item.card.querySelector('.trans-retry').hidden = Boolean(res.translation);
  }

  // `selection` is { text, byPage } from the PDF: its passage stays highlighted while the card exists.
  function translate(selection) {
    const item = { id: crypto.randomUUID(), text: selection.text };
    const page = Math.min(...selection.byPage.keys());
    const source = el('p', { className: 'trans-src', textContent: selection.text, title: 'Show this passage in the PDF' });
    source.onclick = () => ctx.annotations.scrollToTemp(item.id);
    item.card = el('article', { className: 'trans-card' },
      el('div', { className: 'trans-head' },
        el('span', { className: 'muted small', textContent: `Page ${page}` }),
        el('span', { className: 'muted small trans-engine' }),
        el('span', { className: 'spacer' }),
        el('button', { className: 'tb small trans-retry', textContent: 'Retry', hidden: true, onclick: () => runTranslation(item) }),
        el('button', { className: 'tb small', textContent: 'Copy', title: 'Copy the translation', onclick: () => navigator.clipboard.writeText(item.card.querySelector('.trans-out').textContent) }),
        el('button', { className: 'tb small', textContent: '✕', title: 'Remove this translation', onclick: () => removeTranslation(item) })),
      source,
      el('p', { className: 'trans-out' }));
    translations.push(item);
    transList.append(item.card);
    ctx.annotations.addTemp(item.id, selection.byPage);
    showTranslations();
    item.card.scrollIntoView({ block: 'nearest' });
    runTranslation(item);
  }

  return {
    showCitation,
    showSearch,
    translate,
    clearTranslations,
    toggle: () => (panel.hidden ? show(panel.dataset.mode || 'cite') : hide()),
    settingsChanged: () => {
      settings = api.getSettings();
      lookups.clear();
      summaries.clear();
    },
  };
}
