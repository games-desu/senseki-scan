const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadTemplates: () => ipcRenderer.invoke('load-templates'),
  appendUserTemplates: (sets) => ipcRenderer.invoke('append-user-templates', sets),
  saveCsv: (defaultName, content) => ipcRenderer.invoke('save-csv', defaultName, content),
  loadUserData: (key) => ipcRenderer.invoke('load-user-data', key),
  saveUserData: (key, data) => ipcRenderer.invoke('save-user-data', key, data),
  appVersion: () => ipcRenderer.invoke('app-version'),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (ev, version) => cb(version)),
});
