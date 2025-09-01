const { contextBridge, ipcRenderer } = require('electron');

// Expose a secure API to the renderer process.
contextBridge.exposeInMainWorld('electronAPI', {
  // renderer -> main
  send: (channel, data) => ipcRenderer.send(channel, data),
  saveFile: (relativePath, uint8Data) => ipcRenderer.send('save-file', { relativePath, data: uint8Data }),
  log: (level, ...args) => ipcRenderer.send('renderer-log', { level, args }),
  listModels: () => ipcRenderer.invoke('list-models'),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
  isSelfTest: () => {
    try { return process?.env?.LR_SELFTEST === '1'; } catch { return false; }
  },
  getVersion: () => ipcRenderer.invoke('get-version'),
  // main -> renderer
  onTrackInfo: (callback) => ipcRenderer.on('track-info', (_event, value) => callback(value))
});
