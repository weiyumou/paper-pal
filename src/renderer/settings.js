// Settings dialog (API keys, summary model, tool shortcuts) and the shortcut listeners themselves.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const MOUSE_NAMES = { 1: 'middle button', 3: 'side button (back)', 4: 'side button (forward)' };

function bindingLabel(b) {
  if (!b) return 'Not set';
  if (b.type === 'mouse') return `Mouse ${MOUSE_NAMES[b.button] || `button ${b.button + 1}`}`;
  return `Key ${b.code.replace(/^Key|^Digit/, '')}`;
}

const sameBinding = (a, b) => a && b && a.type === b.type && a.button === b.button && a.code === b.code;

export function initSettings(ctx) {
  const { api } = ctx;
  const dialog = $('settings');
  const search = $('model-search');
  const list = $('model-list');

  let bindings = {}; // { select, marker } in effect
  let draft = {}; // edits made in the open dialog
  let models = null;
  let capturing = null; // tool whose shortcut is being recorded

  api.getSettings().then((s) => (bindings = s.bindings || {}));

  // ---------- model picker ----------

  const price = (n) => (n == null ? '?' : n === 0 ? 'free' : `$${n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 1 : 0)}`);

  function renderModels() {
    if (!models) return;
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = models.filter((m) => {
      const hay = `${m.id} ${m.name}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    $('model-count').textContent = `${matches.length} of ${models.length} models`;
    list.replaceChildren(
      ...matches.slice(0, 200).map((m) => {
        const row = el('button', { type: 'button', className: `model-row${m.id === draft.model ? ' selected' : ''}` },
          el('span', { className: 'model-name', textContent: m.name }),
          el('span', { className: 'model-meta', textContent: `${m.id} · in ${price(m.inputPrice)} / out ${price(m.outputPrice)} per 1M tokens` }));
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(m.id === draft.model));
        row.onclick = () => {
          draft.model = m.id;
          $('model-current').textContent = m.id;
          renderModels();
        };
        return row;
      })
    );
    if (!matches.length) list.append(el('p', { className: 'hint', textContent: 'No model matches that search.' }));
  }

  async function loadModels() {
    if (models) return renderModels();
    list.replaceChildren(el('p', { className: 'hint', textContent: 'Loading models from OpenRouter…' }));
    try {
      models = await api.listModels();
      renderModels();
    } catch (err) {
      list.replaceChildren(el('p', { className: 'hint', textContent: `Could not load the model list (${err.message}). The saved model is still used.` }));
    }
  }
  search.addEventListener('input', renderModels);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault(); // don't submit the dialog while searching
  });

  // ---------- shortcut capture ----------

  function renderBindings() {
    for (const tool of ['select', 'marker']) {
      const btn = $(`bind-${tool}`);
      btn.textContent = capturing === tool ? 'Press a mouse button or key… (Esc cancels)' : bindingLabel(draft.bindings[tool]);
      btn.classList.toggle('capturing', capturing === tool);
    }
  }

  function record(binding) {
    const tool = capturing;
    const other = tool === 'select' ? 'marker' : 'select';
    capturing = null;
    draft.bindings[tool] = binding;
    if (sameBinding(binding, draft.bindings[other])) draft.bindings[other] = null;
    renderBindings();
  }

  for (const tool of ['select', 'marker']) {
    $(`bind-${tool}`).onclick = () => {
      capturing = tool;
      renderBindings();
    };
    $(`unbind-${tool}`).onclick = () => {
      capturing = null;
      draft.bindings[tool] = null;
      renderBindings();
    };
  }

  // While recording, the next mouse button (other than plain left/right click) or key becomes the shortcut.
  dialog.addEventListener('mousedown', (e) => {
    if (!capturing || e.button === 0 || e.button === 2) return;
    e.preventDefault();
    e.stopPropagation();
    record({ type: 'mouse', button: e.button });
  }, true);
  dialog.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    if (e.key === 'Escape') {
      capturing = null;
      return renderBindings();
    }
    record({ type: 'key', code: e.code });
  }, true);
  dialog.addEventListener('cancel', (e) => capturing && e.preventDefault());

  // ---------- applying shortcuts ----------

  const toolFor = (binding) => ['select', 'marker'].find((tool) => sameBinding(bindings[tool], binding));

  // Side buttons would otherwise trigger back/forward navigation, so swallow every phase of the click.
  for (const type of ['mousedown', 'mouseup', 'auxclick']) {
    window.addEventListener(type, (e) => {
      if (dialog.open || e.button === 0 || e.button === 2) return;
      const tool = toolFor({ type: 'mouse', button: e.button });
      if (!tool) return;
      e.preventDefault();
      e.stopPropagation();
      if (type === 'mousedown') ctx.annotations.setTool(tool);
    }, true);
  }
  window.addEventListener('keydown', (e) => {
    if (dialog.open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, [contenteditable]')) return;
    const tool = toolFor({ type: 'key', code: e.code });
    if (!tool) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.annotations.setTool(tool);
  }, true);

  // ---------- dialog ----------

  async function open() {
    const s = await api.getSettings();
    draft = { model: s.model, bindings: { ...(s.bindings || {}) } };
    capturing = null;
    $('key-openrouter').value = '';
    $('key-s2').value = '';
    $('openrouter-state').textContent = s.hasOpenRouterKey ? 'saved' : 'not set';
    $('s2-state').textContent = s.hasS2Key ? 'saved' : 'not set';
    $('model-current').textContent = s.model;
    search.value = '';
    renderBindings();
    dialog.showModal();
    loadModels();
  }

  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'save') return;
    const patch = { model: draft.model, bindings: draft.bindings };
    if ($('key-openrouter').value.trim()) patch.openRouterKey = $('key-openrouter').value;
    if ($('key-s2').value.trim()) patch.s2Key = $('key-s2').value;
    await api.setSettings(patch);
    bindings = draft.bindings;
    ctx.panel.settingsChanged();
  });

  $('settings-clear').onclick = async () => {
    await api.setSettings({ openRouterKey: '', s2Key: '' });
    ctx.panel.settingsChanged();
    dialog.close('cancel');
  };

  return { open };
}
