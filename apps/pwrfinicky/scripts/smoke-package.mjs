// Opt-in toolchain smoke test: package a disposable Go/Electron fixture without
// launching it or touching the production backend, renderer, or default handlers.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from './build.mjs';
import { appRoot, fail, manifest, parseOptions, requireFile, settingsName } from './common.mjs';
import { archive } from './package.mjs';

async function smoke() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: npm run test:package -- [--platform darwin|win32|linux] [--arch arm64|x64]');
    return;
  }
  if (options.skipApi) throw new Error('The packaging smoke test must generate its API fixture');
  await mkdir(path.join(appRoot, 'build'), { recursive: true });
  const temporary = await mkdtemp(path.join(appRoot, 'build', '.toolchain-test-'));
  try {
    const repository = path.join(temporary, 'fixture repository with spaces');
    const root = path.join(repository, 'apps', 'pwrfinicky');
    const files = {
      'LICENSE': 'Disposable packaging fixture; not a distributable product.\n',
      'apps/pwrfinicky/package.json': JSON.stringify(await manifest()),
      'apps/pwrfinicky/main.cjs': "require('electron').app.whenReady().then(() => require('electron').app.quit());\n",
      'apps/pwrfinicky/preload.cjs': '// Toolchain smoke fixture.\n',
      'apps/pwrfinicky/renderer/index.html': '<!doctype html><title>Packaging fixture</title>\n',
      'apps/finicky/src/go.mod': 'module pwrfinicky-build-fixture\n\ngo 1.24.0\n',
      'apps/finicky/src/cmd/pwrfinicky/main.go': 'package main\nimport ("fmt"; "pwrfinicky-build-fixture/router")\nvar buildVersion = "unset"\nfunc main() { fmt.Println(buildVersion, len(router.API)) }\n',
      'apps/finicky/src/router/router.go': 'package router\nimport _ "embed"\n//go:embed config-api.js\nvar API string\n',
      'packages/config-api/package.json': JSON.stringify({ name: 'config-api-build-fixture', version: '1.0.0', private: true, scripts: { build: 'node build.cjs' } }),
      'packages/config-api/package-lock.json': JSON.stringify({ name: 'config-api-build-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'config-api-build-fixture', version: '1.0.0' } } }),
      'packages/config-api/build.cjs': "const fs = require('node:fs'); fs.mkdirSync('dist', {recursive: true}); fs.writeFileSync('dist/finickyConfigAPI.js', '/* generated smoke fixture */');\n",
    };
    for (const [relative, data] of Object.entries(files)) {
      const destination = path.join(repository, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, data);
    }
    // Do not inherit optional credentials/identities into a fixture test.
    const product = await build(options, { root, repository, env: {} });
    const settingsExecutable = options.platform === 'darwin'
      ? path.join(product, 'Contents', 'Resources', `${settingsName}.app`, 'Contents', 'MacOS', settingsName)
      : path.join(product, 'settings', `${settingsName}${options.platform === 'win32' ? '.exe' : ''}`);
    await requireFile(settingsExecutable, 'Settings executable does not match the native host contract');
    const output = await archive(options, { root });
    if ((await stat(output)).size === 0) throw new Error('Empty product archive');
    const info = options.platform === 'darwin'
      ? path.join(product, 'Contents', 'Resources', 'build-info.json')
      : path.join(product, 'build-info.json');
    console.log(`Toolchain smoke passed: ${await readFile(info, 'utf8')}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

smoke().catch(fail);
