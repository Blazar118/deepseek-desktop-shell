'use strict';

// Preload for the agent panel. The panel is our own HTML, so it gets a narrow,
// explicit bridge instead of full Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  init: () => ipcRenderer.invoke('agent:init'),
  pickRoot: () => ipcRenderer.invoke('agent:pick-root'),
  start: (task) => ipcRenderer.invoke('agent:start', task),
  stop: () => ipcRenderer.invoke('agent:stop'),
  approve: (id, allowed) => ipcRenderer.invoke('agent:approve', id, allowed),
  onEvent: (cb) => {
    ipcRenderer.on('agent:event', (_e, payload) => cb(payload));
  },
});
