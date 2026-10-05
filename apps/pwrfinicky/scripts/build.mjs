import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appRoot, fail, isMain, manifest, minimumMacOS, parseOptions, productName,
  repoRoot, requireFile, run, settingsName,
} from './common.mjs';
import { buildAPI } from './build-api.mjs';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';

function xml(value) {
  return String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
}

export function outerPlist(version, minimum = minimumMacOS) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.pwrdrvr.pwrfinicky</string>
  <key>CFBundleName</key><string>PwrFinicky</string>
  <key>CFBundleDisplayName</key><string>PwrFinicky</string>
  <key>CFBundleExecutable</key><string>PwrFinicky</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>${xml(version.split(/[+-]/)[0])}</string>
  <key>CFBundleVersion</key><string>${xml(version.split(/[+-]/)[0])}</string>
  <key>LSMinimumSystemVersion</key><string>${xml(minimum)}</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key><array><dict>
    <key>CFBundleURLName</key><string>com.pwrdrvr.pwrfinicky.urls</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Alternate</string>
    <key>CFBundleURLSchemes</key><array><string>http</string><string>https</string><string>pwrfinicky</string></array>
  </dict></array>
</dict></plist>
`;
}

export const desktopFile = `[Desktop Entry]
Version=1.0
Type=Application
Name=PwrFinicky
Comment=Route links to the right browser
Exec=pwrfinicky %u
TryExec=pwrfinicky
Terminal=false
Categories=Network;Utility;
MimeType=x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/pwrfinicky;
`;

export function goEnvironment({ platform, arch }, minimum = minimumMacOS) {
  return {
    GOOS: platform === 'win32' ? 'windows' : platform,
    GOARCH: arch === 'x64' ? 'amd64' : 'arm64',
    CGO_ENABLED: platform === 'darwin' ? '1' : '0',
    ...(platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: minimum } : {}),
  };
}

export function packagerOptions({ source, output, platform, arch, version, electronVersion, identity }) {
  return {
    dir: source, out: output, name: settingsName, executableName: settingsName,
    platform, arch, electronVersion, appVersion: version, buildVersion: version.split(/[+-]/)[0],
    appBundleId: 'com.pwrdrvr.pwrfinicky.settings',
    asar: true, overwrite: true, prune: true, tmpdir: false,
    // This local settings UI has no cookies. Disable cookie encryption before
    // signing so opening settings never requests a macOS Keychain password.
    afterExtract: [async ({ buildPath }) => {
      const binary = path.join(buildPath, platform === 'darwin' ? 'Electron.app' : platform === 'win32' ? 'electron.exe' : 'electron');
      await flipFuses(binary, { version: FuseVersion.V1, [FuseV1Options.EnableCookieEncryption]: false });
    }],
    // Only the native outer app advertises URL handling. Explicit empty arrays
    // also remove any associations inherited from Electron's template plist.
    ...(platform === 'darwin' ? {
      extendInfo: { CFBundleURLTypes: [], CFBundleDocumentTypes: [] },
      ...(identity ? { osxSign: { identity, optionsForFile: () => ({ hardenedRuntime: true }) } } : {}),
    } : {}),
  };
}

export function macMinimum(plist) {
  const reported = plist.LSMinimumSystemVersion || minimumMacOS;
  if (!/^\d+(?:\.\d+){0,2}$/.test(reported)) throw new Error(`Invalid Electron macOS minimum: ${reported}`);
  const parts = value => value.split('.').map(Number);
  const actual = parts(reported);
  const baseline = parts(minimumMacOS);
  for (let i = 0; i < 3; i++) {
    if ((actual[i] || 0) > (baseline[i] || 0)) return reported;
    if ((actual[i] || 0) < (baseline[i] || 0)) return minimumMacOS;
  }
  return reported;
}

export async function build(options, {
  root = appRoot, repository = repoRoot, execute = run, api = buildAPI,
  packageElectron, hostPlatform = process.platform, env = process.env,
} = {}) {
  const metadata = await manifest(root);
  const version = options.version || metadata.version;
  parseOptions([], { ...options, version });
  if (options.platform === 'darwin' && hostPlatform !== 'darwin') {
    throw new Error('macOS builds require macOS, Xcode Command Line Tools, and CGO');
  }
  if (options.platform === 'darwin' && env.PWRFINICKY_NOTARY_PROFILE
      && (!env.PWRFINICKY_SIGN_IDENTITY || env.PWRFINICKY_SIGN_IDENTITY === '-')) {
    throw new Error('PWRFINICKY_NOTARY_PROFILE requires PWRFINICKY_SIGN_IDENTITY');
  }
  for (const file of ['main.cjs', 'preload.cjs', 'renderer/index.html']) {
    await requireFile(path.join(root, file), 'integrate the Settings application before building');
  }
  const goRoot = path.join(repository, 'apps', 'finicky', 'src');
  await requireFile(path.join(goRoot, 'cmd', 'pwrfinicky'), 'integrate the native Go router before building');
  if (!options.skipApi) await api({ root: repository, execute });
  await requireFile(path.join(goRoot, 'router', 'config-api.js'), 'run npm run build:api');

  const buildRoot = path.join(root, 'build');
  await mkdir(buildRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(buildRoot, '.staging-'));
  const final = path.join(buildRoot, productName(options));
  try {
    const source = path.join(temporary, 'source');
    await mkdir(source);
    for (const file of ['main.cjs', 'preload.cjs', 'renderer']) {
      await cp(path.join(root, file), path.join(source, file), { recursive: true });
    }
    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: metadata.name, productName: settingsName, version, private: true,
      description: metadata.description, author: metadata.author, main: 'main.cjs',
    }, null, 2) + '\n');
    const packager = packageElectron || (await import('@electron/packager')).packager;
    const [packaged] = await packager(packagerOptions({
      source, output: path.join(temporary, 'electron'), ...options, version,
      electronVersion: metadata.devDependencies.electron,
      identity: env.PWRFINICKY_SIGN_IDENTITY === '-' ? undefined : env.PWRFINICKY_SIGN_IDENTITY,
    }));
    if (!packaged) throw new Error('Electron Packager did not produce an application');
    const product = path.join(temporary, productName(options));
    let executable;
    let helper;
    let minimum = minimumMacOS;
    if (options.platform === 'darwin') {
      const contents = path.join(product, 'Contents');
      await mkdir(path.join(contents, 'MacOS'), { recursive: true });
      await mkdir(path.join(contents, 'Resources'), { recursive: true });
      helper = path.join(contents, 'Resources', `${settingsName}.app`);
      await rename(path.join(packaged, `${settingsName}.app`), helper);
      const info = JSON.parse(await execute('plutil', [
        '-convert', 'json', '-o', '-', path.join(helper, 'Contents', 'Info.plist'),
      ], { capture: true }));
      if (info.CFBundleURLTypes?.length || info.CFBundleDocumentTypes?.length) {
        throw new Error('Settings helper unexpectedly registers URL or document handlers');
      }
      minimum = macMinimum(info);
      await writeFile(path.join(contents, 'Info.plist'), outerPlist(version, minimum));
      await writeFile(path.join(contents, 'PkgInfo'), 'APPL????');
      executable = path.join(contents, 'MacOS', 'PwrFinicky');
    } else {
      await mkdir(product);
      await rename(packaged, path.join(product, 'settings'));
      executable = path.join(product, options.platform === 'win32' ? 'pwrfinicky.exe' : 'pwrfinicky');
      if (options.platform === 'linux') {
        await writeFile(path.join(product, 'pwrfinicky.desktop'), desktopFile);
      }
    }
    await execute('go', [
      'build', '-trimpath', '-ldflags', `-s -w -X main.buildVersion=${version}${options.platform === 'win32' ? ' -H=windowsgui' : ''}`,
      '-o', executable, './cmd/pwrfinicky',
    ], { cwd: goRoot, env: goEnvironment(options, minimum) });
    await requireFile(executable, 'Go did not produce the native router');
    const buildInfo = options.platform === 'darwin'
      ? path.join(product, 'Contents', 'Resources', 'build-info.json')
      : path.join(product, 'build-info.json');
    await writeFile(buildInfo, JSON.stringify({
      platform: options.platform, arch: options.arch, version,
      electronVersion: metadata.devDependencies.electron,
      ...(options.platform === 'darwin' ? { minimumMacOS: minimum } : {}),
    }, null, 2) + '\n');
    await cp(path.join(repository, 'LICENSE'), path.join(path.dirname(buildInfo), 'LICENSE'));
    if (options.platform === 'darwin') {
      const identity = env.PWRFINICKY_SIGN_IDENTITY || '-';
      if (identity === '-') {
        await execute('codesign', ['--force', '--deep', '--sign', '-', helper]);
      }
      await execute('codesign', [
        '--force', '--sign', identity,
        ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp']), product,
      ]);
      await execute('codesign', ['--verify', '--deep', '--strict', product]);
      if (env.PWRFINICKY_NOTARY_PROFILE) {
        const zip = path.join(temporary, 'notarize.zip');
        await execute('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', product, zip]);
        await execute('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', env.PWRFINICKY_NOTARY_PROFILE, '--wait']);
        await execute('xcrun', ['stapler', 'staple', product]);
        await execute('xcrun', ['stapler', 'validate', product]);
      }
    }
    await rm(final, { recursive: true, force: true });
    await rename(product, final);
    console.log(`Built ${final}`);
    return final;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2), { version: process.env.PWRFINICKY_VERSION });
    if (options.help) console.log('Usage: npm run build -- [--platform darwin|win32|linux] [--arch arm64|x64] [--version 0.1.0] [--skip-api]');
    else await build(options);
  } catch (error) { fail(error); }
}
