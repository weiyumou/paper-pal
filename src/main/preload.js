const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  ready: () => ipcRenderer.invoke('renderer:ready'),
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  readPdf: (file) => ipcRenderer.invoke('pdf:read', file),
  loadAnnotations: (id) => ipcRenderer.invoke('annotations:load', id),
  saveAnnotations: (id, data) => ipcRenderer.invoke('annotations:save', id, data),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listModels: () => ipcRenderer.invoke('models:list'),
  lookupCitation: (text) => ipcRenderer.invoke('citation:lookup', text),
  translate: (text) => ipcRenderer.invoke('text:translate', text),
  summarize: (paper) => ipcRenderer.invoke('citation:summarize', paper),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  exportMarkdown: (name, markdown) => ipcRenderer.invoke('export:markdown', name, markdown),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, file) => cb(file)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
});
