// Opt-in integration test of the packaged Electron app and real Go process.
// Uses a disposable data directory. It never changes default URL handlers.
// --launch-browser additionally hands one example.com link to a real browser.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const platform = process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const product = path.join(root, 'build', platform === 'darwin' ? 'PwrFinicky.app' : `PwrFinicky-${platform}-${arch}`);
const backend = platform === 'darwin' ? path.join(product, 'Contents/MacOS/PwrFinicky') : path.join(product, `pwrfinicky${platform === 'win32' ? '.exe' : ''}`);
const settings = platform === 'darwin'
  ? path.join(product, 'Contents/Resources/PwrFinicky Settings.app/Contents/MacOS/PwrFinicky Settings')
  : path.join(product, 'settings', `PwrFinicky Settings${platform === 'win32' ? '.exe' : ''}`);
await mkdir(path.join(root, 'build'), { recursive: true });
const dataDir = await mkdtemp(path.join(root, 'build', 'electron-smoke-'));
const endpointPath = path.join(dataDir, 'endpoint.json');
const launchBrowser = process.argv.includes('--launch-browser');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const native = spawn(backend, ['--headless', '--data-dir', dataDir, ...(!launchBrowser ? ['--dry-run'] : [])], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let nativeLog = '';
let nativeError;
native.stderr.on('data', chunk => { nativeLog += chunk; });
native.on('error', error => { nativeError = error; });
let app;
let endpoint;
const evidence = { platform, arch, launchBrowser, dataDir, rendererErrors: [] };

async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (nativeError) throw nativeError;
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function rpc(method, params = {}) {
  const response = await fetch(`${endpoint.url}/rpc`, {
    method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(12000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}
async function openSettings() {
  app = await electron.launch({ executablePath: settings, args: ['--endpoint', endpointPath], env, timeout: 30000 });
  evidence.electron = await app.evaluate(() => process.versions.electron);
  assert.match(evidence.electron, /^44\./);
  const page = await app.firstWindow();
  page.on('pageerror', error => evidence.rendererErrors.push(error.message));
  await page.locator('#view-routing').waitFor({ state: 'visible' });
  return page;
}
async function preview(page, url, browser) {
  await page.locator('[data-view="test"]').click();
  await page.locator('#test-url').fill(url);
  await page.locator('#test-link').click();
  await until(async () => (await page.locator('.route-result h2').textContent().catch(() => '')) === browser, `preview resolves to ${browser}`);
}

try {
  await until(async () => {
    try { endpoint = JSON.parse(await readFile(endpointPath, 'utf8')); return true; } catch { return false; }
  }, 'native endpoint');
  const before = await rpc('state');
  evidence.backendPid = before.backendPid;
  evidence.defaultHandlersBefore = await rpc('getDefaultStatus');
  const firstBrowser = before.browsers.includes('Safari') ? 'Safari' : before.browsers[0] || before.rules.defaultBrowser;
  const secondBrowser = ['Firefox', 'Microsoft Edge', 'Google Chrome'].find(value => value !== firstBrowser && before.browsers.includes(value)) || firstBrowser;
  let page = await openSettings();
  await page.locator('#default-browser').selectOption(firstBrowser);
  await page.locator('#add-rule').click();
  await page.locator('.patterns-input').fill('github.com/*\n*.github.com/*');
  await page.locator('.rule-card [data-browser-select]').selectOption(secondBrowser);
  await page.locator('#save-rules').click();
  await until(async () => (await rpc('state')).rules.rules.length === 1, 'saved visual rule');
  const diskRules = JSON.parse(await readFile(path.join(dataDir, 'rules.json'), 'utf8'));
  assert.deepEqual(diskRules.rules[0].match, ['github.com/*', '*.github.com/*']);
  assert.equal(diskRules.rules[0].browser, secondBrowser);
  await page.screenshot({ path: path.join(dataDir, 'routing.png') });
  await preview(page, 'https://github.com/huntharo/finicky', secondBrowser);
  await page.screenshot({ path: path.join(dataDir, 'test-link.png') });

  const jsPath = path.join(dataDir, 'config.ts');
  await writeFile(jsPath, `export default { defaultBrowser: ${JSON.stringify(firstBrowser)} };\n`);
  await rpc('setConfig', { path: jsPath });
  await preview(page, 'https://example.com/', firstBrowser);
  await writeFile(jsPath, 'export default { defaultBrowser: "Safari", handlers: [{ match: 42, browser: "Safari" }] };\n');
  await until(async () => (await rpc('state')).configError.includes('handlers[0].match'), 'detailed validation error');
  await page.locator('.config-alert').waitFor({ state: 'visible' });
  assert.match(await page.locator('.config-error-text').textContent(), /handlers\[0\]\.match/);
  await preview(page, 'https://example.com/still-good', firstBrowser);
  await page.screenshot({ path: path.join(dataDir, 'rejected-config.png') });
  await writeFile(`${jsPath}.replacement`, `export default { defaultBrowser: ${JSON.stringify(secondBrowser)} };\n`);
  await rename(`${jsPath}.replacement`, jsPath);
  await until(async () => !(await rpc('state')).configError, 'atomic replacement recovery');
  await page.locator('.config-alert').waitFor({ state: 'hidden' });
  await preview(page, 'https://example.com/recovered', secondBrowser);
  await page.locator('[data-view="settings"]').click();
  await page.locator('#use-visual-rules').click();
  await until(async () => !(await rpc('state')).isJSConfig, 'switch back to visual rules');
  await page.screenshot({ path: path.join(dataDir, 'settings.png') });
  await app.close();
  app = undefined;
  assert.equal((await rpc('state')).backendPid, evidence.backendPid);
  evidence.routingSurvivesClosingSettings = true;

  const nativeURL = 'https://example.com/?pwrfinicky=packaged-smoke';
  if (platform === 'darwin') await execute('/usr/bin/open', ['-a', product, nativeURL]);
  else await execute(backend, ['--data-dir', dataDir, '--url', nativeURL]);
  await until(async () => (await rpc('state')).history.some(item => item.url === nativeURL), 'native URL handoff with settings closed');
  // Allow any erroneous native reopen/UI launch time to become observable.
  await new Promise(resolve => setTimeout(resolve, 1200));
  if (platform === 'darwin') {
    const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,comm='], { maxBuffer: 16 << 20 });
    const settingsProcesses = stdout.split('\n').filter(line => line.trimEnd().endsWith(settings));
    assert.equal(settingsProcesses.length, 0, 'A URL must not reopen Settings');
    evidence.urlDidNotOpenSettings = true;
  }
  evidence.nativeDispatch = (await rpc('state')).history.find(item => item.url === nativeURL);
  assert.equal(evidence.nativeDispatch.success, true);
  assert.equal(evidence.nativeDispatch.browser, firstBrowser);
  assert.equal(evidence.nativeDispatch.dryRun, !launchBrowser);
  evidence.defaultHandlersAfter = await rpc('getDefaultStatus');
  assert.deepEqual(evidence.defaultHandlersAfter, evidence.defaultHandlersBefore);
  if (launchBrowser) {
    page = await openSettings();
    await page.locator('[data-view="activity"]').click();
    await page.locator('.history-entry').waitFor();
    await page.locator('.history-entry summary').click();
    await page.screenshot({ path: path.join(dataDir, 'activity.png') });
  }
  assert.deepEqual(evidence.rendererErrors, []);
  evidence.passed = true;
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await app?.close();
  if (endpoint) await rpc('quit').catch(() => {});
  await until(async () => native.exitCode !== null || native.signalCode !== null, 'native shutdown', 5000).catch(() => native.kill());
  await writeFile(path.join(dataDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(dataDir, 'native.log'), nativeLog);
  console.log(`Smoke evidence: ${dataDir}`);
}
