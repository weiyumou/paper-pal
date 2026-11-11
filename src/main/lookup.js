// Resolve a raw bibliography entry ("[12] Vaswani et al. Attention is all you need. NeurIPS 2017")
// to paper metadata. No API keys needed: Crossref matches the raw string to a DOI, then
// Semantic Scholar (abstract + TLDR) and OpenAlex (abstract fallback) fill in the details.

const UA = 'PaperPal/0.1 (desktop PDF reader)';
const S2_FIELDS = 'title,authors,year,venue,abstract,tldr,externalIds,url,openAccessPdf,citationCount';

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const quiet = (promise) => promise.catch(() => null);

// ---------- text helpers ----------

const tokens = (s) =>
  (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

// How much of `title` appears in the reference text (0..1).
function titleCoverage(title, refText) {
  const t = tokens(title);
  if (t.length < 2) return 0;
  const ref = new Set(tokens(refText));
  return t.filter((w) => ref.has(w)).length / t.length;
}

function cleanReference(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*(\[[^\]]{1,12}\]|\(?\d{1,3}[.)])\s*/, '')
    .trim();
}

function extractIds(text) {
  const out = {};
  const doi = text.match(/\b10\.\d{4,9}\/[^\s"<>,;]+/);
  if (doi) out.doi = doi[0].replace(/[.)\]]+$/, '');
  const arxiv = text.match(/arxiv(?:\.org\/(?:abs|pdf)\/|:\s*|\s+preprint\s+arxiv:\s*)(\d{4}\.\d{4,5})/i);
  if (arxiv) out.arxiv = arxiv[1];
  return out;
}

// Best-effort guess at the title inside a reference string, for title-search fallbacks.
function guessTitle(ref) {
  const quoted = ref.match(/[“"]([^”"]{15,})[”"]/);
  if (quoted) return quoted[1].replace(/[.,]$/, '');
  const venueLike = /^(in\s|proceedings|proc\.|journal|arxiv|advances in|corr\b|pp\.|vol\.|https?:|doi)/i;
  const authorLike = (s) =>
    /\bet al\b/i.test(s) || /(^|\s)[A-Z]\.(\s|$)/.test(s) || (s.match(/,/g) || []).length >= 3 || /\sand\s[A-Z]/.test(s);
  const parts = ref
    .replace(/\((19|20)\d\d[a-z]?\)\.?/g, '. ')
    .split(/[.?!]\s+/)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= 3);
  const candidates = parts.filter((p) => !venueLike.test(p) && !authorLike(p));
  return candidates[0] || parts[1] || parts[0] || ref.slice(0, 200);
}

// ---------- sources ----------

function fromS2(p) {
  if (!p || !p.title) return null;
  return {
    title: p.title,
    authors: (p.authors || []).map((a) => a.name),
    year: p.year || null,
    venue: p.venue || '',
    abstract: p.abstract || '',
    tldr: p.tldr?.text || '',
    doi: p.externalIds?.DOI || '',
    arxiv: p.externalIds?.ArXiv || '',
    url: p.url || '',
    pdfUrl: p.openAccessPdf?.url || '',
    citationCount: p.citationCount ?? null,
    sources: ['Semantic Scholar'],
  };
}

async function s2Get(pathAndQuery, s2Key) {
  const url = `https://api.semanticscholar.org/graph/v1/${pathAndQuery}`;
  const headers = s2Key ? { 'x-api-key': s2Key } : {};
  try {
    return await getJson(url, headers);
  } catch (err) {
    // The keyless pool is shared and often rate-limited; one short retry, then give up.
    if (err.status !== 429) return null;
    await new Promise((r) => setTimeout(r, 1200));
    return quiet(getJson(url, headers));
  }
}

const s2Paper = async (id, key) => fromS2(await s2Get(`paper/${encodeURIComponent(id)}?fields=${S2_FIELDS}`, key));

async function s2TitleMatch(title, key) {
  const data = await s2Get(`paper/search/match?query=${encodeURIComponent(title)}&fields=${S2_FIELDS}`, key);
  return fromS2(data?.data?.[0]);
}

function fromOpenAlex(w) {
  if (!w || !w.title) return null;
  let abstract = '';
  if (w.abstract_inverted_index) {
    const words = [];
    for (const [word, positions] of Object.entries(w.abstract_inverted_index)) {
      for (const pos of positions) words[pos] = word;
    }
    abstract = words.join(' ').replace(/\s+/g, ' ').trim();
  }
  return {
    title: w.title,
    authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year || null,
    venue: w.primary_location?.source?.display_name || '',
    abstract,
    tldr: '',
    doi: (w.doi || '').replace(/^https?:\/\/doi\.org\//i, ''),
    arxiv: '',
    url: w.id || '',
    pdfUrl: w.open_access?.oa_url || '',
    citationCount: w.cited_by_count ?? null,
    sources: ['OpenAlex'],
  };
}

const openAlexByDoi = async (doi) =>
  fromOpenAlex(await quiet(getJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`)));

async function openAlexSearch(title) {
  const data = await quiet(
    getJson(`https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=3`)
  );
  return (data?.results || []).map(fromOpenAlex).filter(Boolean);
}

function fromCrossref(item) {
  if (!item || !item.title?.[0]) return null;
  return {
    title: item.title[0],
    authors: (item.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
    year: item.issued?.['date-parts']?.[0]?.[0] || null,
    venue: item['container-title']?.[0] || '',
    abstract: (item.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    tldr: '',
    doi: item.DOI || '',
    arxiv: '',
    url: item.URL || '',
    pdfUrl: '',
    citationCount: item['is-referenced-by-count'] ?? null,
    sources: ['Crossref'],
  };
}

async function crossrefMatch(ref) {
  const data = await quiet(
    getJson(`https://api.crossref.org/works?rows=3&query.bibliographic=${encodeURIComponent(ref.slice(0, 600))}`)
  );
  const items = (data?.message?.items || []).map(fromCrossref).filter(Boolean);
  return items.find((it) => titleCoverage(it.title, ref) >= 0.8) || null;
}

const crossrefByDoi = async (doi) =>
  fromCrossref((await quiet(getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)))?.message);

// Later sources only fill fields the earlier ones left empty.
function merge(...metas) {
  const out = {};
  for (const m of metas.filter(Boolean)) {
    for (const [k, v] of Object.entries(m)) {
      if (k === 'sources') out.sources = [...new Set([...(out.sources || []), ...v])];
      else if (out[k] == null || out[k] === '' || (Array.isArray(out[k]) && !out[k].length)) out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

async function byDoi(doi, s2Key, known) {
  const s2 = await s2Paper(`DOI:${doi}`, s2Key);
  const oa = s2?.abstract ? null : await openAlexByDoi(doi);
  const cr = known || (s2 || oa ? null : await crossrefByDoi(doi));
  return merge(s2, oa, cr);
}

async function lookup(rawText, { s2Key } = {}) {
  const ref = cleanReference(rawText);
  if (ref.length < 8) return { found: false, query: ref };
  const ids = extractIds(ref);
  let meta = null;

  if (ids.doi) meta = await byDoi(ids.doi, s2Key);
  if (!meta && ids.arxiv) {
    meta = merge(await s2Paper(`ARXIV:${ids.arxiv}`, s2Key), await openAlexByDoi(`10.48550/arXiv.${ids.arxiv}`));
    if (meta && !meta.arxiv) meta.arxiv = ids.arxiv;
  }
  if (!meta) {
    const cr = await crossrefMatch(ref);
    if (cr) meta = await byDoi(cr.doi, s2Key, cr);
  }
  if (!meta) {
    // No DOI-registered match (common for arXiv-only and some conference papers): search by title.
    const title = guessTitle(ref);
    const accept = (m) => m && titleCoverage(m.title, ref) >= 0.8;
    const s2 = await s2TitleMatch(title, s2Key);
    if (accept(s2)) meta = s2;
    else meta = (await openAlexSearch(title)).find(accept) || null;
  }

  if (!meta) return { found: false, query: ref, titleGuess: guessTitle(ref) };
  // arXiv DOIs embed the arXiv id.
  const fromDoi = (meta.doi || '').match(/^10\.48550\/arxiv\.(.+)$/i);
  if (!meta.arxiv && fromDoi) meta.arxiv = fromDoi[1];
  return { found: true, query: ref, ...meta };
}

module.exports = { lookup, guessTitle, cleanReference, titleCoverage };
