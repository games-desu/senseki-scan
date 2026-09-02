const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadTemplates: () => ipcRenderer.invoke('load-templates'),
  appendUserTemplates: (sets) => ipcRenderer.invoke('append-user-templates', sets),
  saveCsv: (defaultName, content) => ipcRenderer.invoke('save-csv', defaultName, content),
  loadUserData: (key) => ipcRenderer.invoke('load-user-data', key),
  saveUserData: (key, data) => ipcRenderer.invoke('save-user-data', key, data),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  saveText: (defaultName, content) => ipcRenderer.invoke('save-text', defaultName, content),
  appVersion: () => ipcRenderer.invoke('app-version'),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (ev, version) => cb(version)),
  // ハイライト生成（同梱ffmpeg）
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  hlFfmpegAvailable: () => ipcRenderer.invoke('hl-ffmpeg-available'),
  hlPickDir: (defaultPath) => ipcRenderer.invoke('hl-pick-dir', defaultPath),
  hlCut: (job) => ipcRenderer.invoke('hl-cut', job),
  hlConcat: (job) => ipcRenderer.invoke('hl-concat', job),
  hlCancel: (jobId) => ipcRenderer.invoke('hl-cancel', jobId),
  hlTempDir: () => ipcRenderer.invoke('hl-temp-dir'),
  hlRemove: (files) => ipcRenderer.invoke('hl-remove', files),
  hlExists: (p) => ipcRenderer.invoke('hl-exists', p),
  hlOpenPath: (p) => ipcRenderer.invoke('hl-open-path', p),
  onHlProgress: (cb) => ipcRenderer.on('hl-progress', (ev, info) => cb(info)),
});
