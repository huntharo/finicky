// Exercises router-owned child cleanup with a harmless Go helper, never Electron.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { appRoot, nativeExecutable } from '../scripts/common.mjs';

const execute = promisify(execFile);
const override = process.argv.indexOf('--backend');
const backend = override < 0 ? nativeExecutable(appRoot, process) : process.argv[override + 1];
await mkdir(path.join(appRoot, 'build'), { recursive: true });
const directory = await mkdtemp(path.join(appRoot, 'build', 'router-lifecycle-'));
const helper = path.join(directory, process.platform === 'win32' ? 'settings-helper.exe' : 'settings-helper');
const source = path.join(directory, 'helper.go');
await writeFile(source, `package main
import ("os"; "os/signal"; "strconv"; "syscall"; "time")
func main() {
 if err := os.WriteFile(os.Getenv("PWRFINICKY_LIFECYCLE_MARKER"), []byte(strconv.Itoa(os.Getpid())), 0600); err != nil { panic(err) }
 stop := make(chan os.Signal, 1)
 signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
 select { case <-stop: case <-time.After(30 * time.Second): }
}
`);
await execute('go', ['build', '-o', helper, source], { env: { ...process.env, CGO_ENABLED: '0' } });
const ownedMarker = path.join(directory, 'owned.pid');
const sentinelMarker = path.join(directory, 'sentinel.pid');
const native = spawn(backend, ['--headless', '--dry-run', '--data-dir', directory, '--ui', helper], {
  env: { ...process.env, PWRFINICKY_LIFECYCLE_MARKER: ownedMarker }, windowsHide: true, stdio: 'ignore',
});
// Same executable as the router's child, but a separately captured parent handle.
// A broad process-name kill would terminate this sentinel and fail the test.
const sentinel = spawn(helper, [], {
  env: { ...process.env, PWRFINICKY_LIFECYCLE_MARKER: sentinelMarker }, windowsHide: true, stdio: 'ignore',
});
let launchError;
native.on('error', error => { launchError = error; });
sentinel.on('error', error => { launchError = error; });
let endpoint;
const evidence = { platform: process.platform, nativePid: native.pid, sentinelPid: sentinel.pid };

async function until(check, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
async function rpc(method) {
  const url = new URL(endpoint.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'http:');
  const response = await fetch(`${url.origin}/rpc`, {
    method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: {} }), signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

try {
  await until(async () => {
    try { endpoint = JSON.parse(await readFile(path.join(directory, 'endpoint.json'), 'utf8')); return true; }
    catch { return false; }
  }, 'router endpoint');
  assert.equal(endpoint.pid, native.pid);
  await rpc('showSettings');
  await until(async () => {
    try { evidence.ownedPid = Number(await readFile(ownedMarker, 'utf8')); return Number.isSafeInteger(evidence.ownedPid) && evidence.ownedPid > 0; }
    catch { return false; }
  }, 'owned helper');
  await until(async () => {
    try { return Number(await readFile(sentinelMarker, 'utf8')) === sentinel.pid; }
    catch { return false; }
  }, 'sentinel helper');
  assert.equal(alive(evidence.ownedPid), true);
  await rpc('quit');
  await until(() => native.exitCode !== null || native.signalCode !== null, 'router shutdown');
  await until(() => !alive(evidence.ownedPid), 'owned Settings shutdown');
  assert.equal(sentinel.exitCode, null);
  assert.equal(sentinel.signalCode, null);
  evidence.passed = true;
  console.log('Router quit stopped its own Settings helper and preserved the independent sentinel.');
} finally {
  await rpc('quit').catch(() => {});
  // Only ChildProcess handles captured by this script are terminated here.
  if (native.exitCode === null && native.signalCode === null) native.kill();
  if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill();
  await writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`Lifecycle evidence: ${directory}`);
}
