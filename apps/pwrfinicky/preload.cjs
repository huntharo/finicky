const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pwrfinicky', {
  request: (method, params = {}) => ipcRenderer.invoke('pwrfinicky:request', method, params),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pwrfinicky:state', listener);
    return () => ipcRenderer.removeListener('pwrfinicky:state', listener);
  },
  onConnectionError: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('pwrfinicky:connection-error', listener);
    return () => ipcRenderer.removeListener('pwrfinicky:connection-error', listener);
  },
});
