import {
  HISTORY_LIMIT, browserChoices, createDraft, duration, errorMessage, moveRule,
  newRule, rulesFingerprint, toRulesFile, validateDraft, validateUrl, visibleHistory,
} from './model.mjs';

const ICONS = {
  route: 'M4 6h10a4 4 0 0 1 0 8H9m3-3-3 3 3 3M4 3v6m0 9h.01M20 3v6',
  test: 'M9 3h6m-5 0v6L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9V3M8 14h8',
  activity: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6M12 7v5l3 2',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  up: 'm6 14 6-6 6 6',
  down: 'm6 10 6 6 6-6',
  trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  check: 'm5 12 4 4L19 6',
  warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3h.01',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
  close: 'm6 6 12 12M6 18 18 6',
  folder: 'M3 6h7l2 3h9v11H3V6Z',
  code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',
};

const VIEW_META = {
  routing: ['Routing', 'A little order for every link.'],
  test: ['Test a link', 'See where a link goes before you open it.'],
  activity: ['Activity', 'A live view of the links you open.'],
  settings: ['Settings', 'Make PwrFinicky feel at home.'],
};

export function createRenderer(root, bridge) {
  if (!root) throw new Error('PwrFinicky needs a root element.');
  const document = root.ownerDocument;
  const window = document.defaultView;
  let snapshot = null;
  let draft = null;
  let baseline = '';
  let dirty = false;
  let draftRevision = 0;
  let saving = false;
  let activeView = 'routing';
  let destroyed = false;
  let started = false;
  let unsubscribe = () => {};
  let unsubscribeConnection = () => {};
  let stateEvents = 0;
  let testGeneration = 0;
  let testBusy = false;
  let dispatchBusy = false;
  let testResult = null;
  let testedInput = '';
  let historyFilter = 'all';
  let defaultStatus = null;
  let defaultStatusError = '';
  let defaultStatusBusy = false;
  let actionBusy = '';
  let sourceRenderKey = '';
  const profileCache = new Map();
  const refs = {};

  function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === undefined || value === null || value === false) continue;
      if (name === 'class') node.className = value;
      else if (name === 'hidden' || name === 'disabled' || name === 'checked') node[name] = Boolean(value);
      else node.setAttribute(name, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child && child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(key, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name] || ICONS.globe);
    svg.append(path);
    return svg;
  }

  function button(label, { icon: iconName, className = 'button', ...attributes } = {}, handler) {
    const node = el('button', { type: 'button', class: className, ...attributes }, iconName && icon(iconName), el('span', {}, label));
    if (handler) node.addEventListener('click', handler);
    return node;
  }

  function iconButton(label, name, handler, disabled = false) {
    return button(label, { icon: name, className: 'icon-button', 'aria-label': label, title: label, disabled }, handler);
  }

  function field(label, input, hint) {
    return el('div', { class: 'field' }, el('label', { for: input.id }, label), input, hint && el('span', { class: 'field-hint' }, hint));
  }

  function badge(text, tone = '') {
    return el('span', { class: `badge ${tone}` }, text);
  }

  function emptyState(name, title, description, action) {
    return el('div', { class: 'empty-state' }, el('div', { class: 'empty-icon' }, icon(name)), el('h3', {}, title), el('p', {}, description), action);
  }

  function request(method, params = {}) {
    return Promise.resolve().then(() => {
      if (!bridge || typeof bridge.request !== 'function') throw new Error('The PwrFinicky bridge is unavailable. Open this window from the desktop app.');
      return bridge.request(method, params);
    });
  }

  function notify(message, tone = 'success') {
    if (destroyed) return;
    refs.notice.hidden = false;
    refs.notice.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    refs.notice.className = `notice ${tone}`;
    refs.notice.replaceChildren(icon(tone === 'error' ? 'warning' : 'check'), el('span', {}, message), iconButton('Dismiss notification', 'close', () => { refs.notice.hidden = true; }));
  }

  function buildShell() {
    refs.navButtons = {};
    const navigation = el('nav', { class: 'navigation', 'aria-label': 'Main navigation' });
    for (const [key, [title]] of Object.entries(VIEW_META)) {
      const navButton = button(title, { icon: key === 'routing' ? 'route' : key, className: 'nav-item', 'aria-label': title, title, 'aria-controls': `view-${key}`, 'data-view': key }, () => setView(key));
      if (key === 'routing') {
        refs.draftDot = el('span', { class: 'draft-dot', hidden: true, 'aria-label': 'Unsaved changes' });
        navButton.append(refs.draftDot);
      }
      if (key === 'activity') {
        refs.activityCount = el('span', { class: 'nav-count' }, '0');
        navButton.append(refs.activityCount);
      }
      refs.navButtons[key] = navButton;
      navigation.append(navButton);
    }
    refs.connection = el('span', {}, 'Connecting…');
    refs.connectionStatus = el('div', { class: 'connection', 'data-status': 'loading' }, el('span', { class: 'connection-dot' }), refs.connection);
    refs.source = el('span', { class: 'sidebar-source' }, 'Waiting for configuration');
    const sidebar = el('aside', { class: 'sidebar' },
      el('div', { class: 'brand' }, el('div', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('route')), el('div', {}, el('strong', {}, 'PwrFinicky'), el('span', { class: 'brand-caption' }, 'LINKS, IN THEIR PLACE.'))),
      el('div', { class: 'nav-caption' }, 'WORKSPACE'), navigation,
      el('div', { class: 'sidebar-bottom' }, refs.connectionStatus, refs.source, el('span', { class: 'suite-label' }, 'PART OF PWR SUITE')),
    );
    refs.title = el('h1', { tabindex: '-1' }, VIEW_META.routing[0]);
    refs.subtitle = el('p', { class: 'page-subtitle' }, VIEW_META.routing[1]);
    refs.mode = badge('Connecting', 'muted');
    const header = el('header', { class: 'page-header' }, el('div', {}, refs.title, refs.subtitle), refs.mode);
    refs.configAlert = el('div', { class: 'config-alert', role: 'alert', hidden: true });
    refs.notice = el('div', { class: 'notice', hidden: true, 'aria-live': 'polite' });
    refs.loading = el('div', { class: 'loading-state', role: 'status' }, el('div', { class: 'loading-orbit', 'aria-hidden': 'true' }, icon('route')), el('h2', {}, 'Getting your routes ready'), el('p', {}, 'Connecting to PwrFinicky…'));
    refs.views = {};
    const views = el('div', { class: 'views' });
    for (const [key, [title]] of Object.entries(VIEW_META)) {
      refs.views[key] = el('section', { id: `view-${key}`, class: 'view', 'aria-label': title, hidden: true });
      views.append(refs.views[key]);
    }
    const main = el('main', { class: 'main' }, header, refs.configAlert, refs.notice, refs.loading, views);
    root.replaceChildren(el('div', { class: 'app-shell' }, sidebar, main));
    buildRouting();
    buildTest();
    buildActivity();
    setView('routing', false);
  }

  function setView(view, focus = true) {
    activeView = view;
    for (const [key, node] of Object.entries(refs.views)) {
      node.hidden = !snapshot || key !== view;
      if (key === view) refs.navButtons[key].setAttribute('aria-current', 'page');
      else refs.navButtons[key].removeAttribute('aria-current');
    }
    refs.title.textContent = VIEW_META[view][0];
    refs.subtitle.textContent = VIEW_META[view][1];
    if (focus) refs.title.focus();
    if (view === 'settings' && snapshot) renderSettings();
    if (view === 'settings' && snapshot && !defaultStatus && !defaultStatusBusy && !defaultStatusError) refreshDefaultStatus();
  }

  function updateSource() {
    const isJS = Boolean(snapshot.isJSConfig);
    refs.connection.textContent = snapshot.configError ? 'Using last good config' : 'Ready to route';
    refs.connectionStatus.setAttribute('data-status', snapshot.configError ? 'warning' : 'ready');
    refs.source.textContent = isJS ? 'JavaScript / TypeScript config' : 'Visual rules are active';
    refs.mode.textContent = isJS ? 'JS / TS config' : 'Visual rules';
    refs.mode.className = `badge ${isJS ? 'violet' : 'mint'}`;
    const nextSourceKey = JSON.stringify([isJS, snapshot.configError, Boolean(actionBusy)]);
    if (nextSourceKey === sourceRenderKey) return;
    sourceRenderKey = nextSourceKey;
    refs.routingSource.replaceChildren();
    if (isJS) {
      refs.routingSource.append(el('div', { class: 'source-callout' }, icon('code'), el('div', {}, el('strong', {}, 'Your JS / TS config is in charge'), el('p', {}, 'It takes precedence: JS / TS handlers run first, then these visual rules. The JS / TS file controls the default destination.')), button('Settings', { className: 'button subtle small', icon: 'arrow' }, () => setView('settings'))));
    }
    refs.configAlert.hidden = !snapshot.configError;
    if (snapshot.configError) {
      if (refs.notice.classList.contains('success')) refs.notice.hidden = true;
      refs.configAlert.replaceChildren(icon('warning'), el('div', { class: 'alert-content' }, el('strong', {}, 'Configuration needs attention'), el('p', {}, 'The last good configuration is still routing links.'), el('pre', { class: 'config-error-text' }, String(snapshot.configError))), button('Retry reload', { className: 'button small', icon: 'refresh', disabled: Boolean(actionBusy) }, () => runAction('reload', 'Configuration reloaded.')));
    }
  }

  function applySnapshot(next) {
    if (destroyed) return;
    if (!next || typeof next !== 'object' || !next.rules || typeof next.rules !== 'object') throw new Error('PwrFinicky returned an incomplete state. Try reloading the window.');
    const preserveDraft = Boolean(draft && (dirty || saving));
    const nextBaseline = rulesFingerprint(next.rules);
    const replaceDraft = !draft || (!preserveDraft && baseline !== nextBaseline);
    const browsersChanged = JSON.stringify(snapshot?.browsers) !== JSON.stringify(next.browsers);
    snapshot = next;
    baseline = nextBaseline;
    refs.loading.hidden = true;
    if (replaceDraft) {
      draft = createDraft(snapshot.rules);
      renderRules();
    } else if (browsersChanged) {
      for (const select of root.querySelectorAll('[data-browser-select]')) fillBrowser(select, select.value);
      refs.browserWarning.hidden = Boolean(snapshot.browsers?.length);
    }
    for (const select of root.querySelectorAll('[data-profile-browser]')) ensureProfiles(select.getAttribute('data-profile-browser'));
    updateDirty();
    updateSource();
    renderActivity();
    renderSettings();
    setView(activeView, false);
    if (defaultStatus?.pending && !defaultStatusBusy) refreshDefaultStatus();
  }

  function browserSelect(id, value, onChange) {
    const select = el('select', { id, class: 'select', 'data-browser-select': 'true' });
    fillBrowser(select, value);
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function fillBrowser(select, value) {
    select.replaceChildren();
    if (!value) select.append(el('option', { value: '' }, 'Choose a browser'));
    for (const name of browserChoices(snapshot?.browsers, value)) select.append(el('option', { value: name }, name));
    select.value = value;
  }

  function profileField(id, browser, value, onChange) {
    const select = el('select', { id, class: 'select', 'data-profile-browser': browser, 'aria-describedby': `${id}-hint` });
    const hint = el('span', { id: `${id}-hint`, class: 'field-hint' });
    const node = el('div', { class: 'field profile-field' }, el('label', { for: id }, 'Profile'), select, hint);
    select._profileValue = value;
    select._profileHint = hint;
    select.addEventListener('change', () => {
      select._profileValue = select.value;
      onChange(select.value);
    });
    ensureProfiles(browser);
    fillProfile(select);
    return node;
  }

  function fillProfile(select) {
    const browser = select.getAttribute('data-profile-browser');
    const cached = profileCache.get(browser);
    const selected = select._profileValue || '';
    select.replaceChildren(el('option', { value: '' }, 'Default profile'));
    for (const profile of browserChoices(cached?.profiles, selected)) select.append(el('option', { value: profile }, profile));
    select.value = selected;
    select.disabled = !browser || cached?.status === 'loading';
    select._profileHint.textContent = cached?.status === 'loading' ? 'Loading profiles…' : cached?.status === 'error' ? 'Profiles unavailable. The saved profile is preserved.' : 'Optional · use a separate browser profile.';
    select._profileHint.title = cached?.error || '';
  }

  function ensureProfiles(browser) {
    if (!browser || profileCache.has(browser)) return;
    profileCache.set(browser, { status: 'loading', profiles: [] });
    const refresh = () => {
      if (destroyed) return;
      for (const select of root.querySelectorAll('[data-profile-browser]')) {
        if (select.getAttribute('data-profile-browser') === browser) fillProfile(select);
      }
    };
    refresh();
    request('getProfiles', { browser }).then((profiles) => {
      profileCache.set(browser, { status: 'ready', profiles: Array.isArray(profiles) ? profiles.filter((profile) => typeof profile === 'string') : [] });
      refresh();
    }).catch((error) => {
      profileCache.set(browser, { status: 'error', profiles: [], error: errorMessage(error) });
      refresh();
    });
  }

  function buildRouting() {
    refs.routingSource = el('div');
    refs.defaultFields = el('div', { class: 'default-fields' });
    refs.browserWarning = el('p', { class: 'inline-warning', hidden: true }, 'No browsers detected. Reload after installing a browser.');
    const defaultCard = el('div', { class: 'card default-card' }, el('div', { class: 'card-heading' }, el('span', { class: 'section-icon' }, icon('globe')), el('div', {}, el('h2', {}, 'Default destination'), el('p', {}, 'Where links go when no rule matches.'))), refs.defaultFields, refs.browserWarning);
    refs.ruleCount = badge('0 rules', 'muted');
    refs.addRule = button('Add rule', { id: 'add-rule', icon: 'plus', className: 'button small' }, addRule);
    const rulesHeading = el('div', { class: 'section-heading' }, el('div', {}, el('div', { class: 'heading-line' }, el('h2', {}, 'Routing rules'), refs.ruleCount), el('p', {}, 'First match wins. Put your most specific rules first.')), refs.addRule);
    refs.rulesList = el('div', { class: 'rules-list', 'aria-label': 'Ordered routing rules' });
    refs.validation = el('div', { class: 'validation-message', role: 'alert', hidden: true });
    refs.saveStatus = el('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' });
    refs.revert = button('Revert', { id: 'revert-rules', className: 'button subtle' }, () => {
      if (saving) return;
      draft = createDraft(snapshot.rules);
      draftRevision++;
      clearValidation();
      renderRules();
      updateDirty();
    });
    refs.save = button('Save rules', { id: 'save-rules', icon: 'check', className: 'button primary', type: 'submit', disabled: true });
    const footer = el('div', { class: 'save-footer' }, refs.validation, el('div', { class: 'save-bar' }, refs.saveStatus, el('div', { class: 'button-row' }, refs.revert, refs.save)));
    const form = el('form', { id: 'rules-form', novalidate: true }, defaultCard, rulesHeading, refs.rulesList, footer);
    form.addEventListener('submit', (event) => { event.preventDefault(); saveRules(); });
    refs.views.routing.append(refs.routingSource, form);
  }

  function changed() {
    draftRevision++;
    if (refs.notice.classList.contains('success')) refs.notice.hidden = true;
    clearValidation();
    updateDirty();
  }

  function updateDirty() {
    dirty = Boolean(draft && rulesFingerprint(toRulesFile(draft)) !== baseline);
    refs.draftDot.hidden = !dirty;
    refs.saveStatus.replaceChildren(el('span', { class: `status-dot ${dirty ? 'amber' : 'mint'}` }), saving ? 'Saving rules…' : dirty ? 'Unsaved changes' : 'All changes saved');
    refs.save.disabled = !dirty || saving;
    refs.save.querySelector('span').textContent = saving ? 'Saving…' : 'Save rules';
    refs.revert.disabled = !dirty || saving;
  }

  function clearValidation() {
    refs.validation.hidden = true;
    for (const invalid of root.querySelectorAll('[aria-invalid="true"]')) {
      if (invalid !== refs.testInput) invalid.removeAttribute('aria-invalid');
    }
  }

  function renderRules(focusId) {
    if (!draft) return;
    const defaultBrowser = browserSelect('default-browser', draft.defaultBrowser, (value) => {
      draft.defaultBrowser = value;
      draft.defaultProfile = '';
      changed();
      renderRules('default-browser');
    });
    refs.defaultFields.replaceChildren(field('Browser', defaultBrowser), profileField('default-profile', draft.defaultBrowser, draft.defaultProfile, (value) => { draft.defaultProfile = value; changed(); }));
    refs.browserWarning.hidden = Boolean(snapshot?.browsers?.length);
    refs.ruleCount.textContent = `${draft.rules.length} ${draft.rules.length === 1 ? 'rule' : 'rules'}`;
    if (!draft.rules.length) {
      refs.rulesList.replaceChildren(emptyState('route', 'One browser for now. More when you need them.', 'Add a rule to send work links, meetings, or favorite sites to another browser.', button('Create your first rule', { icon: 'plus', className: 'button subtle' }, addRule)));
    } else {
      refs.rulesList.replaceChildren(...draft.rules.map((rule, index) => renderRule(rule, index)));
    }
    if (focusId) document.getElementById(focusId)?.focus();
  }

  function renderRule(rule, index) {
    const patterns = el('textarea', { id: `${rule.key}-patterns`, class: 'patterns-input', rows: 2, placeholder: 'meet.google.com/*\n*.work.example/*', spellcheck: 'false', autocapitalize: 'off', 'aria-describedby': `${rule.key}-hint` });
    patterns.value = rule.patterns;
    patterns.addEventListener('input', () => { rule.patterns = patterns.value; changed(); });
    const browser = browserSelect(`${rule.key}-browser`, rule.browser, (value) => {
      rule.browser = value;
      rule.profile = '';
      changed();
      renderRules(`${rule.key}-browser`);
    });
    const reorder = (direction) => {
      draft.rules = moveRule(draft.rules, rule.key, direction);
      changed();
      renderRules(`${rule.key}-patterns`);
    };
    const controls = el('div', { class: 'rule-controls' },
      iconButton(`Move rule ${index + 1} up`, 'up', () => reorder(-1), index === 0),
      iconButton(`Move rule ${index + 1} down`, 'down', () => reorder(1), index === draft.rules.length - 1),
      iconButton(`Delete rule ${index + 1}`, 'trash', () => {
        draft.rules = draft.rules.filter((item) => item.key !== rule.key);
        changed();
        renderRules();
        const next = draft.rules[Math.min(index, draft.rules.length - 1)];
        if (next) document.getElementById(`${next.key}-patterns`)?.focus();
        else refs.addRule.focus();
      }),
    );
    const heading = el('div', { class: 'rule-heading' }, el('div', { class: 'heading-line' }, el('span', { class: 'rule-number' }, String(index + 1).padStart(2, '0')), el('h3', { id: `${rule.key}-title` }, `Rule ${index + 1}`)), controls);
    return el('article', { class: 'card rule-card', 'aria-labelledby': `${rule.key}-title`, 'data-rule-key': rule.key }, heading,
      el('div', { class: 'rule-fields' }, el('div', { class: 'field pattern-field' }, el('label', { for: patterns.id }, 'URL patterns'), patterns, el('span', { id: `${rule.key}-hint`, class: 'field-hint' }, 'One wildcard pattern per line · any pattern can match.')),
        el('div', { class: 'destination-fields' }, field('Open in', browser), profileField(`${rule.key}-profile`, rule.browser, rule.profile, (value) => { rule.profile = value; changed(); }))),
    );
  }

  function addRule() {
    if (!draft) return;
    const rule = newRule(draft.defaultBrowser);
    draft.rules.push(rule);
    changed();
    renderRules(`${rule.key}-patterns`);
  }

  async function saveRules() {
    if (!dirty || saving || !draft) return;
    const errors = validateDraft(draft);
    if (errors.length) {
      refs.validation.hidden = false;
      refs.validation.textContent = errors.slice(0, 3).map((error) => error.message).join(' ') + (errors.length > 3 ? ` ${errors.length - 3} more fields need attention.` : '');
      for (const error of errors) document.getElementById(error.field)?.setAttribute('aria-invalid', 'true');
      document.getElementById(errors[0].field)?.focus();
      return;
    }
    const savedRevision = draftRevision;
    const rules = toRulesFile(draft);
    saving = true;
    updateDirty();
    try {
      const next = await request('saveRules', { rules });
      if (destroyed) return;
      applySnapshot(next);
      if (draftRevision === savedRevision) {
        draft = createDraft(next.rules);
        baseline = rulesFingerprint(next.rules);
        renderRules();
      }
      if (next.configError) notify('Rules saved. The last good configuration is still active.', 'info');
      else notify(next.isJSConfig ? 'Visual rules saved after your JS / TS handlers. Your JS / TS config is still active.' : 'Rules saved. Your next link will use them.');
    } catch (error) {
      if (!destroyed) {
        refs.validation.hidden = false;
        refs.validation.textContent = `Rules were not saved. ${errorMessage(error)}`;
      }
    } finally {
      saving = false;
      if (!destroyed) updateDirty();
    }
  }

  function buildTest() {
    refs.testInput = el('input', { id: 'test-url', type: 'url', placeholder: 'https://meet.google.com/your-meeting', class: 'url-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-describedby': 'test-hint test-error' });
    refs.testInput.addEventListener('input', () => {
      const hadResult = Boolean(testResult);
      testGeneration++;
      testResult = null;
      testedInput = '';
      refs.testError.hidden = true;
      refs.testInput.removeAttribute('aria-invalid');
      if (hadResult) renderTestResult();
      updateTestButtons();
    });
    refs.testError = el('p', { id: 'test-error', class: 'inline-error', role: 'alert', hidden: true });
    refs.testButton = button('Test link', { id: 'test-link', icon: 'test', className: 'button primary', type: 'submit' });
    const form = el('form', { class: 'card test-card', novalidate: true },
      el('label', { class: 'input-label', for: 'test-url' }, 'LINK TO TEST'),
      el('div', { class: 'test-input-row' }, refs.testInput, refs.testButton),
      el('p', { id: 'test-hint', class: 'field-hint' }, 'Uses your active configuration. Testing does not open a browser.'), refs.testError,
    );
    form.addEventListener('submit', (event) => { event.preventDefault(); testLink(); });
    refs.testOutput = el('div', { class: 'test-output', 'aria-live': 'polite', 'aria-atomic': 'true' });
    renderTestResult();
    refs.views.test.append(form, refs.testOutput);
  }

  function updateTestButtons() {
    refs.testButton.disabled = testBusy || dispatchBusy;
    refs.testButton.querySelector('span').textContent = testBusy ? 'Testing…' : 'Test link';
    if (refs.openButton) {
      refs.openButton.disabled = testBusy || dispatchBusy || !testResult || Boolean(testResult.error) || refs.testInput.value.trim() !== testedInput;
      refs.openButton.querySelector('span').textContent = dispatchBusy ? 'Opening…' : 'Open link';
    }
  }

  async function testLink() {
    if (testBusy || dispatchBusy) return;
    const url = refs.testInput.value.trim();
    const validation = validateUrl(url);
    if (validation) {
      refs.testError.textContent = validation;
      refs.testError.hidden = false;
      refs.testInput.setAttribute('aria-invalid', 'true');
      refs.testInput.focus();
      return;
    }
    const generation = ++testGeneration;
    refs.testError.hidden = true;
    refs.testInput.removeAttribute('aria-invalid');
    testBusy = true;
    testResult = null;
    testedInput = '';
    renderTestResult();
    updateTestButtons();
    try {
      const result = await request('test', { url });
      if (destroyed || generation !== testGeneration) return;
      if (!result || typeof result !== 'object') throw new Error('No test result was returned.');
      testResult = result;
      testedInput = url;
    } catch (error) {
      if (!destroyed && generation === testGeneration) {
        testResult = { url, error: errorMessage(error) };
        testedInput = url;
      }
    } finally {
      testBusy = false;
      if (!destroyed) { renderTestResult(); updateTestButtons(); }
    }
  }

  function dataPair(label, value, className = '') {
    return el('div', { class: `data-pair ${className}` }, el('dt', {}, label), el('dd', {}, value || '—'));
  }

  function renderTestResult() {
    refs.openButton = null;
    if (!testResult) {
      refs.testOutput.replaceChildren(emptyState('test', testBusy ? 'Finding the right destination…' : 'A safe place to try a link', testBusy ? 'Resolving against your active rules.' : 'Test a URL to see its browser, profile, and route timing. Open it only when you’re ready.'));
      return;
    }
    if (testResult.error) {
      refs.testOutput.replaceChildren(el('div', { class: 'card result-error', role: 'alert' }, icon('warning'), el('h2', {}, 'This link could not be resolved'), el('p', { class: 'break-anywhere' }, String(testResult.error)), el('p', { class: 'muted-text' }, 'Review your configuration and try again.')));
      return;
    }
    refs.openButton = button('Open link', { id: 'open-link', icon: 'external', className: 'button primary' }, openTestedLink);
    const details = el('dl', { class: 'result-details' },
      dataPair('Resolved URL', String(testResult.url || testedInput), 'full-width break-anywhere'),
      dataPair('Profile', testResult.profile || 'Default profile'),
      dataPair('Resolution', duration(testResult.durationMs)),
      dataPair('Window', testResult.openInBackground ? 'Open in background' : 'Bring to foreground'),
    );
    if (Array.isArray(testResult.args) && testResult.args.length) details.append(dataPair('Arguments', testResult.args.map(String).join(' '), 'full-width break-anywhere monospace'));
    if (testResult.launchMs !== undefined) details.append(dataPair('Launch', duration(testResult.launchMs)));
    refs.testOutput.replaceChildren(el('div', { class: 'card route-result' },
      el('div', { class: 'result-heading' }, el('span', { class: 'browser-avatar' }, icon('globe')), el('div', {}, el('p', { class: 'eyebrow' }, 'DESTINATION'), el('h2', { class: 'break-anywhere' }, testResult.browser || 'No browser selected')), badge('Resolved', 'mint')),
      details, el('div', { class: 'result-footer' }, el('span', { class: 'field-hint' }, 'Opening resolves the link again using the latest configuration.'), refs.openButton),
    ));
    updateTestButtons();
  }

  async function openTestedLink() {
    if (dispatchBusy || testBusy || !testResult || testResult.error || refs.testInput.value.trim() !== testedInput) return;
    const url = testedInput;
    const generation = testGeneration;
    dispatchBusy = true;
    updateTestButtons();
    try {
      const result = await request('dispatch', { url });
      if (result?.error) throw new Error(String(result.error));
      if (!result || typeof result !== 'object') throw new Error('No launch result was returned.');
      if (destroyed) return;
      if (generation === testGeneration) {
        testResult = result;
        renderTestResult();
      }
      notify(`Opened in ${result.browser || 'your browser'}.`);
    } catch (error) {
      notify(`The link could not be opened. ${errorMessage(error)}`, 'error');
    } finally {
      dispatchBusy = false;
      if (!destroyed) updateTestButtons();
    }
  }

  function buildActivity() {
    refs.historySummary = el('p', { class: 'field-hint' }, 'Recent dispatches');
    refs.historyFilters = {};
    const filters = el('div', { class: 'segmented-control', role: 'group', 'aria-label': 'Filter activity by status' });
    for (const [value, label] of [['all', 'All'], ['opened', 'Opened'], ['failed', 'Failed']]) {
      const control = button(label, { className: 'segment', 'aria-pressed': value === historyFilter ? 'true' : 'false' }, () => {
        historyFilter = value;
        renderActivity();
      });
      refs.historyFilters[value] = control;
      filters.append(control);
    }
    refs.historySearch = el('input', { id: 'history-search', type: 'search', class: 'search-input', placeholder: 'Filter links or browsers…', 'aria-label': 'Filter links or browsers' });
    refs.historySearch.addEventListener('input', renderActivity);
    refs.historyList = el('div', { class: 'history-list', 'aria-label': 'Link dispatch history' });
    refs.views.activity.append(el('div', { class: 'activity-toolbar' }, filters, refs.historySearch), refs.historySummary, refs.historyList);
  }

  function renderActivity() {
    const all = visibleHistory(snapshot?.history);
    const entries = visibleHistory(snapshot?.history, historyFilter, refs.historySearch.value);
    refs.activityCount.textContent = String(all.length);
    refs.historySummary.textContent = `${entries.length} ${entries.length === 1 ? 'dispatch' : 'dispatches'} · Latest ${HISTORY_LIMIT} opened links · Dry runs stay in Test a link`;
    for (const [value, control] of Object.entries(refs.historyFilters)) control.setAttribute('aria-pressed', String(value === historyFilter));
    const expanded = new Set([...refs.historyList.querySelectorAll('details[open]')].map((node) => node.getAttribute('data-history-id')));
    const focusedEntry = document.activeElement?.closest('[data-history-id]')?.getAttribute('data-history-id');
    if (!entries.length) {
      refs.historyList.replaceChildren(emptyState('activity', all.length ? 'No links match this filter' : 'Your next link starts here', all.length ? 'Try another browser, URL, or status.' : 'Opened links appear here with their destination, status, and timing.'));
      return;
    }
    refs.historyList.replaceChildren(...entries.map((entry) => {
      const time = new Date(entry.time);
      const validTime = Number.isFinite(time.getTime());
      const timestamp = validTime ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Unknown time';
      const details = el('details', { class: `history-entry ${entry.success ? '' : 'failed'}`, 'data-history-id': String(entry.id) });
      details.open = expanded.has(String(entry.id));
      details.append(el('summary', {},
        el('span', { class: `history-status ${entry.success ? 'mint' : 'red'}`, 'aria-hidden': 'true' }, icon(entry.success ? 'check' : 'warning')),
        el('span', { class: 'history-main' }, el('span', { class: 'history-url', title: String(entry.url || '') }, String(entry.url || 'Unknown URL')), el('span', { class: 'history-destination' }, String(entry.browser || 'Unresolved'), entry.profile ? ` · ${entry.profile}` : '')),
        el('span', { class: 'history-meta' }, badge(entry.success ? 'Opened' : 'Failed', entry.success ? 'mint' : 'red'), el('time', { datetime: validTime ? time.toISOString() : undefined, title: validTime ? time.toLocaleString() : 'Unknown time' }, timestamp)),
        el('span', { class: 'history-duration' }, duration(entry.durationMs)), icon('down'),
      ));
      const body = el('div', { class: 'history-body' }, el('p', { class: 'full-url break-anywhere' }, String(entry.url || '')), el('dl', { class: 'history-details' }, dataPair('Resolve', duration(entry.resolveMs)), dataPair('Launch', duration(entry.launchMs)), dataPair('Total', duration(entry.durationMs)), dataPair('Source', entry.source || 'Not provided')));
      if (entry.error) body.append(el('p', { class: 'inline-error break-anywhere' }, String(entry.error)));
      details.append(body);
      return details;
    }));
    if (focusedEntry) {
      [...refs.historyList.children].find((node) => node.getAttribute('data-history-id') === focusedEntry)?.querySelector('summary')?.focus();
    }
  }

  function settingHeading(name, title, description) {
    return el('div', { class: 'card-heading' }, el('span', { class: 'section-icon' }, icon(name)), el('div', {}, el('h2', {}, title), el('p', {}, description)));
  }

  function renderSettings() {
    if (!snapshot) return;
    const isJS = Boolean(snapshot.isJSConfig);
    const configCard = el('div', { class: 'card settings-card' }, settingHeading('code', 'Configuration', 'Choose how your routing rules are managed.'),
      el('div', { class: 'setting-status' }, badge(isJS ? 'JS / TS active' : 'Visual rules active', isJS ? 'violet' : 'mint'), el('p', {}, isJS ? 'Your JS / TS file takes precedence: its handlers run first, followed by saved visual rules. It also controls the default destination.' : 'Your saved visual rules are routing links.')),
      el('div', { class: 'button-row wrap' },
        button(actionBusy === 'chooseConfig' ? 'Choosing…' : 'Choose JS / TS config', { icon: 'folder', disabled: Boolean(actionBusy) }, () => runAction('chooseConfig')),
        button('Use visual rules', { id: 'use-visual-rules', className: 'button subtle', disabled: !isJS || Boolean(actionBusy) }, () => runAction('useVisualRules', 'Saved visual rules are now active.')),
      ),
      el('p', { class: 'field-hint' }, dirty ? 'You have unsaved visual edits. Switching uses your last saved visual rules.' : 'Switching keeps both configuration files. Save visual edits in Routing.'),
    );
    const defaultDescription = defaultStatus?.pending ? 'Waiting for your decision in the macOS confirmation dialog…' : defaultStatusBusy ? 'Checking system settings…' : defaultStatusError ? 'Default-browser registration needs attention.' : defaultStatus?.isDefault ? 'PwrFinicky is your default browser.' : defaultStatus ? 'Send web links through PwrFinicky.' : 'Check which app currently handles web links.';
    const defaultCard = el('div', { class: 'card settings-card' }, settingHeading('globe', 'Default browser', defaultDescription));
    if (defaultStatusError) defaultCard.append(el('p', { class: 'inline-error break-anywhere', role: 'alert' }, defaultStatusError));
    if (defaultStatus) {
      const handlerName = (value) => value === true ? 'PwrFinicky' : value === false ? 'Another browser' : value == null || value === '' ? 'Not reported' : String(value);
      defaultCard.append(el('dl', { class: 'protocol-status' }, dataPair('HTTP', handlerName(defaultStatus.http)), dataPair('HTTPS', handlerName(defaultStatus.https))));
      if (defaultStatus.httpPath || defaultStatus.httpsPath) {
        defaultCard.append(el('dl', { class: 'protocol-status break-anywhere' },
          dataPair('HTTP application', defaultStatus.httpPath || 'No application selected'),
          dataPair('HTTPS application', defaultStatus.httpsPath || 'No application selected')));
      }
    }
    defaultCard.append(el('div', { class: 'button-row wrap' },
      button(actionBusy === 'setDefaultBrowser' || defaultStatus?.pending ? 'Setting default…' : defaultStatus?.isDefault ? 'PwrFinicky is default' : 'Set as default browser', { id: 'set-default-browser', icon: defaultStatus?.isDefault ? 'check' : 'globe', className: 'button', disabled: defaultStatus?.isDefault || defaultStatus?.pending || Boolean(actionBusy) || defaultStatusBusy }, setDefaultBrowser),
      button('Check again', { className: 'button subtle', icon: 'refresh', disabled: defaultStatusBusy || Boolean(actionBusy) }, refreshDefaultStatus),
    ), el('p', { class: 'field-hint' }, 'Changes system routing only when you press this button.'));
    const paths = el('div', { class: 'card settings-card' }, settingHeading('folder', 'Files & runtime', 'Local configuration, always within reach.'),
      el('dl', { class: 'paths-list' }, dataPair('Active configuration', snapshot.configPath || 'No configuration file selected', 'break-anywhere monospace'), dataPair('Visual rules', snapshot.rulesPath || 'Path unavailable', 'break-anywhere monospace'), dataPair('Backend', snapshot.backendPid ? `PID ${snapshot.backendPid}` : 'Not running')),
      el('div', { class: 'button-row wrap' }, button('Open config', { className: 'button subtle small', disabled: !snapshot.configPath || Boolean(actionBusy) }, () => runAction('openConfig')), button('Open data folder', { className: 'button subtle small', disabled: Boolean(actionBusy) }, () => runAction('openDataDirectory')), button(actionBusy === 'reload' ? 'Reloading…' : 'Reload configuration', { icon: 'refresh', className: 'button subtle small', disabled: Boolean(actionBusy) }, () => runAction('reload', 'Configuration reloaded.'))),
      el('div', { class: 'capabilities' }, badge(`Sender app ${snapshot.capabilities?.senderApp ? 'available' : 'unavailable'}`, 'muted'), badge(`Window title ${snapshot.capabilities?.windowTitle ? 'available' : 'unavailable'}`, 'muted')),
    );
    const about = el('div', { class: 'about-card' }, el('div', { class: 'about-heading' }, el('strong', {}, 'PwrFinicky'), badge(`v${snapshot.version || '—'}`, 'muted'), snapshot.platform && el('span', { class: 'field-hint' }, String(snapshot.platform))),
      el('p', {}, 'Built on Finicky by John Sterling. Open source under the MIT license.'),
      el('div', { class: 'button-row wrap' }, button('Upstream Finicky', { icon: 'external', className: 'text-button' }, () => runAction('openExternal', undefined, { url: 'https://github.com/johnste/finicky' })), button('MIT license', { icon: 'external', className: 'text-button' }, () => runAction('openExternal', undefined, { url: 'https://github.com/johnste/finicky/blob/main/LICENSE' }))),
      el('p', { class: 'copyright' }, 'Finicky © 2015–2025 John Sterling'),
    );
    const runtimeCard = el('div', { class: 'card settings-card' }, settingHeading('activity', 'Background router', 'Closing Settings keeps links routing. Quit stops PwrFinicky.'),
      button('Quit PwrFinicky', { id: 'quit-pwrfinicky', className: 'button subtle', disabled: Boolean(actionBusy) }, () => runAction('quit')));
    refs.views.settings.replaceChildren(configCard, defaultCard, paths, runtimeCard, about);
  }

  async function refreshDefaultStatus() {
    if (defaultStatusBusy || destroyed) return;
    defaultStatusBusy = true;
    defaultStatusError = '';
    renderSettings();
    try {
      const result = await request('getDefaultStatus');
      if (!result || typeof result.isDefault !== 'boolean') throw new Error('No default-browser status was returned.');
      const wasPending = defaultStatus?.pending;
      defaultStatus = result;
      defaultStatusError = result.isDefault && !result.pending ? '' : result.error || '';
      if (wasPending && !result.pending) {
        notify(defaultStatusError || (result.isDefault ? 'PwrFinicky is now your default browser.' : 'The default browser was not changed.'), defaultStatusError ? 'error' : result.isDefault ? 'success' : 'info');
      }
    } catch (error) {
      defaultStatusError = errorMessage(error);
    } finally {
      defaultStatusBusy = false;
      if (!destroyed) renderSettings();
    }
  }

  async function setDefaultBrowser() {
    if (actionBusy || defaultStatusBusy || defaultStatus?.isDefault || defaultStatus?.pending) return;
    actionBusy = 'setDefaultBrowser';
    renderSettings();
    try {
      const result = await request('setDefaultBrowser');
      if (!result || typeof result.isDefault !== 'boolean') throw new Error('No default-browser status was returned.');
      defaultStatus = result;
      defaultStatusError = result.isDefault && !result.pending ? '' : result.error || '';
      notify(defaultStatusError || (result.pending ? 'Confirm the change in the macOS dialog. This page will update automatically.' : result.isDefault ? 'PwrFinicky is now your default browser.' : 'PwrFinicky is not yet the default. Complete the system prompt, then check again.'), defaultStatusError ? 'error' : result.isDefault ? 'success' : 'info');
    } catch (error) {
      notify(`Could not set the default browser. ${errorMessage(error)}`, 'error');
    } finally {
      actionBusy = '';
      if (!destroyed) renderSettings();
    }
  }

  async function runAction(method, successMessage, params = {}) {
    if (actionBusy) return;
    actionBusy = method;
    if (method === 'reload') profileCache.clear();
    renderSettings();
    if (snapshot) updateSource();
    try {
      const result = await request(method, params);
      if (destroyed) return;
      if (result?.rules) applySnapshot(result);
      if (successMessage && !result?.configError) notify(successMessage);
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      actionBusy = '';
      if (!destroyed) {
        renderSettings();
        if (snapshot) updateSource();
      }
    }
  }

  async function loadState() {
    refs.loading.hidden = false;
    refs.loading.replaceChildren(el('div', { class: 'loading-orbit', 'aria-hidden': 'true' }, icon('route')), el('h2', {}, 'Getting your routes ready'), el('p', {}, 'Connecting to PwrFinicky…'));
    const eventsAtRequest = stateEvents;
    try {
      const next = await request('state');
      if (stateEvents === eventsAtRequest) applySnapshot(next);
    } catch (error) {
      if (destroyed || stateEvents !== eventsAtRequest) return;
      refs.connection.textContent = 'Connection unavailable';
      refs.connectionStatus.setAttribute('data-status', 'error');
      refs.mode.textContent = 'Disconnected';
      refs.loading.replaceChildren(emptyState('warning', 'Could not connect to PwrFinicky', errorMessage(error), button('Try again', { icon: 'refresh', className: 'button primary' }, loadState)));
    }
  }

  const keyHandler = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && activeView === 'routing') {
      event.preventDefault();
      saveRules();
    }
  };

  buildShell();
  return {
    async start() {
      if (started || destroyed) return;
      started = true;
      window.addEventListener('keydown', keyHandler);
      if (typeof bridge?.onConnectionError === 'function') {
        unsubscribeConnection = bridge.onConnectionError((message) => {
          if (destroyed) return;
          sourceRenderKey = '';
          refs.connection.textContent = 'Router disconnected';
          refs.connectionStatus.setAttribute('data-status', 'error');
          refs.configAlert.hidden = false;
          refs.configAlert.replaceChildren(el('strong', {}, 'The router is not responding.'), el('p', {}, 'Reopen PwrFinicky to resume routing. Your saved configuration is still on disk.'), el('p', { class: 'config-error-text' }, errorMessage(message)));
        }) || (() => {});
      }
      if (typeof bridge?.onState === 'function') {
        try {
          const subscription = bridge.onState((next) => {
            if (destroyed) return;
            try { applySnapshot(next); stateEvents++; }
            catch (error) { notify(`State update failed. ${errorMessage(error)}`, 'error'); }
          });
          if (typeof subscription === 'function') unsubscribe = subscription;
        } catch (error) { notify(`Live updates are unavailable. ${errorMessage(error)}`, 'error'); }
      }
      await loadState();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      testGeneration++;
      unsubscribe();
      unsubscribeConnection();
      window.removeEventListener('keydown', keyHandler);
    },
  };
}
