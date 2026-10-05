import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_LIMIT, browserChoices, createDraft, duration, moveRule, newRule,
  rulesFingerprint, toRulesFile, validateDraft, validateUrl, visibleHistory,
} from '../renderer/model.mjs';

test('draft serialization preserves ordered multiple patterns, profiles, and options', () => {
  const file = {
    defaultBrowser: 'Google Chrome', defaultProfile: 'Personal',
    rules: [
      { match: ['meet.google.com/*', '*.company.test/*'], browser: 'Google Chrome', profile: 'Work' },
      { match: 'example.com/*', browser: 'Safari' },
    ],
    options: { logRequests: false },
  };
  const draft = createDraft(file);
  draft.rules[0].patterns = '  meet.google.com/*  \n\n*.company.test/*\r\n';
  assert.deepEqual(toRulesFile(draft), file);
  draft.rules[0].browser = 'Firefox';
  draft.options.logRequests = true;
  assert.equal(file.rules[0].browser, 'Google Chrome');
  assert.equal(file.options.logRequests, false);
});

test('dirty fingerprints normalize optional empty profiles and pattern whitespace', () => {
  assert.equal(
    rulesFingerprint({ defaultBrowser: 'Safari', defaultProfile: '', rules: [{ match: [' example.com/* '], browser: 'Safari', profile: '' }] }),
    rulesFingerprint({ defaultBrowser: 'Safari', rules: [{ match: 'example.com/*', browser: 'Safari' }] }),
  );
});

test('validation identifies the exact incomplete destination and pattern fields', () => {
  const draft = createDraft({ defaultBrowser: '', rules: [{ match: [], browser: '' }] });
  assert.deepEqual(validateDraft(draft).map((error) => error.field), ['default-browser', `${draft.rules[0].key}-patterns`, `${draft.rules[0].key}-browser`]);
});

test('reordering is immutable and respects the first and last boundaries', () => {
  const rules = [newRule('Safari'), newRule('Firefox'), newRule('Chrome')];
  const moved = moveRule(rules, rules[0].key, 1);
  assert.deepEqual(moved.map((rule) => rule.browser), ['Firefox', 'Safari', 'Chrome']);
  assert.equal(rules[0].browser, 'Safari');
  assert.equal(moveRule(rules, rules[0].key, -1), rules);
  assert.equal(moveRule(rules, rules[2].key, 1), rules);
  assert.equal(moveRule(rules, 'missing-key', 1), rules);
});

test('browser choices retain saved browsers and remove duplicates', () => {
  assert.deepEqual(browserChoices(['Safari', 'Safari', 'Firefox', null], 'Custom browser'), ['Safari', 'Firefox', 'Custom browser']);
});

test('link validation accepts full web links and rejects ambiguous or executable input', () => {
  for (const url of ['https://example.com/hello?q=world', ' http://localhost:3000 ', 'https://example.com/<img>']) assert.equal(validateUrl(url), '');
  for (const url of ['', 'example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'https://']) assert.ok(validateUrl(url));
});

test('history is bounded to real dispatches before applying searches or status filters', () => {
  const history = [
    { id: 'dry', dryRun: true, success: true, url: 'https://example.com' },
    ...Array.from({ length: 125 }, (_, i) => ({ id: String(i), dryRun: false, success: i % 2 === 0, url: `https://example.com/${i}`, browser: 'Safari', profile: i === 1 ? 'Work' : '', error: i === 3 ? 'Launch timed out' : '' })),
  ];
  assert.equal(visibleHistory(history).length, HISTORY_LIMIT);
  assert.equal(visibleHistory(history)[0].id, '0');
  assert.equal(visibleHistory(history, 'failed').length, 50);
  assert.equal(visibleHistory(history, 'all', 'work')[0].id, '1');
  assert.equal(visibleHistory(history, 'all', 'TIMED OUT')[0].id, '3');
  assert.deepEqual(visibleHistory(history, 'all', '/124'), []);
});

test('durations do not hide zero or display malformed timing values', () => {
  assert.equal(duration(0), '0 ms');
  assert.equal(duration(1.256), '1.26 ms');
  assert.equal(duration(10.5), '11 ms');
  assert.equal(duration(1250), '1.25 s');
  for (const invalid of [undefined, null, NaN, Infinity, -1, '5']) assert.equal(duration(invalid), '—');
});
