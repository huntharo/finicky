import { appRoot, fail, isMain, nativeExecutable, requireFile, run } from './common.mjs';

export async function start(args, { root = appRoot, platform = process.platform, arch = process.arch, execute = run } = {}) {
  const executable = nativeExecutable(root, { platform, arch });
  await requireFile(executable, 'run npm run build first');
  // The Go router owns URL dispatch and launches Settings with --endpoint itself.
  return execute(executable, args, { cwd: root });
}

if (isMain(import.meta.url)) start(process.argv.slice(2)).catch(fail);
