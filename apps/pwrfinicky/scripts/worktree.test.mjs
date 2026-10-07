import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeExecutable } from './common.mjs';
import { worktree } from './worktree.mjs';

async function fixture(t, platform = 'darwin') {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'pwrfinicky worktree '));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const root = path.join(repository, 'apps', 'pwrfinicky');
  const options = { root, repository, platform, arch: 'arm64', env: {}, report() {} };
  const calls = [];
  const executable = nativeExecutable(root, options);
  const createExecutable = async () => {
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, 'fixture');
  };
  options.execute = async (command, args, opts) => {
    calls.push({ command, args, ...opts });
    if (args.slice(-2).join(' ') === 'run build') await createExecutable();
  };
  return { options, calls, executable, createExecutable, dataDir: path.join(root, 'build', 'worktree-data') };
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: Start builds a fresh checkout and isolates data; subsequent Start reuses the app`, async t => {
    const f = await fixture(t, platform);
    await worktree('start', f.options);
    const build = f.calls[0];
    assert.deepEqual(build.args.slice(-2), ['run', 'build']);
    assert.equal(build.env.PWRFINICKY_SIGN_IDENTITY, '-');
    assert.equal(build.env.PWRFINICKY_NOTARY_PROFILE, '');
    assert.deepEqual(f.calls[1], {
      command: f.executable, args: ['--data-dir', f.dataDir], cwd: f.options.root,
    });
    f.calls.length = 0;
    await worktree('start', f.options);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].command, f.executable);
  });

  test(`${platform}: Stop addresses only the worktree endpoint, and a never-started tree is a no-op`, async t => {
    const f = await fixture(t, platform);
    await worktree('stop', f.options);
    assert.equal(f.calls.length, 0);
    await f.createExecutable();
    await mkdir(f.dataDir, { recursive: true });
    await writeFile(path.join(f.dataDir, 'endpoint.json'), '{}');
    await worktree('stop', f.options);
    assert.deepEqual(f.calls, [{
      command: f.executable, args: ['--data-dir', f.dataDir, '--rpc', 'quit'], cwd: f.options.root,
    }]);
  });
}

test('setup checks prerequisites before installing and fails without running later stages', async t => {
  const f = await fixture(t);
  f.options.execute = async () => { throw new Error('missing Go'); };
  await assert.rejects(worktree('setup', f.options), /missing Go/);
  assert.equal(f.calls.length, 0);
  f.options.execute = async (command, args, opts) => {
    f.calls.push({ command, args, ...opts });
    if (args.at(-1) === 'build:api') throw new Error('API build failed');
  };
  await assert.rejects(worktree('setup', f.options), /API build failed/);
  assert.equal(f.calls[0].command, 'go');
  assert.equal(f.calls[1].command, 'xcrun');
  assert.deepEqual(f.calls[2].args.slice(-1), ['ci']);
  assert.equal(f.calls.some(call => call.args.includes('download')), false);
});

test('Package never archives a failed build', async t => {
  const f = await fixture(t);
  f.options.execute = async (command, args) => {
    f.calls.push({ command, args });
    throw new Error('build failed');
  };
  await assert.rejects(worktree('package', f.options), /build failed/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args.slice(-2), ['run', 'build']);
});
