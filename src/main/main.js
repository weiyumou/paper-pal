const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, protocol, session, shell, webContents } = require('electron');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const store = require('./store');
const { lookup, webLookup } = require('./lookup');
const { findBibtex } = require('./bibtex');
const { summarize, translate, listModels, generateToc, DEFAULT_MODEL } = require('./summarize');

const ROOT = path.resolve(__dirname, '..', '..');
// The renderer is served from app://paper-pal/ so ES modules, fetch and workers behave like on the web.
const SERVED = [path.join(ROOT, 'src', 'renderer'), path.join(ROOT, 'node_modules', 'pdfjs-dist')];
const INDEX_URL = 'app://paper-pal/src/renderer/index.html';

app.setName('Paper Pal');
// Keep one data folder whether the app runs from source or as the packaged Paper Pal.app,
// so notes and settings carry over between the two.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'paper-pal'));
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win = null;
let pendingFile = null; // file requested before the renderer was ready

const isHttpUrl = (url) => /^https?:\/\//i.test(url || '');

const DEFAULT_LANGUAGE = 'auto'; // English ⇄ Chinese, by the language of the selected text

// Tool shortcuts: by default the mouse's two side buttons switch between selecting and marking.
const DEFAULT_BINDINGS = { select: { type: 'mouse', button: 3 }, marker: { type: 'mouse', button: 4 } };
function cleanBinding(b) {
  if (b?.type === 'mouse' && Number.isInteger(b.button)) return { type: 'mouse', button: b.button };
  if (b?.type === 'key' && typeof b.code === 'string') return { type: 'key', code: b.code.slice(0, 40) };
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 500,
    title: 'Paper Pal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      webviewTag: true, // the search panel embeds real web pages
    },
  });
  win.loadURL(INDEX_URL);
  win.on('closed', () => (win = null));

  // Links inside a PDF open in the default browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== INDEX_URL) e.preventDefault();
  });
  // Lock down the embedded search webview: no preload, no node.
  win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (!isHttpUrl(params.src)) e.preventDefault();
  });
}

function sendOpen(file) {
  if (win && !win.webContents.isLoading()) win.webContents.send('open-file', file);
  else pendingFile = file;
}

async function openDialog() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return res.canceled ? null : res.filePaths[0];
}

async function buildMenu() {
  const { recent = [] } = await store.getSettings();
  const send = (action) => () => win?.webContents.send('menu', action);
  // Undo and redo go to the app (marks and notes) unless the search panel's web page has focus.
  const edit = (action) => () => {
    const focused = webContents.getFocusedWebContents();
    if (focused && win && focused !== win.webContents) focused[action]();
    else win?.webContents.send('menu', action);
  };
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const file = await openDialog();
            if (file) sendOpen(file);
          },
        },
        {
          label: 'Open Recent',
          enabled: recent.length > 0,
          submenu: recent.map((file) => ({ label: path.basename(file), toolTip: file, click: () => sendOpen(file) })),
        },
        { type: 'separator' },
        { label: 'Export Notes as Markdown…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: edit('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: edit('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: send('find') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+0', click: send('fit-width') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('toggle-sidebar') },
        { label: 'Toggle Right Panel', accelerator: 'CmdOrCtrl+Shift+B', click: send('toggle-panel') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('dialog:open', openDialog);

  ipcMain.handle('renderer:ready', async () => {
    const file = pendingFile || (await store.getSettings()).lastFile || null;
    pendingFile = null;
    return file;
  });

  ipcMain.handle('pdf:read', async (_e, file) => {
    if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.pdf') {
      throw new Error('Not a PDF file');
    }
    const data = await fs.readFile(file);
    // Annotations are keyed by content hash, so they survive renaming or moving the PDF.
    const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 32);
    await store.addRecent(file);
    buildMenu();
    return { id, name: path.basename(file), path: file, data };
  });

  ipcMain.handle('annotations:load', (_e, id) => store.loadAnnotations(id));
  ipcMain.handle('annotations:save', (_e, id, data) => store.saveAnnotations(id, data));

  ipcMain.handle('settings:get', async () => {
    const s = await store.getSettings();
    return {
      hasOpenRouterKey: Boolean(await store.getSecret('openrouter')),
      hasS2Key: Boolean(await store.getSecret('s2')),
      model: s.model || DEFAULT_MODEL,
      bindings: s.bindings || DEFAULT_BINDINGS,
      translateLang: s.translateLang || DEFAULT_LANGUAGE,
    };
  });
  // An empty string clears a key; undefined leaves a setting untouched.
  ipcMain.handle('settings:set', async (_e, { openRouterKey, s2Key, model, bindings, translateLang } = {}) => {
    if (typeof translateLang === 'string' && translateLang.trim()) {
      await store.updateSettings({ translateLang: translateLang.trim().slice(0, 60) });
    }
    if (typeof openRouterKey === 'string') await store.setSecret('openrouter', openRouterKey.trim());
    if (typeof s2Key === 'string') await store.setSecret('s2', s2Key.trim());
    if (typeof model === 'string' && model.trim()) await store.updateSettings({ model: model.trim() });
    if (bindings && typeof bindings === 'object') {
      await store.updateSettings({ bindings: { select: cleanBinding(bindings.select), marker: cleanBinding(bindings.marker) } });
    }
  });

  ipcMain.handle('models:list', () => listModels());

  ipcMain.handle('citation:lookup', async (_e, text) => lookup(String(text || ''), { s2Key: await store.getSecret('s2') }));

  // { apiKey, model } for the optional AI features, or null without an OpenRouter key.
  const aiConfig = async () => {
    const apiKey = await store.getSecret('openrouter');
    return apiKey ? { apiKey, model: (await store.getSettings()).model || DEFAULT_MODEL } : null;
  };

  ipcMain.handle('citation:web', async (_e, text) => {
    const ai = await aiConfig();
    if (!ai) return { found: false, error: 'no-key' };
    return webLookup(String(text || '').slice(0, 2000), { ...ai, s2Key: await store.getSecret('s2') });
  });

  ipcMain.handle('paper:bibtex', async (_e, info, useAi) =>
    findBibtex(info || {}, { s2Key: await store.getSecret('s2'), ai: useAi ? await aiConfig() : null }));

  ipcMain.handle('toc:generate', async (_e, input) => {
    const ai = await aiConfig();
    if (!ai) return { error: 'no-key' };
    const lines = (Array.isArray(input?.lines) ? input.lines : []).slice(0, 2000).map((l) => ({
      id: Number(l.id),
      page: Number(l.page),
      size: Number(l.size),
      text: String(l.text || '').slice(0, 200),
    }));
    return generateToc(ai.apiKey, ai.model, { bodySize: Number(input?.bodySize) || 10, lines });
  });

  ipcMain.handle('citation:summarize', async (_e, paper) => {
    const apiKey = await store.getSecret('openrouter');
    if (!apiKey) return { error: 'no-key' };
    const { model } = await store.getSettings();
    return summarize(apiKey, model || DEFAULT_MODEL, paper || {});
  });

  ipcMain.handle('text:translate', async (_e, text) => {
    const apiKey = await store.getSecret('openrouter');
    const { model, translateLang } = await store.getSettings();
    return translate(apiKey, model || DEFAULT_MODEL, String(text || '').slice(0, 20000), translateLang || DEFAULT_LANGUAGE);
  });

  // Copying from the main process works even when the window lost focus during a slow lookup.
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text || '')));

  ipcMain.handle('shell:open', (_e, url) => {
    if (isHttpUrl(url)) shell.openExternal(url);
  });

  ipcMain.handle('export:markdown', async (_e, name, markdown) => {
    const res = await dialog.showSaveDialog(win, {
      defaultPath: `${String(name || 'notes').replace(/\.pdf$/i, '')}-notes.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled) return false;
    await fs.writeFile(res.filePath, String(markdown));
    return true;
  });
}

// macOS: file opened via Finder / "Open With".
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (app.isReady() && !win) createWindow();
  sendOpen(file);
});

// Pop-ups from pages in the search panel load in the panel itself instead of new windows.
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) contents.loadURL(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    const file = path.normalize(path.join(ROOT, decodeURIComponent(new URL(request.url).pathname)));
    if (!SERVED.some((dir) => file.startsWith(dir + path.sep))) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });

  // Present the search panel as a normal Chrome so sites serve their regular pages.
  const searchSession = session.fromPartition('persist:search');
  searchSession.setUserAgent(
    searchSession.getUserAgent().replace(/\s(Electron|paper-pal)\/\S+/gi, '')
  );

  const cliFile = process.argv.slice(1).find((a) => /\.pdf$/i.test(a));
  if (cliFile) pendingFile = path.resolve(cliFile);

  registerIpc();
  await buildMenu();
  createWindow();
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
