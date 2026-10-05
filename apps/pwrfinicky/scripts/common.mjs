import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = path.resolve(appRoot, '../..');
export const settingsName = 'PwrFinicky Settings';
export const minimumMacOS = '13.0';

export function isMain(url) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(url);
}

export async function manifest(root = appRoot) {
  return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
}

export function parseOptions(args, defaults = {}) {
  const options = { platform: process.platform, arch: process.arch, ...defaults };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help') options.help = true;
    else if (flag === '--skip-api') options.skipApi = true;
    else if (['--platform', '--arch', '--version'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!['darwin', 'win32', 'linux'].includes(options.platform)) {
    throw new Error(`Unsupported platform: ${options.platform}; use darwin, win32, or linux`);
  }
  if (!['arm64', 'x64'].includes(options.arch)) {
    throw new Error(`Unsupported architecture: ${options.arch}; use arm64 or x64`);
  }
  if (options.version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new Error('Version must be a semantic version, for example 0.1.0');
  }
  return options;
}

export function productName({ platform, arch }) {
  return platform === 'darwin' ? 'PwrFinicky.app' : `PwrFinicky-${platform}-${arch}`;
}

export function nativeExecutable(root, options) {
  const product = path.join(root, 'build', productName(options));
  return options.platform === 'darwin'
    ? path.join(product, 'Contents', 'MacOS', 'PwrFinicky')
    : path.join(product, options.platform === 'win32' ? 'pwrfinicky.exe' : 'pwrfinicky');
}

export async function requireFile(filename, hint = '') {
  try { await access(filename); }
  catch { throw new Error(`Missing ${filename}${hint ? `; ${hint}` : ''}`); }
}

// Never pass source paths or user arguments through a shell (including on Windows).
export function run(command, args, { cwd, env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    if (capture) child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    const forward = signal => child.kill(signal);
    const onInterrupt = () => forward('SIGINT');
    const onTerminate = () => forward('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    const cleanup = () => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)} failed (${signal || `exit ${code}`})`));
    });
  });
}

export function npmCommand(args, env = process.env, platform = process.platform) {
  // npm supplies npm_execpath to every npm script. Standard Windows Node installs
  // also put npm's JS entry point next to node.exe; npm.cmd cannot be spawn'ed safely.
  const cli = env.npm_execpath || (platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : undefined);
  return cli ? [process.execPath, [cli, ...args]] : ['npm', args];
}

export function fail(error) {
  console.error(`PwrFinicky: ${error.message}`);
  process.exitCode = 1;
}
