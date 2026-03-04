const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('podAPI', {
  // Persistent storage
  get: (key, defaultValue) => ipcRenderer.invoke('store-get', key, defaultValue),
  set: (key, value) => ipcRenderer.invoke('store-set', key, value),
  delete: (key) => ipcRenderer.invoke('store-delete', key),

  // File dialogs
  openAudioFile: () => ipcRenderer.invoke('open-audio-file'),
  saveRecording: () => ipcRenderer.invoke('save-recording'),

  // Platform info
  platform: process.platform
});
