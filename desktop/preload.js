'use strict';

// Panelde sadece bu köprü görünür: Node API'si sayfaya açılmaz.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  versions: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  scanStatus: () => ipcRenderer.invoke('scan:status'),
  scanStart: () => ipcRenderer.invoke('scan:start'),
  scanStop: () => ipcRenderer.invoke('scan:stop'),
  // Panelden bulunan adresleri yerel tarayıcı havuzuna ekler.
  addTargets: (list) => ipcRenderer.invoke('targets:add', list),
  openDataFolder: () => ipcRenderer.invoke('app:open-data'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (callback) => {
    ipcRenderer.on('update:status', (_event, data) => callback(data));
  },
  onScan: (callback) => {
    ipcRenderer.on('scan:status', (_event, data) => callback(data));
  }
});
