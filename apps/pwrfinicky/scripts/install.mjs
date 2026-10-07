import { lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { appRoot, fail, isMain, requireFile, run } from './common.mjs';

const bundleId = 'com.pwrdrvr.pwrfinicky';
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
export const installedApp = '/Applications/PwrFinicky.app';

export function bundleProcesses(output, bundle) {
  const prefix = path.resolve(bundle) + path.sep;
  return output.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    return match && match[2].startsWith(prefix) ? [{ pid: Number(match[1]), executable: match[2] }] : [];
  });
}

export async function requireStopped(bundle, { execute = run } = {}) {
  const processes = bundleProcesses(await execute('/bin/ps', ['-axo', 'pid=,comm='], { capture: true }), bundle);
  if (processes.length) {
    throw new Error(`Quit PwrFinicky and close its Settings before installing: ${bundle} (PIDs ${processes.map(p => p.pid).join(', ')})`);
  }
}

async function checkBundle(bundle, execute) {
  const info = JSON.parse(await execute('plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')], { capture: true }));
  if (info.CFBundleIdentifier !== bundleId || info.CFBundleExecutable !== 'PwrFinicky') {
    throw new Error(`Refusing to replace or install an unexpected application: ${bundle}`);
  }
  await requireFile(path.join(bundle, 'Contents', 'MacOS', 'PwrFinicky'));
}

export async function install({
  root = appRoot, target = installedApp, platform = process.platform, execute = run,
} = {}) {
  if (platform !== 'darwin') throw new Error('Install is currently supported only on macOS');
  const source = path.join(root, 'build', 'PwrFinicky.app');
  let previous = false;
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing to replace a non-directory or symlink: ${target}`);
    await checkBundle(target, execute);
    previous = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await requireStopped(target, { execute });
  await checkBundle(source, execute);
  const temporary = await mkdtemp(path.join(path.dirname(target), '.pwrfinicky-install-'));
  const staged = path.join(temporary, 'PwrFinicky.app');
  const backup = path.join(temporary, 'previous.app');
  let backedUp = false;
  let replaced = false;
  let preserveBackup = false;
  try {
    await execute('ditto', ['--rsrc', '--extattr', source, staged]);
    await checkBundle(staged, execute);
    await execute('codesign', ['--verify', '--deep', '--strict', staged]);
    await requireStopped(target, { execute });
    if (previous) { await rename(target, backup); backedUp = true; }
    await rename(staged, target);
    replaced = true;
    // Register the stable bundle location; selecting a default browser remains
    // the user's separate Settings action. Never launch an app during install.
    await execute(lsregister, ['-f', target]);
    console.log(`Installed ${target}. Use Start Installed to open it.`);
    return target;
  } catch (error) {
    try {
      if (replaced) await rm(target, { recursive: true, force: true });
      if (backedUp) await rename(backup, target);
    } catch (restoreError) {
      preserveBackup = true;
      throw new Error(`Installation failed (${error.message}); restore failed (${restoreError.message}). Previous app preserved at ${backup}`, { cause: error });
    }
    throw error;
  } finally {
    if (!preserveBackup) await rm(temporary, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) install().catch(fail);
