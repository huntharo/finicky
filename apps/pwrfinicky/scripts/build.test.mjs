import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildAPI } from './build-api.mjs';
import { build, goEnvironment, macMinimum, packagerOptions } from './build.mjs';
import { appRoot, manifest, nativeExecutable, npmCommand, parseOptions, settingsName } from './common.mjs';
import { archive } from './package.mjs';
import { start } from './start.mjs';

async function fixture(t) {
  const directory = path.join(appRoot, 'build');
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(path.join(directory, '.build-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, 'repository with spaces');
  const root = path.join(repository, 'apps', 'pwrfinicky');
  const goRoot = path.join(repository, 'apps', 'finicky', 'src');
  await mkdir(path.join(root, 'renderer'), { recursive: true });
  await mkdir(path.join(goRoot, 'cmd', 'pwrfinicky'), { recursive: true });
  await mkdir(path.join(goRoot, 'router'), { recursive: true });
  await writeFile(path.join(repository, 'LICENSE'), 'fixture license');
  await writeFile(path.join(root, 'package.json'), JSON.stringify(await manifest()));
  await writeFile(path.join(root, 'main.cjs'), '// fixture main');
  await writeFile(path.join(root, 'preload.cjs'), '// fixture preload');
  await writeFile(path.join(root, 'renderer', 'index.html'), '<title>Fixture</title>');
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'go') await writeFile(args[args.indexOf('-o') + 1], 'fixture native host');
    if (command === 'plutil') return JSON.stringify({ LSMinimumSystemVersion: '13.0', CFBundleURLTypes: [], CFBundleDocumentTypes: [] });
    return '';
  };
  const api = async () => {
    calls.push({ command: 'api' });
    await writeFile(path.join(goRoot, 'router', 'config-api.js'), '// generated fixture');
  };
  const packageElectron = async options => {
    calls.push({ command: 'packager', options });
    assert.equal(await readFile(path.join(options.dir, 'main.cjs'), 'utf8'), '// fixture main');
    const packagedManifest = JSON.parse(await readFile(path.join(options.dir, 'package.json'), 'utf8'));
    assert.equal(packagedManifest.main, 'main.cjs');
    assert.equal(packagedManifest.devDependencies, undefined);
    const result = path.join(options.out, `settings-${options.platform}-${options.arch}`);
    await mkdir(options.platform === 'darwin' ? path.join(result, `${settingsName}.app`, 'Contents') : result, { recursive: true });
    await writeFile(path.join(result, 'fixture-marker'), 'settings');
    return [result];
  };
  return { root, repository, goRoot, calls, execute, api, packageElectron, hostPlatform: 'darwin', env: {} };
}

test('target CLI validates input and maps Go targets and CGO', () => {
  assert.deepEqual(goEnvironment(parseOptions(['--platform', 'win32', '--arch', 'x64'])), {
    GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0',
  });
  assert.equal(goEnvironment({ platform: 'darwin', arch: 'arm64' }).CGO_ENABLED, '1');
  assert.equal(goEnvironment({ platform: 'linux', arch: 'arm64' }).GOARCH, 'arm64');
  for (const args of [['--platform', 'windows'], ['--arch', 'ia32'], ['--arch'], ['--invalid'], ['--version', '0.1.0 -X evil']]) {
    assert.throws(() => parseOptions(args));
  }
  assert.equal(parseOptions(['--skip-api']).skipApi, true);
});

test('Windows npm uses its JavaScript entrypoint with separate arguments', () => {
  const [command, args] = npmCommand(['run', 'build'], { npm_execpath: 'C:\\Program Files\\nodejs\\npm-cli.js' }, 'win32');
  assert.equal(command, process.execPath);
  assert.deepEqual(args, ['C:\\Program Files\\nodejs\\npm-cli.js', 'run', 'build']);
});

test('API generation runs ci then build and supplies both Go consumers', async t => {
  const f = await fixture(t);
  const dist = path.join(f.repository, 'packages', 'config-api', 'dist');
  await mkdir(dist, { recursive: true });
  const calls = [];
  await buildAPI({ root: f.repository, execute: async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.at(-1) === 'build') await writeFile(path.join(dist, 'finickyConfigAPI.js'), 'generated API');
  } });
  assert.equal(calls[0].args.at(-1), 'ci');
  assert.deepEqual(calls[1].args.slice(-2), ['run', 'build']);
  for (const file of ['router/config-api.js', 'assets/finickyConfigAPI.js']) {
    assert.equal(await readFile(path.join(f.goRoot, file), 'utf8'), 'generated API');
  }
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform} packages native entrypoint and Settings at the contracted paths`, async t => {
    const f = await fixture(t);
    const options = { platform, arch: platform === 'darwin' ? 'arm64' : 'x64', version: '0.2.0' };
    const product = await build(options, f);
    assert.equal(await readFile(nativeExecutable(f.root, options), 'utf8'), 'fixture native host');
    assert.equal(f.calls[0].command, 'api');
    const packing = f.calls.find(call => call.command === 'packager').options;
    assert.equal(packing.electronVersion, '44.5.1');
    assert.equal(packing.name, settingsName);
    assert.equal(packing.appBundleId, 'com.pwrdrvr.pwrfinicky.settings');
    const go = f.calls.find(call => call.command === 'go');
    assert.equal(go.args.at(-1), './cmd/pwrfinicky');
    assert.equal(go.args[go.args.indexOf('-ldflags') + 1], `-s -w -X main.buildVersion=0.2.0${platform === 'win32' ? ' -H=windowsgui' : ''}`);
    assert.equal(go.options.env.CGO_ENABLED, platform === 'darwin' ? '1' : '0');
    if (platform === 'darwin') {
      const plist = await readFile(path.join(product, 'Contents', 'Info.plist'), 'utf8');
      assert.match(plist, /com\.pwrdrvr\.pwrfinicky<\/string>/);
      assert.match(plist, /<key>LSUIElement<\/key><true\/>/);
      assert.match(plist, /<string>http<\/string><string>https<\/string><string>pwrfinicky<\/string>/);
      assert.equal(await readFile(path.join(product, 'Contents', 'Resources', 'LICENSE'), 'utf8'), 'fixture license');
      assert.deepEqual(packing.extendInfo.CFBundleURLTypes, []);
      const signing = f.calls.filter(call => call.command === 'codesign');
      assert.equal(signing.length, 3);
      assert.match(signing[0].args.at(-1), /Contents[/\\]Resources[/\\]PwrFinicky Settings\.app$/);
      assert.equal(signing[1].args.includes('--deep'), false);
      assert.deepEqual(signing[2].args.slice(0, 3), ['--verify', '--deep', '--strict']);
    } else {
      assert.equal(await readFile(path.join(product, 'LICENSE'), 'utf8'), 'fixture license');
      assert.equal(await readFile(path.join(product, 'settings', 'fixture-marker'), 'utf8'), 'settings');
      if (platform === 'linux') {
        const desktop = await readFile(path.join(product, 'pwrfinicky.desktop'), 'utf8');
        assert.match(desktop, /^Exec=pwrfinicky %u$/m);
        assert.match(desktop, /MimeType=x-scheme-handler\/http;x-scheme-handler\/https;x-scheme-handler\/pwrfinicky;/);
      }
    }
    const url = 'https://example.test/a?b=$(touch unsafe)&q=space here';
    await start([url], { root: f.root, ...options, execute: f.execute });
    assert.equal(f.calls.at(-1).command, nativeExecutable(f.root, options));
    assert.deepEqual(f.calls.at(-1).args, [url]);
    const output = await archive(options, f);
    assert.match(output, new RegExp(`PwrFinicky-${platform}-${options.arch}-0\\.2\\.0\\.`));
    assert.equal(f.calls.at(-1).command, platform === 'darwin' ? 'ditto' : 'tar');
    await assert.rejects(archive({ ...options, version: '9.0.0' }, f), /does not match/);
  });
}

test('failed native build preserves a previous product', async t => {
  const f = await fixture(t);
  const options = { platform: 'linux', arch: 'x64' };
  const previous = nativeExecutable(f.root, options);
  await mkdir(path.dirname(previous), { recursive: true });
  await writeFile(previous, 'previous good build');
  await assert.rejects(build(options, { ...f, execute: async command => {
    if (command === 'go') throw new Error('compile failed');
  } }), /compile failed/);
  assert.equal(await readFile(previous, 'utf8'), 'previous good build');
});

test('skip-api still requires the generated bundle and cross-mac builds fail early', async t => {
  const f = await fixture(t);
  await assert.rejects(build({ platform: 'linux', arch: 'x64', skipApi: true }, f), /run npm run build:api/);
  await assert.rejects(build({ platform: 'darwin', arch: 'arm64' }, { ...f, hostPlatform: 'linux' }), /require macOS/);
});

test('macOS minimum never understates Electron requirements', () => {
  assert.equal(macMinimum({ LSMinimumSystemVersion: '12.0' }), '13.0');
  assert.equal(macMinimum({ LSMinimumSystemVersion: '14.1' }), '14.1');
  assert.throws(() => macMinimum({ LSMinimumSystemVersion: 'invalid' }));
});

test('release signing is opt-in and notarization requires signing', async t => {
  const f = await fixture(t);
  await assert.rejects(build({ platform: 'darwin', arch: 'arm64' }, {
    ...f, env: { PWRFINICKY_NOTARY_PROFILE: 'fixture-profile' },
  }), /requires PWRFINICKY_SIGN_IDENTITY/);
  await assert.rejects(build({ platform: 'darwin', arch: 'arm64' }, {
    ...f, env: { PWRFINICKY_NOTARY_PROFILE: 'fixture-profile', PWRFINICKY_SIGN_IDENTITY: '-' },
  }), /requires PWRFINICKY_SIGN_IDENTITY/);
  assert.equal(packagerOptions({ platform: 'darwin', version: '0.1.0', identity: 'Developer ID fixture' }).osxSign.optionsForFile().hardenedRuntime, true);
  assert.equal(packagerOptions({ platform: 'darwin', version: '0.1.0' }).osxSign, undefined);
});
