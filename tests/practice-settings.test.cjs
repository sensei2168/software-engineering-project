const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../miniapp');
const { DEFAULT_CONFIG, DURATIONS, validateConfig, fromQuery, toQuery, getConfigDisplay } = require('../miniapp/utils/practice-config');
const { RULES, getRulesForGrade } = require('../miniapp/utils/practice-rules');
const event = (value) => ({ currentTarget: { dataset: { value } } });
const clone = (value) => JSON.parse(JSON.stringify(value));

function configFor(rule, extra = {}) {
  return Object.assign({}, DEFAULT_CONFIG, {
    grade: rule.grade, ruleId: rule.id, operation: rule.operation, limit: rule.limit
  }, extra);
}

function loadPage(relative, options = {}) {
  const calls = { navigateTo: [], navigateBack: [], redirectTo: [] };
  const wx = {
    navigateTo(value) { calls.navigateTo.push(value); },
    showToast() {},
    navigateBack(value) {
      calls.navigateBack.push(value);
      if (options.noPreviousPage) value.fail();
    },
    redirectTo(value) { calls.redirectTo.push(value); }
  };
  const navigationModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/navigation.js'), 'utf8'), {
    wx, module: navigationModule
  });
  const filename = path.join(root, relative);
  const nodeRequire = createRequire(filename);
  let definition;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    wx,
    require(name) { return name === '../../utils/navigation' ? navigationModule.exports : nodeRequire(name); },
    Page(value) { definition = value; }
  }, { filename });
  const page = Object.assign({}, definition, { data: clone(definition.data || {}) });
  page.setData = function (changes) {
    for (const [key, value] of Object.entries(changes)) {
      const parts = key.split('.');
      let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts[parts.length - 1]] = value;
    }
  };
  return { page, calls };
}

function settings(mode = 'normal') {
  const instance = loadPage('pages/settings/settings.js');
  instance.page.onLoad({ mode });
  return instance;
}

test('the catalog has unique IDs and the approved grade/group choices', () => {
  assert.equal(new Set(RULES.map(r => r.id)).size, 13);
  assert.deepEqual([1, 2, 3].map(g => getRulesForGrade(g).length), [2, 4, 7]);
  assert.equal(getRulesForGrade(3, 'integer').length, 5);
  assert.deepEqual(getRulesForGrade(3, 'rational').map(r => r.operation), ['decimal_add_sub', 'fraction_add_sub']);
});

for (const rule of RULES) {
  for (const mode of ['normal', 'timed']) {
    test(`${rule.id} / ${mode}: selected settings survive navigation into the summary`, () => {
      const input = configFor(rule, { mode, count: 20, durationSeconds: 60 });
      const { page, calls } = settings();
      page.onLoad(Object.fromEntries(new URLSearchParams(toQuery(input))));
      page.previewPractice();
      assert.equal(calls.navigateTo.length, 1);
      const query = Object.fromEntries(new URL('https://example.invalid' + calls.navigateTo[0].url).searchParams);
      const next = loadPage('pages/practice/practice.js').page;
      next.onLoad(query);
      assert.equal(next.data.error, '');
      assert.deepEqual(clone(next.data.config), input);
      assert.equal(next.data.display.ruleLabel, rule.label);
      assert.equal(next.data.display.rangeLabel, rule.rangeLabel);
      assert.equal(next.data.display.gradeLabel, ['一年级', '二年级', '三年级'][rule.grade - 1]);
    });
  }
}

test('both entry modes keep grade one/addition/30 questions, timed defaults to 120 seconds', () => {
  for (const mode of ['normal', 'timed']) {
    const { page } = settings(mode);
    assert.deepEqual(clone(page.data.config), Object.assign({}, DEFAULT_CONFIG, { mode }));
    assert.equal(page.data.countText, '30');
    assert.ok(page.data.selectionSummary.includes(mode === 'normal' ? '不限时' : '120 秒'));
  }
});

test('changing grade preserves subtraction, count and duration but updates the rule range', () => {
  const { page } = settings('timed');
  page.chooseRule(event('g1_subtract_20'));
  page.changeCount({ detail: { value: '20' } });
  page.chooseDuration(event('60'));
  page.chooseGrade(event('2'));
  assert.equal(page.data.config.ruleId, 'g2_subtract_100');
  assert.equal(page.data.config.limit, 100);
  assert.equal(page.data.countText, '20');
  assert.equal(page.data.config.durationSeconds, 60);
  assert.equal(page.data.config.mode, 'timed');
  page.chooseGrade(event('1'));
  assert.equal(page.data.config.ruleId, 'g1_subtract_20');
  assert.equal(page.data.config.limit, 20);
});

test('leaving a grade without a compatible advanced type resets to addition with a notice', () => {
  const { page } = settings('timed');
  page.chooseGrade(event(3));
  page.chooseGroup(event('rational'));
  page.chooseRule(event('g3_fraction_same_den'));
  page.chooseGrade(event(2));
  assert.equal(page.data.config.ruleId, 'g2_add_100');
  assert.equal(page.data.selectedRule.group, 'integer');
  assert.ok(page.data.notice.includes('已切换为加法'));
  assert.equal(page.data.countText, '30');
  assert.equal(page.data.config.durationSeconds, 120);
});

test('group changes select the first new type, but tapping the current group keeps its selection', () => {
  const { page } = settings('timed');
  page.chooseGrade(event(3));
  page.chooseDuration(event(180));
  page.changeCount({ detail: { value: '10' } });
  page.chooseGroup(event('rational'));
  assert.equal(page.data.config.ruleId, 'g3_decimal_1place');
  page.chooseRule(event('g3_fraction_same_den'));
  page.chooseGroup(event('rational'));
  assert.equal(page.data.config.ruleId, 'g3_fraction_same_den');
  page.chooseGroup(event('integer'));
  assert.equal(page.data.config.ruleId, 'g3_add_1000');
  assert.equal(page.data.countText, '10');
  assert.equal(page.data.config.durationSeconds, 180);
});

test('mode changes retain year, fraction type, count and duration', () => {
  const { page } = settings('timed');
  page.chooseGrade(event(3));
  page.chooseGroup(event('rational'));
  page.chooseRule(event('g3_fraction_same_den'));
  page.chooseDuration(event(60));
  page.changeCount({ detail: { value: '20' } });
  page.chooseMode(event('normal'));
  assert.ok(page.data.selectionSummary.endsWith('不限时'));
  page.chooseMode(event('timed'));
  assert.equal(page.data.config.ruleId, 'g3_fraction_same_den');
  assert.equal(page.data.config.durationSeconds, 60);
  assert.equal(page.data.countText, '20');
});

test('out-of-grade and hidden-group selections cannot leave invisible selected values', () => {
  const { page } = settings();
  page.chooseRule(event('g3_fraction_same_den'));
  page.chooseGroup(event('rational'));
  page.chooseGrade(event(99));
  assert.equal(page.data.config.ruleId, DEFAULT_CONFIG.ruleId);
  page.chooseGrade(event(3));
  page.chooseRule(event('g3_decimal_1place'));
  assert.equal(page.data.config.ruleId, 'g3_add_1000');
});

test('count validation rejects blank, out-of-range and non-integer text and accepts the limits', () => {
  for (const value of ['', ' ', '9', '51', '20.5', '-10', 'abc', '1e1']) {
    const { page, calls } = settings();
    page.changeCount({ detail: { value } }); page.previewPractice();
    assert.ok(page.data.error, JSON.stringify(value));
    assert.equal(calls.navigateTo.length, 0);
  }
  for (const value of ['10', '30', '50', ' 20 ', '020']) {
    const { page, calls } = settings();
    page.changeCount({ detail: { value } }); page.previewPractice();
    assert.equal(page.data.error, '');
    assert.equal(page.data.config.count, Number(value));
    assert.equal(calls.navigateTo.length, 1);
  }
});

test('selecting a different grade does not erase an unresolved count error or typed count', () => {
  const { page } = settings();
  page.changeCount({ detail: { value: '9' } }); page.previewPractice();
  page.chooseGrade(event(3));
  assert.ok(page.data.error);
  assert.equal(page.data.countText, '9');
  assert.ok(page.data.selectionSummary.includes('题量待确认'));
});

test('invalid grade/rule pairs and altered compatibility fields are rejected', () => {
  const bad = [
    { grade: 0 }, { grade: 4 }, { grade: 1.5 }, { ruleId: 'unknown' },
    { grade: 1, ruleId: 'g3_fraction_same_den' },
    { operation: 'divide' }, { limit: 100 }, { mode: 'unknown' },
    { durationSeconds: 0 }, { durationSeconds: 59 }, { count: 30.5 }, { count: '30' }
  ];
  for (const changes of bad) assert.equal(validateConfig(Object.assign({}, DEFAULT_CONFIG, changes)).ok, false);
  assert.equal(fromQuery({}).ok, false);
  assert.equal(fromQuery(null).ok, false);
  const next = loadPage('pages/practice/practice.js').page;
  next.onLoad({ grade: '1', ruleId: 'g3_fraction_same_den', count: '30', mode: 'normal', durationSeconds: '120' });
  assert.equal(next.data.config, null);
  assert.ok(next.data.error);
});

test('old 20-within addition/subtraction links retain their original meaning', () => {
  for (const operation of ['add', 'subtract']) {
    const result = fromQuery({ operation, limit: '20', count: '20', mode: 'timed', durationSeconds: '60' });
    assert.equal(result.ok, true);
    assert.equal(result.value.grade, 1);
    assert.equal(result.value.operation, operation);
    assert.equal(result.value.count, 20);
  }
  assert.equal(fromQuery({ operation: 'multiply', limit: '20', count: '20', mode: 'normal', durationSeconds: '120' }).ok, false);
});

test('summary return uses the existing page, with a full-configuration fallback when opened alone', () => {
  const expected = configFor(RULES.find(r => r.id === 'g3_fraction_same_den'), { mode: 'timed', count: 10, durationSeconds: 180 });
  const query = Object.fromEntries(new URLSearchParams(toQuery(expected)));
  const stacked = loadPage('pages/practice/practice.js');
  stacked.page.onLoad(query); stacked.page.backToSettings();
  assert.equal(stacked.calls.navigateBack.length, 1);
  assert.equal(stacked.calls.redirectTo.length, 0);
  const single = loadPage('pages/practice/practice.js', { noPreviousPage: true });
  single.page.onLoad(query); single.page.backToSettings();
  const restoredQuery = Object.fromEntries(new URL('https://example.invalid' + single.calls.redirectTo[0].url).searchParams);
  const restored = settings(); restored.page.onLoad(restoredQuery);
  assert.deepEqual(clone(restored.page.data.config), expected);
});

test('entry page instances do not mutate the shared defaults or duration choices', () => {
  const initial = clone(DEFAULT_CONFIG);
  const { page } = settings('timed');
  page.chooseGrade(event(3)); page.chooseGroup(event('rational')); page.chooseDuration(event(180));
  assert.deepEqual(DEFAULT_CONFIG, initial);
  assert.deepEqual(DURATIONS, [60, 120, 180]);
  assert.equal(settings().page.data.config.ruleId, 'g1_add_20');
  assert.equal(getConfigDisplay(DEFAULT_CONFIG).gradeLabel, '一年级');
});
