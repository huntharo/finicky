export const HISTORY_LIMIT = 100;

const string = (value) => typeof value === 'string' ? value : '';
let nextKey = 0;

export function createDraft(file = {}) {
  return {
    defaultBrowser: string(file.defaultBrowser),
    defaultProfile: string(file.defaultProfile),
    rules: (Array.isArray(file.rules) ? file.rules : []).map((rule) => ({
      key: `rule-${++nextKey}`,
      patterns: (Array.isArray(rule.match) ? rule.match : [rule.match]).map(string).join('\n'),
      browser: string(rule.browser),
      profile: string(rule.profile),
    })),
    options: file.options && typeof file.options === 'object' ? { ...file.options } : undefined,
  };
}

export function newRule(browser = '') {
  return { key: `rule-${++nextKey}`, patterns: '', browser, profile: '' };
}

export function toRulesFile(draft) {
  const file = {
    defaultBrowser: draft.defaultBrowser,
    rules: draft.rules.map((rule) => {
      const patterns = rule.patterns.split(/\r?\n/).map((pattern) => pattern.trim()).filter(Boolean);
      return {
        match: patterns.length === 1 ? patterns[0] : patterns,
        browser: rule.browser,
        ...(rule.profile ? { profile: rule.profile } : {}),
      };
    }),
    ...(draft.defaultProfile ? { defaultProfile: draft.defaultProfile } : {}),
    ...(draft.options ? { options: { ...draft.options } } : {}),
  };
  return file;
}

export function rulesFingerprint(file) {
  // Canonicalize optional empty fields and object key order for dirty tracking.
  return JSON.stringify(toRulesFile(createDraft(file)));
}

export function validateDraft(draft) {
  const errors = [];
  if (!draft.defaultBrowser.trim()) errors.push({ field: 'default-browser', message: 'Choose a default browser.' });
  draft.rules.forEach((rule, index) => {
    if (!rule.patterns.trim()) errors.push({ field: `${rule.key}-patterns`, message: `Rule ${index + 1} needs at least one pattern.` });
    if (!rule.browser.trim()) errors.push({ field: `${rule.key}-browser`, message: `Choose a browser for rule ${index + 1}.` });
  });
  return errors;
}

export function moveRule(rules, key, direction) {
  const from = rules.findIndex((rule) => rule.key === key);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= rules.length) return rules;
  const result = [...rules];
  [result[from], result[to]] = [result[to], result[from]];
  return result;
}

export function browserChoices(browsers, selected = '') {
  return [...new Set([...(Array.isArray(browsers) ? browsers : []), selected].filter((name) => typeof name === 'string' && name))];
}

export function validateUrl(value) {
  const url = value.trim();
  if (!url) return 'Enter a link to test.';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('Unsupported URL');
    return '';
  } catch {
    return 'Enter a full http:// or https:// URL.';
  }
}

export function visibleHistory(history, filter = 'all', search = '') {
  const query = search.trim().toLowerCase();
  return (Array.isArray(history) ? history : [])
    .filter((entry) => !entry.dryRun)
    .slice(0, HISTORY_LIMIT)
    .filter((entry) => filter === 'all' || (filter === 'failed' ? !entry.success : entry.success))
    .filter((entry) => !query || [entry.url, entry.browser, entry.profile, entry.source, entry.error].some((value) => string(value).toLowerCase().includes(query)));
}

export function duration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value === 0) return '0 ms';
  return `${value < 10 ? Number(value.toFixed(2)) : Math.round(value)} ms`;
}

export function errorMessage(error) {
  if (typeof error === 'string' && error) return error;
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}
