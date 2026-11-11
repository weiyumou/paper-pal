import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.mjs';
import { initAnnotations } from './annotations.js';
import { initCitations } from './citations.js';
import { initPanel } from './panel.js';
import { initSettings } from './settings.js';

// pdf_viewer.mjs reads the core library from a global, so it has to load after this assignment.
globalThis.pdfjsLib = pdfjsLib;
const { EventBus, PDFViewer, PDFLinkService, PDFFindController, LinkTarget } = await import(
  '../../node_modules/pdfjs-dist/web/pdf_viewer.mjs'
);

const PDFJS = new URL('../../node_modules/pdfjs-dist/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}build/pdf.worker.mjs`;

const $ = (id) => document.getElementById(id);
const api = window.api;

const container = $('viewerContainer');
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
const findController = new PDFFindController({ eventBus, linkService });
const pdfViewer = new PDFViewer({ container, viewer: $('viewer'), eventBus, linkService, findController });
linkService.setViewer(pdfViewer);

// Shared context for the feature modules.
const ctx = { api, container, eventBus, linkService, pdfViewer, doc: null, panel: null, annotations: null };
ctx.panel = initPanel(ctx);
ctx.annotations = initAnnotations(ctx);
initCitations(ctx);
const settings = initSettings(ctx);

// ---------- opening documents ----------

let loadingTask = null;

async function openFile(file) {
  if (!file) return;
  let read;
  try {
    read = await api.readPdf(file);
  } catch (err) {
    if (ctx.doc) alert(`Could not open ${file}\n${err.message}`);
    return;
  }
  await ctx.annotations.flush();
  ctx.panel.clearTranslations();
  await loadingTask?.destroy().catch(() => {});

  loadingTask = pdfjsLib.getDocument({
    data: read.data,
    cMapUrl: `${PDFJS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}standard_fonts/`,
    wasmUrl: `${PDFJS}wasm/`,
    iccUrl: `${PDFJS}iccs/`,
  });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    alert(`Could not read ${read.name}\n${err.message}`);
    return;
  }

  ctx.doc = { id: read.id, name: read.name, path: read.path, pdf };
  await ctx.annotations.load(ctx.doc);
  pdfViewer.setDocument(pdf);
  linkService.setDocument(pdf, null);

  $('empty').hidden = true;
  $('doc-title').textContent = read.name;
  $('doc-title').title = read.path;
  $('page-count').textContent = `/ ${pdf.numPages}`;
  document.title = `${read.name} — Paper Pal`;
}

const pageInput = $('page-input');
eventBus.on('pagesinit', () => {
  const view = ctx.annotations.savedView();
  pdfViewer.currentScaleValue = view?.scale || 'page-width';
  if (view?.page > 1) pdfViewer.currentPageNumber = view.page;
  pageInput.value = pdfViewer.currentPageNumber;
  ctx.annotations.viewRestored();
});

async function chooseFile() {
  openFile(await api.openDialog());
}
$('btn-open').onclick = chooseFile;
$('btn-open-empty').onclick = chooseFile;
api.onOpenFile(openFile);

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find((f) => /\.pdf$/i.test(f.name));
  if (file) openFile(api.pathForFile(file));
});

// ---------- page and zoom controls ----------

eventBus.on('pagechanging', (e) => (pageInput.value = e.pageNumber));
pageInput.addEventListener('change', () => {
  const n = parseInt(pageInput.value, 10);
  if (n >= 1 && n <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = n;
  else pageInput.value = pdfViewer.currentPageNumber;
});
pageInput.addEventListener('focus', () => pageInput.select());

eventBus.on('scalechanging', (e) => ($('zoom-label').textContent = `${Math.round(e.scale * 100)}%`));
const zoomIn = () => pdfViewer.increaseScale();
const zoomOut = () => pdfViewer.decreaseScale();
const fitWidth = () => (pdfViewer.currentScaleValue = 'page-width');
$('btn-zoom-in').onclick = zoomIn;
$('btn-zoom-out').onclick = zoomOut;
$('btn-fit').onclick = fitWidth;

// Trackpad pinch and ctrl/cmd + wheel zoom around the pointer.
container.addEventListener(
  'wheel',
  (e) => {
    if (!(e.ctrlKey || e.metaKey) || !ctx.doc) return;
    e.preventDefault();
    const scaleFactor = Math.exp(-e.deltaY / 120);
    pdfViewer.updateScale({ scaleFactor, drawingDelay: 300, origin: [e.clientX, e.clientY] });
  },
  { passive: false }
);

// Keep "fit width" fitted when the window or side panels change size.
new ResizeObserver(() => {
  if (ctx.doc && pdfViewer.currentScaleValue === 'page-width') fitWidth();
}).observe(container);

// ---------- find ----------

const findInput = $('find-input');
function find(findPrevious = false, again = true) {
  eventBus.dispatch('find', {
    source: window,
    type: again ? 'again' : '',
    query: findInput.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}
function openFind() {
  $('findbar').hidden = false;
  findInput.focus();
  findInput.select();
}
function closeFind() {
  $('findbar').hidden = true;
  $('find-count').textContent = '';
  eventBus.dispatch('findbarclose', { source: window });
}
findInput.addEventListener('input', () => find(false, false));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') find(e.shiftKey);
  if (e.key === 'Escape') closeFind();
});
$('find-next').onclick = () => find(false);
$('find-prev').onclick = () => find(true);
$('find-close').onclick = closeFind;
$('btn-find').onclick = openFind;
eventBus.on('updatefindmatchescount', ({ matchesCount }) => {
  $('find-count').textContent = matchesCount.total ? `${matchesCount.current} of ${matchesCount.total}` : 'No matches';
});

// ---------- sidebar, settings, menu ----------

const sidebar = $('sidebar');
function toggleSidebar() {
  sidebar.hidden = !sidebar.hidden;
  localStorage.setItem('sidebar', sidebar.hidden ? '0' : '1');
}
sidebar.hidden = localStorage.getItem('sidebar') !== '1';
$('btn-sidebar').onclick = toggleSidebar;

$('btn-settings').onclick = settings.open;

api.onMenu((action) => {
  const actions = {
    find: openFind,
    'zoom-in': zoomIn,
    'zoom-out': zoomOut,
    'fit-width': fitWidth,
    'toggle-sidebar': toggleSidebar,
    'toggle-panel': () => ctx.panel.toggle(),
    settings: settings.open,
    export: () => ctx.annotations.exportMarkdown(),
  };
  actions[action]?.();
});

// Reopen the last document (or the one the app was launched with).
openFile(await api.ready());
