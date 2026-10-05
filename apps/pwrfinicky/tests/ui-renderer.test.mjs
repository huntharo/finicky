import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createRenderer } from '../renderer/app.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => structuredClone(value);
const initialState = (extra = {}) => ({
  version: '1.0.0', platform: 'darwin', backendPid: 123,
  configPath: '/Users/example/.config/pwrfinicky/rules.json', rulesPath: '/Users/example/.config/pwrfinicky/rules.json',
  configError: '', isJSConfig: false,
  configState: { handlers: 1, rewrites: 0, defaultBrowser: 'Safari' },
  rules: { defaultBrowser: 'Safari', rules: [{ match: 'meet.google.com/*', browser: 'Google Chrome', profile: 'Work' }], options: { logRequests: true } },
  browsers: ['Safari', 'Google Chrome', 'Firefox'], history: [], capabilities: { senderApp: false, windowTitle: false },
  ...extra,
});

async function fixture(t, { state = initialState(), handlers = {}, start = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'https://local.invalid/' });
  const calls = [];
  let callback;
  let unsubscribed = false;
  let current = clone(state);
  const bridge = {
    onState(listener) { callback = listener; return () => { callback = undefined; unsubscribed = true; }; },
    async request(method, params) {
      calls.push({ method, params: clone(params) });
      if (handlers[method]) return handlers[method](params);
      switch (method) {
        case 'state': return clone(current);
        case 'getProfiles': return params.browser === 'Google Chrome' ? ['Personal', 'Work'] : [];
        case 'saveRules': current.rules = clone(params.rules); return clone(current);
        case 'test': return { url: params.url, browser: 'Google Chrome', profile: 'Work', args: [], openInBackground: false, durationMs: 2.5 };
        case 'dispatch': return { url: params.url, browser: 'Google Chrome', profile: 'Work', args: [], openInBackground: false, durationMs: 2.5, launchMs: 15 };
        case 'getDefaultStatus': return { isDefault: false, http: 'com.apple.Safari', https: 'com.apple.Safari' };
        case 'setDefaultBrowser': return { isDefault: true, http: 'com.pwrsuite.pwrfinicky', https: 'com.pwrsuite.pwrfinicky' };
        case 'useVisualRules': current.isJSConfig = false; return clone(current);
        case 'chooseConfig': current.isJSConfig = true; current.configPath = '/Users/example/.finicky.ts'; return clone(current);
        case 'reload': return clone(current);
        default: return undefined;
      }
    },
  };
  const root = dom.window.document.getElementById('app');
  const app = createRenderer(root, bridge);
  t.after(() => { app.destroy(); dom.window.close(); });
  const ui = {
    app, root, calls, dom,
    query: (selector) => root.querySelector(selector),
    all: (selector) => [...root.querySelectorAll(selector)],
    button(label) { return [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === label || node.getAttribute('aria-label') === label); },
    input(selector, value, event = 'input') {
      const node = root.querySelector(selector);
      assert.ok(node, `Missing input ${selector}`);
      node.value = value;
      node.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
      return node;
    },
    async click(label) {
      const node = this.button(label);
      assert.ok(node, `Missing button ${label}`);
      node.click();
      await flush();
    },
    async navigate(view) { root.querySelector(`[data-view="${view}"]`).click(); await flush(); },
    emit(next) { current = clone(next); callback?.(clone(next)); },
    getState: () => clone(current),
    count: (method) => calls.filter((call) => call.method === method).length,
    unsubscribed: () => unsubscribed,
  };
  if (start) { await app.start(); await flush(); }
  return ui;
}

test('entry uses local modules, a restrictive CSP, and no remote content', async () => {
  const html = await readFile(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /type="module" src="\.\/main\.mjs"/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /(?:src|href)="https?:/);
});

test('initial load selects Routing and loads browser profiles without any writes', async (t) => {
  const ui = await fixture(t);
  assert.equal(ui.query('[aria-current="page"]').textContent, 'Routing');
  assert.equal(ui.query('#default-browser').value, 'Safari');
  assert.equal(ui.query('.rule-card select').value, 'Google Chrome');
  assert.equal(ui.query('.rule-card [data-profile-browser]').value, 'Work');
  assert.equal(ui.query('#save-rules').disabled, true);
  assert.deepEqual(ui.calls.map((call) => call.method).sort(), ['getProfiles', 'getProfiles', 'state']);
  assert.equal(ui.query('#view-routing').hidden, false);
  assert.equal(ui.query('#view-test').hidden, true);
});

test('multiple wildcard patterns and destination profiles only persist on explicit save', async (t) => {
  const ui = await fixture(t);
  ui.input('.patterns-input', 'meet.google.com/*\n  *.work.example/*  \n');
  ui.input('#default-browser', 'Google Chrome', 'change');
  await flush();
  ui.input('#default-profile', 'Personal', 'change');
  assert.equal(ui.count('saveRules'), 0);
  assert.equal(ui.query('#save-rules').disabled, false);
  await ui.click('Save rules');
  assert.deepEqual(ui.calls.find((call) => call.method === 'saveRules').params.rules, {
    defaultBrowser: 'Google Chrome', defaultProfile: 'Personal',
    rules: [{ match: ['meet.google.com/*', '*.work.example/*'], browser: 'Google Chrome', profile: 'Work' }], options: { logRequests: true },
  });
  assert.equal(ui.query('#save-rules').disabled, true);
  assert.match(ui.query('.notice').textContent, /Rules saved/);
});

test('rule controls add, validate, reorder, and delete with accessible boundary buttons', async (t) => {
  const ui = await fixture(t);
  await ui.click('Add rule');
  assert.equal(ui.all('.rule-card').length, 2);
  await ui.click('Save rules');
  assert.equal(ui.count('saveRules'), 0);
  assert.match(ui.query('.validation-message').textContent, /Rule 2 needs at least one pattern/);
  assert.equal(ui.all('.patterns-input')[1].getAttribute('aria-invalid'), 'true');
  ui.input(`#${ui.all('.patterns-input')[1].id}`, 'github.com/*');
  assert.equal(ui.button('Move rule 1 up').disabled, true);
  assert.equal(ui.button('Move rule 2 down').disabled, true);
  await ui.click('Move rule 2 up');
  assert.equal(ui.query('.patterns-input').value, 'github.com/*');
  await ui.click('Delete rule 2');
  assert.equal(ui.all('.rule-card').length, 1);
  await ui.click('Save rules');
  assert.equal(ui.calls.find((call) => call.method === 'saveRules').params.rules.rules[0].match, 'github.com/*');
});

test('live state preserves unsaved input and focus while surfacing persistent config errors', async (t) => {
  const ui = await fixture(t);
  const input = ui.input('.patterns-input', '*.unsaved.example/*');
  input.focus();
  const updated = initialState({ isJSConfig: true, configError: 'SyntaxError: <img src=x onerror=alert(1)>', history: [{ id: '1', dryRun: false, success: true, time: '2026-10-05T03:00:00Z', url: 'https://example.com', browser: 'Safari', durationMs: 23 }] });
  ui.emit(updated);
  assert.equal(ui.query('.patterns-input'), input);
  assert.equal(ui.dom.window.document.activeElement, input);
  assert.equal(input.value, '*.unsaved.example/*');
  assert.equal(ui.query('.config-alert').hidden, false);
  assert.match(ui.query('.config-error-text').textContent, /<img src=x/);
  assert.equal(ui.query('img'), null);
  assert.match(ui.query('.source-callout').textContent, /takes precedence/);
  await ui.navigate('activity');
  assert.equal(ui.query('.config-alert').hidden, false);
  assert.equal(ui.all('.history-entry').length, 1);
  await ui.navigate('routing');
  assert.equal(ui.query('.patterns-input').value, '*.unsaved.example/*');
});

test('clean visual rules follow live snapshots and Revert restores the newest saved rules', async (t) => {
  const ui = await fixture(t);
  const next = initialState({ rules: { defaultBrowser: 'Firefox', rules: [{ match: 'new.example/*', browser: 'Safari' }] } });
  ui.emit(next);
  assert.equal(ui.query('#default-browser').value, 'Firefox');
  ui.input('.patterns-input', 'draft.example/*');
  next.rules.rules[0].match = 'latest.example/*';
  ui.emit(next);
  assert.equal(ui.query('.patterns-input').value, 'draft.example/*');
  await ui.click('Revert');
  assert.equal(ui.query('.patterns-input').value, 'latest.example/*');
  assert.equal(ui.query('#save-rules').disabled, true);
});

test('unchanged live rules preserve clean input focus and update available browsers in place', async (t) => {
  const ui = await fixture(t);
  const input = ui.query('.patterns-input');
  input.focus();
  const next = initialState({ browsers: ['Safari', 'Google Chrome', 'Firefox', 'Arc'] });
  ui.emit(next);
  assert.equal(ui.query('.patterns-input'), input);
  assert.equal(ui.dom.window.document.activeElement, input);
  assert.ok([...ui.query('#default-browser').options].some((option) => option.value === 'Arc'));
  assert.equal(ui.query('#save-rules').disabled, true);
});

test('editing while a save is pending preserves the later draft, including edits back to the old baseline', async (t) => {
  let resolveSave;
  const pending = new Promise((resolve) => { resolveSave = resolve; });
  const ui = await fixture(t, { handlers: { saveRules: () => pending } });
  ui.input('.patterns-input', 'saved.example/*');
  await ui.click('Save rules');
  assert.equal(ui.query('#save-rules').disabled, true);
  ui.input('.patterns-input', 'meet.google.com/*');
  const next = initialState();
  next.rules.rules[0].match = 'saved.example/*';
  ui.emit(next);
  resolveSave(next);
  await flush();
  assert.equal(ui.query('.patterns-input').value, 'meet.google.com/*');
  assert.equal(ui.query('#save-rules').disabled, false);
});

test('failed saves retain edits and show actionable errors', async (t) => {
  const ui = await fixture(t, { handlers: { saveRules: () => { throw new Error('Permission denied for rules.json'); } } });
  ui.input('.patterns-input', 'draft.example/*');
  await ui.click('Save rules');
  assert.equal(ui.query('.patterns-input').value, 'draft.example/*');
  assert.equal(ui.query('#save-rules').disabled, false);
  assert.match(ui.query('.validation-message').textContent, /Rules were not saved.*Permission denied/);
});

test('profile requests follow the selected browser and failed lookups preserve saved profiles', async (t) => {
  const state = initialState();
  state.rules.defaultBrowser = 'Google Chrome';
  state.rules.defaultProfile = 'Private profile';
  const ui = await fixture(t, { state, handlers: { getProfiles: () => { throw new Error('Profile file unreadable'); } } });
  assert.equal(ui.query('#default-profile').value, 'Private profile');
  assert.match(ui.query('#default-profile-hint').textContent, /preserved/);
  ui.input('#default-browser', 'Firefox', 'change');
  await flush();
  assert.equal(ui.query('#default-profile').value, '');
  assert.ok(ui.calls.some((call) => call.method === 'getProfiles' && call.params.browser === 'Firefox'));
});

test('reload retries profile discovery without overwriting an unsaved rule', async (t) => {
  let available = false;
  const ui = await fixture(t, { handlers: { getProfiles: () => { if (!available) throw new Error('Unavailable'); return ['Recovered profile']; } } });
  ui.input('.patterns-input', 'draft.example/*');
  available = true;
  await ui.navigate('settings');
  await ui.click('Reload configuration');
  await ui.navigate('routing');
  assert.equal(ui.query('.patterns-input').value, 'draft.example/*');
  assert.ok([...ui.query('#default-profile').options].some((option) => option.value === 'Recovered profile'));
});

test('profile loading is visible and late results cannot populate another selected browser', async (t) => {
  let resolveChrome;
  const ui = await fixture(t, { handlers: { getProfiles: ({ browser }) => browser === 'Google Chrome' ? new Promise((resolve) => { resolveChrome = resolve; }) : [] } });
  const profile = ui.query('.rule-card [data-profile-browser]');
  assert.equal(profile.disabled, true);
  assert.match(profile.parentElement.textContent, /Loading profiles/);
  ui.input(`#${ui.query('.rule-card [data-browser-select]').id}`, 'Firefox', 'change');
  await flush();
  resolveChrome(['Chrome only']);
  await flush();
  assert.equal(ui.query('.rule-card [data-profile-browser]').disabled, false);
  assert.doesNotMatch(ui.query('.rule-card [data-profile-browser]').textContent, /Chrome only/);
});

test('Test is a dry run and only the separate Open button dispatches', async (t) => {
  const ui = await fixture(t);
  await ui.navigate('test');
  ui.input('#test-url', 'https://meet.google.com/hello');
  await ui.click('Test link');
  assert.equal(ui.count('test'), 1);
  assert.equal(ui.count('dispatch'), 0);
  assert.match(ui.query('.route-result').textContent, /Google Chrome/);
  assert.match(ui.query('.route-result').textContent, /Work/);
  assert.match(ui.query('.route-result').textContent, /2.5 ms/);
  await ui.click('Open link');
  assert.equal(ui.count('dispatch'), 1);
  assert.deepEqual(ui.calls.find((call) => call.method === 'dispatch').params, { url: 'https://meet.google.com/hello' });
  assert.match(ui.query('.route-result').textContent, /15 ms/);
  assert.equal(ui.all('.history-entry').length, 0, 'UI must not fabricate dispatch history');
});

test('invalid links are rejected locally and changed input invalidates a successful dry run', async (t) => {
  const ui = await fixture(t);
  await ui.navigate('test');
  ui.input('#test-url', 'example.com');
  await ui.click('Test link');
  assert.equal(ui.count('test'), 0);
  assert.equal(ui.query('#test-url').getAttribute('aria-invalid'), 'true');
  ui.input('#test-url', 'https://example.com');
  await ui.click('Test link');
  assert.ok(ui.query('#open-link'));
  ui.input('#test-url', 'https://other.example.com');
  assert.equal(ui.query('#open-link'), null);
  assert.equal(ui.count('dispatch'), 0);
});

test('late test responses do not replace changed input or enable opening a stale result', async (t) => {
  let resolveTest;
  const ui = await fixture(t, { handlers: { test: () => new Promise((resolve) => { resolveTest = resolve; }) } });
  await ui.navigate('test');
  ui.input('#test-url', 'https://first.example');
  await ui.click('Test link');
  ui.input('#test-url', 'https://second.example');
  resolveTest({ url: 'https://first.example', browser: 'Safari', durationMs: 4 });
  await flush();
  assert.equal(ui.query('#open-link'), null);
  assert.equal(ui.query('.route-result'), null);
  assert.equal(ui.query('#test-link').disabled, false);
});

test('returned resolution errors and rejected launches are visible without unsafe HTML', async (t) => {
  const ui = await fixture(t, { handlers: { test: () => ({ error: '<img src=x onerror="alert(1)"> Bad config' }) } });
  await ui.navigate('test');
  ui.input('#test-url', 'https://example.com');
  await ui.click('Test link');
  assert.match(ui.query('.result-error').textContent, /<img/);
  assert.equal(ui.query('img'), null);
  assert.equal(ui.query('#open-link'), null);
  const other = await fixture(t, { handlers: { dispatch: () => ({ error: 'Browser is unavailable' }) } });
  await other.navigate('test');
  other.input('#test-url', 'https://example.com');
  await other.click('Test link');
  await other.click('Open link');
  assert.match(other.query('.notice.error').textContent, /Browser is unavailable/);
  assert.equal(other.query('#open-link').disabled, false);
});

test('resolved URL, arguments, browser, and profile are always rendered as text', async (t) => {
  const payload = '<img src=x onerror=alert(1)>';
  const ui = await fixture(t, { handlers: { test: () => ({ url: `https://example.com/${payload}`, browser: payload, profile: payload, args: [payload], durationMs: 0, openInBackground: true }) } });
  await ui.navigate('test');
  ui.input('#test-url', 'https://example.com');
  await ui.click('Test link');
  assert.equal(ui.query('img'), null);
  assert.match(ui.query('.route-result').textContent, /<img/);
  assert.match(ui.query('.route-result').textContent, /Open in background/);
});

test('Activity excludes dry runs, caps rows, filters failures, and exposes real timings', async (t) => {
  const history = [{ id: 'dry', dryRun: true, success: true, url: 'https://dry.example' }, ...Array.from({ length: 115 }, (_, i) => ({ id: String(i), time: '2026-10-05T02:00:00Z', url: `https://example.com/${i}`, browser: 'Safari', profile: '', durationMs: 22, resolveMs: 2, launchMs: 20, dryRun: false, success: i !== 2, error: i === 2 ? '<script>Bad launch</script>' : '', source: 'Finder' }))];
  const ui = await fixture(t, { state: initialState({ history }) });
  await ui.navigate('activity');
  assert.equal(ui.all('.history-entry').length, 100);
  assert.doesNotMatch(ui.query('.history-list').textContent, /dry.example/);
  await ui.click('Failed');
  assert.equal(ui.all('.history-entry').length, 1);
  assert.match(ui.query('.history-body').textContent, /Resolve2 msLaunch20 msTotal22 msSourceFinder/);
  assert.match(ui.query('.history-body').textContent, /<script>Bad launch/);
  assert.equal(ui.query('script'), null);
  ui.input('#history-search', 'does-not-exist');
  assert.match(ui.query('.history-list').textContent, /No links match this filter/);
});

test('live activity preserves an expanded row and its keyboard focus', async (t) => {
  const state = initialState({ history: [{ id: 'one', time: '2026-10-05T02:00:00Z', url: 'https://example.com', browser: 'Safari', success: true, dryRun: false, durationMs: 4, resolveMs: 1, launchMs: 3 }] });
  const ui = await fixture(t, { state });
  await ui.navigate('activity');
  ui.query('details').open = true;
  ui.query('summary').focus();
  ui.emit(state);
  assert.equal(ui.query('details').open, true);
  assert.equal(ui.dom.window.document.activeElement, ui.query('summary'));
});

test('Settings reports unsaved visual changes after revisiting the view', async (t) => {
  const ui = await fixture(t, { state: initialState({ isJSConfig: true }) });
  await ui.navigate('settings');
  await ui.navigate('routing');
  ui.input('.patterns-input', 'draft.example/*');
  await ui.navigate('settings');
  assert.match(ui.query('#view-settings').textContent, /unsaved visual edits/);
  assert.equal(ui.count('saveRules'), 0);
});

test('Settings makes precedence clear and system-default changes require an explicit click', async (t) => {
  const ui = await fixture(t, { state: initialState({ isJSConfig: true }) });
  await ui.navigate('settings');
  assert.equal(ui.count('getDefaultStatus'), 1);
  assert.equal(ui.count('setDefaultBrowser'), 0);
  assert.match(ui.query('#view-settings').textContent, /takes precedence/);
  assert.match(ui.query('#view-settings').textContent, /John Sterling.*MIT license/);
  await ui.click('Set as default browser');
  assert.equal(ui.count('setDefaultBrowser'), 1);
  assert.equal(ui.query('#set-default-browser').disabled, true);
  await ui.click('Use visual rules');
  assert.equal(ui.count('useVisualRules'), 1);
  assert.equal(ui.query('#use-visual-rules').disabled, true);
  assert.match(ui.query('#view-settings').textContent, /Visual rules active/);
});

test('configuration chooser, file actions, reload, and upstream links use only the fixed bridge', async (t) => {
  const ui = await fixture(t);
  await ui.navigate('settings');
  await ui.click('Choose JS / TS config');
  assert.equal(ui.count('chooseConfig'), 1);
  assert.match(ui.query('.paths-list').textContent, /\.finicky.ts/);
  for (const label of ['Open config', 'Open data folder', 'Reload configuration', 'Upstream Finicky', 'MIT license']) await ui.click(label);
  assert.equal(ui.count('openConfig'), 1);
  assert.equal(ui.count('openDataDirectory'), 1);
  assert.equal(ui.count('reload'), 1);
  assert.deepEqual(ui.calls.filter((call) => call.method === 'openExternal').map((call) => call.params.url), ['https://github.com/johnste/finicky', 'https://github.com/johnste/finicky/blob/main/LICENSE']);
});

test('JS config saves explicitly say visual rules are still inactive', async (t) => {
  const ui = await fixture(t, { state: initialState({ isJSConfig: true }) });
  ui.input('.patterns-input', 'saved.example/*');
  await ui.click('Save rules');
  assert.match(ui.query('.notice').textContent, /JS \/ TS config is still active/);
  assert.equal(ui.count('useVisualRules'), 0);
});

test('a save with a config error does not claim the new rules are active', async (t) => {
  const ui = await fixture(t, { state: initialState({ configError: 'Could not load configuration' }) });
  ui.input('.patterns-input', 'saved.example/*');
  await ui.click('Save rules');
  assert.match(ui.query('.notice').textContent, /last good configuration is still active/);
  assert.equal(ui.query('.config-alert').hidden, false);
});

test('initial state failure provides a working retry and subscription disposal', async (t) => {
  let attempts = 0;
  const ui = await fixture(t, { handlers: { state: () => { if (!attempts++) throw new Error('Backend not ready'); return initialState(); } } });
  assert.match(ui.query('.loading-state').textContent, /Backend not ready/);
  await ui.click('Try again');
  assert.equal(ui.query('.loading-state').hidden, true);
  assert.equal(ui.query('#view-routing').hidden, false);
  ui.app.destroy();
  assert.equal(ui.unsubscribed(), true);
});

test('a newer subscription snapshot wins over a stale initial state response', async (t) => {
  let resolveState;
  const ui = await fixture(t, { start: false, handlers: { state: () => new Promise((resolve) => { resolveState = resolve; }) } });
  const ready = ui.app.start();
  await flush();
  ui.emit(initialState({ rules: { defaultBrowser: 'Firefox', rules: [] } }));
  resolveState(initialState());
  await ready;
  assert.equal(ui.query('#default-browser').value, 'Firefox');
});

test('keyboard save uses the same explicit save path, and empty rules are usable', async (t) => {
  const ui = await fixture(t, { state: initialState({ rules: { defaultBrowser: 'Safari', rules: [] }, browsers: [] }) });
  assert.match(ui.query('.rules-list').textContent, /Create your first rule/);
  assert.equal(ui.query('.inline-warning').hidden, false);
  await ui.click('Create your first rule');
  ui.input('.patterns-input', 'example.com/*');
  ui.dom.window.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true }));
  await flush();
  assert.equal(ui.count('saveRules'), 1);
});
