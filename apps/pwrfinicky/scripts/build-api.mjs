import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fail, isMain, npmCommand, repoRoot, requireFile, run } from './common.mjs';

export async function buildAPI({ root = repoRoot, execute = run } = {}) {
  const apiRoot = path.join(root, 'packages', 'config-api');
  for (const args of [['ci'], ['run', 'build']]) {
    const [command, commandArgs] = npmCommand(args);
    await execute(command, commandArgs, { cwd: apiRoot });
  }
  const source = path.join(apiRoot, 'dist', 'finickyConfigAPI.js');
  await requireFile(source, 'the config API build did not produce its bundle');
  // The portable router embeds the first path. Existing config/resolver tests
  // still read the second path, which is already ignored by the legacy app.
  for (const relative of ['router/config-api.js', 'assets/finickyConfigAPI.js']) {
    const destination = path.join(root, 'apps', 'finicky', 'src', relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

if (isMain(import.meta.url)) buildAPI().catch(fail);
