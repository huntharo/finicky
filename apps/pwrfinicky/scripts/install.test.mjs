import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bundleProcesses, install } from './install.mjs';
import { worktree } from './worktree.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pwrfinicky install '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'checkout', 'apps', 'pwrfinicky');
  const applications = path.join(directory, 'Applications with spaces');
  await mkdir(applications);
  const target = path.join(applications, 'PwrFinicky.app');
  const source = path.join(root, 'build', 'PwrFinicky.app');
  const bundle = async (destination, marker, id = 'com.pwrdrvr.pwrfinicky') => {
    await mkdir(path.join(destination, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(path.join(destination, 'Contents', 'Info.plist'), JSON.stringify({ CFBundleIdentifier: id, CFBundleExecutable: 'PwrFinicky' }));
    await writeFile(path.join(destination, 'Contents', 'MacOS', 'PwrFinicky'), marker);
  };
  await bundle(source, 'new app');
  const calls = [];
  const options = { root, target, platform: 'darwin', execute: async (command, args) => {
    calls.push({ command, args });
    if (command === '/bin/ps') return '';
    if (command === 'plutil') return readFile(args.at(-1), 'utf8');
    if (command === 'ditto') await cp(args.at(-2), args.at(-1), { recursive: true });
    return '';
  } };
  return { directory, applications, source, target, bundle, calls, options,
    marker: () => readFile(path.join(target, 'Contents', 'MacOS', 'PwrFinicky'), 'utf8') };
}

test('process inventory matches only executable paths inside the exact app bundle', () => {
  const bundle = path.resolve('Applications', 'PwrFinicky.app');
  const own = path.join(bundle, 'Contents', 'MacOS', 'PwrFinicky');
  const helper = path.join(bundle, 'Contents', 'Resources', 'PwrFinicky Settings.app', 'Contents', 'MacOS', 'PwrFinicky Settings');
  const unrelated = path.join(path.dirname(bundle), 'Another Electron.app', 'Contents', 'MacOS', 'Electron');
  assert.deepEqual(bundleProcesses(`10 ${own}\n11 ${helper}\n12 ${unrelated}\n13 ${bundle}-other/Contents/MacOS/PwrFinicky`, bundle), [
    { pid: 10, executable: own }, { pid: 11, executable: helper },
  ]);
});

for (const replacing of [false, true]) {
  test(`stages and verifies before ${replacing ? 'replacing' : 'installing'} the app without launching it`, async t => {
    const f = await fixture(t);
    if (replacing) await f.bundle(f.target, 'old app');
    await install(f.options);
    assert.equal(await f.marker(), 'new app');
    assert.deepEqual(await readdir(f.applications), ['PwrFinicky.app']);
    const verification = f.calls.findIndex(c => c.command === 'codesign');
    const registration = f.calls.findIndex(c => c.command.endsWith('/lsregister'));
    assert.ok(verification >= 0 && registration > verification);
    assert.deepEqual(f.calls[registration].args, ['-f', f.target]);
    assert.equal(f.calls.some(c => /open|kill|osascript/.test(path.basename(c.command))), false);
  });
}

for (const failingStage of ['codesign', 'lsregister']) {
  test(`${failingStage} failure preserves the previous application`, async t => {
    const f = await fixture(t);
    await f.bundle(f.target, 'old app');
    const execute = f.options.execute;
    f.options.execute = async (command, args) => {
      if (path.basename(command) === failingStage) throw new Error(`${failingStage} failed`);
      return execute(command, args);
    };
    await assert.rejects(install(f.options), new RegExp(`${failingStage} failed`));
    assert.equal(await f.marker(), 'old app');
    assert.deepEqual(await readdir(f.applications), ['PwrFinicky.app']);
  });
}

test('refuses an unrelated existing app or a running installed instance', async t => {
  const f = await fixture(t);
  await f.bundle(f.target, 'unrelated app', 'org.example.other');
  await assert.rejects(install(f.options), /unexpected application/);
  assert.equal(await f.marker(), 'unrelated app');
  await f.bundle(f.target, 'old app');
  const execute = f.options.execute;
  f.options.execute = async (command, args) => command === '/bin/ps'
    ? `456 ${path.join(f.target, 'Contents', 'MacOS', 'PwrFinicky')}` : execute(command, args);
  await assert.rejects(install(f.options), /Quit PwrFinicky.*456/);
  assert.equal(await f.marker(), 'old app');
  assert.equal(f.calls.some(c => c.command === 'ditto'), false);
});

test('Build and Install stops before building when this checkout is still running', async t => {
  const f = await fixture(t);
  await assert.rejects(worktree('install', { root: f.options.root, platform: 'darwin', execute: async (command) => {
    assert.equal(command, '/bin/ps');
    return `789 ${path.join(f.source, 'Contents', 'MacOS', 'PwrFinicky')}`;
  } }), /Quit PwrFinicky.*789/);
});

test('install actions fail before doing any work on other platforms', async () => {
  for (const platform of ['win32', 'linux']) {
    const execute = () => { assert.fail('must not execute commands'); };
    await assert.rejects(worktree('install', { platform, execute }), /only on macOS/);
    await assert.rejects(worktree('start-installed', { platform, execute }), /only on macOS/);
  }
});
