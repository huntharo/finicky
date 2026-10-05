import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { appRoot, fail, isMain, parseOptions, productName, requireFile, run } from './common.mjs';

export async function archive(options, { root = appRoot, execute = run } = {}) {
  const name = productName(options);
  const product = path.join(root, 'build', name);
  await requireFile(product, 'run npm run build for this platform and architecture first');
  const infoPath = options.platform === 'darwin'
    ? path.join(product, 'Contents', 'Resources', 'build-info.json')
    : path.join(product, 'build-info.json');
  const info = JSON.parse(await readFile(infoPath, 'utf8'));
  const version = options.version || info.version;
  parseOptions([], { ...options, version });
  if (info.platform !== options.platform || info.arch !== options.arch || info.version !== version) {
    throw new Error('Existing build target/version does not match the requested archive; rebuild first');
  }
  const extension = options.platform === 'darwin' ? 'zip' : 'tar.gz';
  const directory = path.join(root, 'build', 'artifacts');
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, `PwrFinicky-${options.platform}-${options.arch}-${version}.${extension}`);
  if (options.platform === 'darwin') {
    await execute('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', product, output]);
  } else {
    // A relative archive path also works with GNU tar on Windows, where an
    // absolute drive-letter path can otherwise be interpreted as a remote host.
    await execute('tar', ['-czf', path.relative(path.dirname(product), output), name], {
      cwd: path.dirname(product),
    });
  }
  console.log(`Packaged ${output}`);
  return output;
}

if (isMain(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2), { version: process.env.PWRFINICKY_VERSION });
    if (options.help) console.log('Usage: npm run package -- [--platform darwin|win32|linux] [--arch arm64|x64] [--version 0.1.0] (archives an existing build)');
    else await archive(options);
  } catch (error) { fail(error); }
}
