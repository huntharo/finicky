const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

app.setName('PwrFinicky Settings');
const endpointArg = process.argv.indexOf('--endpoint');
const endpointPath = endpointArg >= 0 && process.argv[endpointArg + 1]
  ? path.resolve(process.argv[endpointArg + 1])
  : path.join(app.getPath('appData'), 'PwrFinicky', 'endpoint.json');
app.setPath('userData', path.join(path.dirname(endpointPath), 'electron-settings'));
let window;
let poll;
let quitting = false;

// Each independent router data directory has its own settings instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
  app.on('activate', () => { if (window) { window.show(); window.focus(); } });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('PwrFinicky could not start', error.message);
    app.quit();
  });
}

async function rpc(method, params = {}) {
  const endpoint = JSON.parse(await fs.readFile(endpointPath, 'utf8'));
  const url = new URL(endpoint.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !/^[a-f0-9]{64}$/.test(endpoint.token)) {
    throw new Error('The local router endpoint is invalid. Restart PwrFinicky.');
  }
  const response = await fetch(`${url.origin}/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Router returned ${response.status}`);
  return data;
}

async function ensureRouter() {
  try { await rpc('state'); return; } catch {}
  const base = path.dirname(process.execPath);
  const nativePath = process.platform === 'darwin'
    ? path.resolve(base, '../../../../MacOS/PwrFinicky')
    : path.resolve(base, '..', process.platform === 'win32' ? 'pwrfinicky.exe' : 'pwrfinicky');
  await fs.access(nativePath);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(nativePath, ['--headless', '--data-dir', path.dirname(endpointPath)], {
    detached: true, stdio: 'ignore', env: environment, windowsHide: true,
  });
  let launchError;
  child.on('error', error => { launchError = error; });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (launchError) throw launchError;
    try { await rpc('state'); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The Go router did not become ready. See routing.log in the PwrFinicky data directory.');
}

async function start() {
  await ensureRouter();
  window = new BrowserWindow({
    width: 1120, height: 790, minWidth: 830, minHeight: 600,
    title: 'PwrFinicky', backgroundColor: '#101216', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => { window.show(); window.focus(); });
  window.on('closed', () => { window = undefined; app.quit(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'PwrFinicky', submenu: [
      { label: 'About PwrFinicky', click: () => dialog.showMessageBox(window, {
        title: 'PwrFinicky', message: 'PwrFinicky', detail: `An independent fork of Finicky by John Sterling and contributors.\nMIT license.\n\nElectron ${process.versions.electron} · Go router`,
      }) },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' },
      { label: 'Close Settings', accelerator: 'Cmd+Q', click: () => app.quit() },
    ] }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'toggleDevTools' }] },
  ]));
  await window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  let updating = false;
  poll = setInterval(async () => {
    if (updating || quitting || !window) return;
    updating = true;
    try { window?.webContents.send('pwrfinicky:state', await rpc('state')); }
    catch (error) { window?.webContents.send('pwrfinicky:connection-error', error.message); }
    finally { updating = false; }
  }, 1000);
}

const backendMethods = new Set(['state', 'test', 'dispatch', 'saveRules', 'getProfiles', 'reload', 'useVisualRules', 'getDefaultStatus', 'setDefaultBrowser']);
ipcMain.handle('pwrfinicky:request', async (event, method, params = {}) => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted settings caller');
  if (typeof method !== 'string' || params === null || typeof params !== 'object') throw new Error('Invalid request');
  if (backendMethods.has(method)) return rpc(method, params);
  switch (method) {
    case 'chooseConfig': {
      const result = await dialog.showOpenDialog(window, {
        title: 'Use an existing Finicky configuration', properties: ['openFile'],
        filters: [{ name: 'JavaScript or TypeScript', extensions: ['js', 'ts', 'mjs', 'cjs'] }],
      });
      return result.canceled ? rpc('state') : rpc('setConfig', { path: result.filePaths[0] });
    }
    case 'openConfig': {
      const state = await rpc('state');
      const error = await shell.openPath(state.configPath || state.rulesPath);
      if (error) throw new Error(error);
      return null;
    }
    case 'openDataDirectory': {
      const error = await shell.openPath(path.dirname(endpointPath));
      if (error) throw new Error(error);
      return null;
    }
    case 'openExternal': {
      const url = new URL(params.url);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only web links can be opened here');
      await shell.openExternal(url.href);
      return null;
    }
    case 'quit': await rpc('quit'); app.quit(); return null;
    default: throw new Error(`Unknown settings action: ${method}`);
  }
});

app.on('before-quit', () => { quitting = true; clearInterval(poll); });
app.on('window-all-closed', () => app.quit());
