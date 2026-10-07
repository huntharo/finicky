import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  appRoot, fail, isMain, nativeExecutable, npmCommand, repoRoot, run,
} from './common.mjs';

async function exists(filename) {
  try { await access(filename); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Keep configuration, instance locks and authenticated RPC endpoints local to
// this checkout. Never forward Start/Stop to the user's installed instance.
export async function worktree(action, {
  root = appRoot, repository = repoRoot, platform = process.platform,
  arch = process.arch, execute = run, env = process.env, report = console.log,
} = {}) {
  const goRoot = path.join(repository, 'apps', 'finicky', 'src');
  const dataDir = path.join(root, 'build', 'worktree-data');
  const executable = nativeExecutable(root, { platform, arch });
  const npm = async (args, extraEnv = {}) => {
    const [command, commandArgs] = npmCommand(args, env, platform);
    return execute(command, commandArgs, { cwd: root, env: extraEnv });
  };
  const build = () => npm(['run', 'build'], {
    PWRFINICKY_SIGN_IDENTITY: '-', PWRFINICKY_NOTARY_PROFILE: '',
  });

  switch (action) {
    case 'setup':
      await execute('go', ['version'], { cwd: goRoot });
      if (platform === 'darwin') await execute('xcrun', ['--find', 'clang'], { cwd: goRoot });
      await npm(['ci']);
      await npm(['run', 'build:api']);
      await execute('go', ['mod', 'download'], { cwd: goRoot });
      report('PwrFinicky worktree ready. Start builds the app on its first run.');
      return;
    case 'build':
      return build();
    case 'install': {
      if (platform !== 'darwin') throw new Error('Build and Install is currently supported only on macOS');
      const { install, installedApp, requireStopped } = await import('./install.mjs');
      await requireStopped(path.join(root, 'build', 'PwrFinicky.app'), { execute });
      await requireStopped(installedApp, { execute });
      await build();
      return install({ root, platform, execute });
    }
    case 'start-installed': {
      if (platform !== 'darwin') throw new Error('Start Installed is currently supported only on macOS');
      const { installedApp } = await import('./install.mjs');
      await access(installedApp);
      return execute('/usr/bin/open', ['-a', installedApp], { cwd: root });
    }
    case 'start':
      if (!await exists(executable)) await build();
      report(`Starting PwrFinicky Settings with worktree data: ${dataDir}`);
      return execute(executable, ['--data-dir', dataDir], { cwd: root });
    case 'stop':
      if (!await exists(path.join(dataDir, 'endpoint.json'))) {
        report('This worktree has no running PwrFinicky instance.');
        return;
      }
      // The native client authenticates to this data directory's endpoint.
      // No process-name matching or signals to unrelated Electron instances.
      return execute(executable, ['--data-dir', dataDir, '--rpc', 'quit'], { cwd: root });
    case 'test':
      await npm(['run', 'build:api']);
      await npm(['run', 'test:build']);
      await npm(['test']);
      return execute('go', [
        'test', '-timeout', '3m', './router', './config', './resolver',
        './rules', './browser', './diagnostics',
      ], { cwd: goRoot, env: { CGO_ENABLED: platform === 'darwin' ? '1' : '0' } });
    case 'package':
      await build();
      return npm(['run', 'package']);
    default:
      throw new Error(`Unknown worktree action: ${action}; use setup, start, build, install, start-installed, stop, test, or package`);
  }
}

if (isMain(import.meta.url)) worktree(process.argv[2]).catch(fail);
