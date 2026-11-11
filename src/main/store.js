// Persistence: per-PDF annotation files and app settings, all under Electron's userData dir.
const { app, safeStorage } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const dir = () => app.getPath('userData');
const annotationPath = (id) => path.join(dir(), 'annotations', `${id}.json`);
const settingsPath = () => path.join(dir(), 'settings.json');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write to a temp file then rename, so a crash mid-save never truncates existing notes.
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 1));
  await fs.rename(tmp, file);
}

const isId = (id) => typeof id === 'string' && /^[a-f0-9]{16,64}$/.test(id);

async function loadAnnotations(id) {
  if (!isId(id)) return null;
  return readJson(annotationPath(id), null);
}

async function saveAnnotations(id, data) {
  if (!isId(id)) throw new Error('bad document id');
  await writeJson(annotationPath(id), data);
}

let settingsCache = null;
async function getSettings() {
  settingsCache ??= await readJson(settingsPath(), {});
  return settingsCache;
}

async function updateSettings(patch) {
  const s = await getSettings();
  Object.assign(s, patch);
  await writeJson(settingsPath(), s);
  return s;
}

// API keys are encrypted with the OS keychain when available.
async function encodeSecret(value) {
  if (!value) return null;
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    return { enc: (await safeStorage.encryptStringAsync(value)).toString('base64') };
  }
  return { plain: value };
}

// Resolves to { value, stale }: `stale` means the keychain key was rotated and the secret should be saved again.
async function decodeSecret(stored) {
  if (!stored) return { value: '' };
  try {
    if (stored.enc) {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(stored.enc, 'base64'));
      return { value: result, stale: shouldReEncrypt };
    }
  } catch {
    return { value: '' };
  }
  return { value: stored.plain || '' };
}

async function getSecret(name) {
  const s = await getSettings();
  const { value, stale } = await decodeSecret(s.secrets?.[name]);
  if (stale && value) await setSecret(name, value);
  return value;
}

async function setSecret(name, value) {
  const s = await getSettings();
  const encoded = await encodeSecret(value);
  const secrets = { ...(s.secrets || {}) };
  if (encoded) secrets[name] = encoded;
  else delete secrets[name];
  await updateSettings({ secrets });
}

async function addRecent(file) {
  const s = await getSettings();
  const recent = [file, ...(s.recent || []).filter((f) => f !== file)].slice(0, 10);
  await updateSettings({ recent, lastFile: file });
}

module.exports = {
  loadAnnotations,
  saveAnnotations,
  getSettings,
  updateSettings,
  getSecret,
  setSecret,
  addRecent,
};
