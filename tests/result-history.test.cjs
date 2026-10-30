// 结果页与练习记录页的自动检查。
//
// 运行：node --test tests/result-history.test.cjs
//
// 覆盖：统计口径、重复保存去重、关闭重开后重读、保存失败如实报错、
// 规则版本与摘要快照、精确答案（小数／分数）可还原、
// 以及页面在无数据／有数据／失败三种情况下的表现。
// 不替代微信开发者工具与真机检查。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../miniapp');
const stats = require('../miniapp/utils/result-stats');
const fixture = require('../miniapp/utils/dev-result-fixture');
const session = require('../miniapp/utils/practice-session');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---------- wx 模拟 ----------
function createWx(options = {}) {
  const store = new Map();
  const calls = [];

  const wx = {
    _store: store,
    calls,
    setStorageSync(key, value) {
      if (options.failWrite) {
        const error = new Error('setStorage:fail exceeding storage max size');
        error.errMsg = 'setStorage:fail exceeding storage max size 10MB';
        throw error;
      }
      if (options.swallowWrite) return;
      store.set(key, clone(value));
    },
    getStorageSync(key) {
      if (options.failRead) {
        const error = new Error('getStorage:fail');
        error.errMsg = 'getStorage:fail';
        throw error;
      }
      return store.has(key) ? clone(store.get(key)) : '';
    },
    removeStorageSync(key) {
      store.delete(key);
    },
    showToast(value) {
      calls.push({ type: 'toast', title: value.title });
    },
    showModal(value) {
      calls.push({ type: 'modal', title: value.title, content: value.content });
      if (typeof value.success === 'function') value.success({ confirm: options.modalConfirm !== false });
    },
    reLaunch(value) {
      calls.push({ type: 'reLaunch', url: value.url });
    },
    navigateTo(value) {
      calls.push({ type: 'navigateTo', url: value.url });
      if (typeof value.success === 'function') value.success();
    },
    navigateBack() {},
    redirectTo(value) {
      calls.push({ type: 'redirectTo', url: value.url });
    }
  };

  global.wx = wx;
  return wx;
}

// ---------- Page 装载 ----------
function loadPage(relative) {
  const filename = path.join(root, relative);
  delete require.cache[require.resolve(filename)];
  let definition = null;
  global.Page = (value) => {
    definition = value;
  };
  require(filename);
  return definition;
}

const resultOptions = loadPage('pages/result/result.js');
const historyOptions = loadPage('pages/history/history.js');

function instantiate(options) {
  const page = Object.assign({}, options);
  page.data = clone(options.data || {});
  page.setData = function (changes) {
    for (const key of Object.keys(changes)) {
      if (key.indexOf('.') === -1) {
        page.data[key] = changes[key];
        continue;
      }
      const parts = key.split('.');
      let cursor = page.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof cursor[parts[i]] !== 'object' || cursor[parts[i]] === null) cursor[parts[i]] = {};
        cursor = cursor[parts[i]];
      }
      cursor[parts[parts.length - 1]] = changes[key];
    }
  };
  return page;
}

// 取出当前生效的 record-store（用于确认没有依赖内存状态）
function store() {
  return require('../miniapp/utils/record-store');
}

// ---------- 统计口径 ----------
test('开发测试数据：4 题、2 正确、1 错误、1 未答、正确率 50.0%', () => {
  const summary = stats.computeSummary(fixture.buildDevResult().items);
  assert.equal(summary.total, 4);
  assert.equal(summary.correct, 2);
  assert.equal(summary.wrong, 1);
  assert.equal(summary.unanswered, 1);
  assert.equal(summary.accuracyText, '50.0%');
});

test('不变式：正确 + 错误 + 未答 = 总题数', () => {
  const summary = stats.computeSummary(fixture.buildDevResult().items);
  assert.equal(summary.correct + summary.wrong + summary.unanswered, summary.total);
});

test('答 0 是有效作答，漏答才是未答', () => {
  const rows = stats.toRows(fixture.buildDevResult().items);
  assert.equal(rows[2].userAnswerText, '0');
  assert.equal(rows[2].isBlank, false);
  assert.equal(rows[3].userAnswerText, '未作答');
  assert.equal(rows[3].isBlank, true);
});

test('正确率保留一位小数', () => {
  assert.equal(stats.formatAccuracy(2, 3), '66.7%');
  assert.equal(stats.formatAccuracy(0, 4), '0.0%');
  assert.equal(stats.formatAccuracy(4, 4), '100.0%');
});

test('缺少批改状态时明确报错，不默认按错误算', () => {
  assert.throws(
    () => stats.computeSummary([{ expression: '1＋1', userAnswer: '2', correctAnswer: '2' }]),
    /结果状态无效/
  );
});

// ---------- 保存与去重 ----------
test('保存一次练习写入 1 条，重复保存不重复写入', () => {
  createWx();
  const first = store().saveRecord(fixture.buildDevResult());
  const second = store().saveRecord(fixture.buildDevResult());
  assert.equal(first.ok, true);
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(store().countRecords(), 1);
});

test('关闭重开后仍能读到（换 wx 实例 + 重新加载模块）', () => {
  const wx = createWx();
  store().saveRecord(fixture.buildDevResult());
  const kept = wx._store;

  createWx();
  global.wx.getStorageSync = (key) => (kept.has(key) ? clone(kept.get(key)) : '');

  const modulePath = require.resolve('../miniapp/utils/record-store');
  delete require.cache[modulePath];
  const reloaded = require('../miniapp/utils/record-store');
  const loaded = reloaded.loadRecords();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0].summary.accuracyText, '50.0%');
});

test('保存规则版本、ruleId 与配置摘要快照', () => {
  createWx();
  const input = fixture.buildDevResult();
  input.ruleId = 'g3_decimal_1place';
  input.configText = '三年级 · 小数加减 · 一位小数 · 10 以内 · 20 题 · 普通练习';
  const saved = store().saveRecord(input);

  assert.equal(saved.ok, true);
  assert.equal(saved.record.ruleId, 'g3_decimal_1place');
  assert.equal(saved.record.ruleVersion, store().RULE_VERSION);
  assert.equal(saved.record.configText, input.configText);
  assert.equal(typeof saved.record.createdAtText, 'string');
  assert.ok(saved.record.schemaVersion >= 1);
});

test('小数与分数的精确答案原样保存并可还原', () => {
  createWx();
  const saved = store().saveRecord(fixture.DECIMAL_FRACTION_SAMPLE);
  assert.equal(saved.ok, true);

  const record = store().getRecord(fixture.DECIMAL_FRACTION_SAMPLE.practiceId).record;
  assert.equal(record.items[0].correctAnswer, '1.7');
  assert.equal(record.items[1].correctAnswer, '1.3');
  assert.equal(record.items[2].correctAnswer, '3/5');
  assert.deepEqual(record.items[2].question, { kind: 'fraction', denominator: 5, numerators: [1, 2] });
});

test('旧记录的题型已不在当前规则表时，仍能显示保存时的摘要', () => {
  createWx();
  const input = fixture.buildDevResult();
  input.ruleId = 'g9_removed_rule';
  input.ruleVersion = 'v1';
  input.configText = '旧规则 · 20 以内加法 · 30 题';
  store().saveRecord(input);

  // 详情页只读快照，不查当前规则表，所以旧 ruleId 不应导致报错
  const page = instantiate(resultOptions);
  page.onLoad({ id: fixture.DEV_PRACTICE_ID });
  assert.equal(page.data.mode, 'detail');
  assert.equal(page.data.configText, '旧规则 · 20 以内加法 · 30 题');
  assert.equal(page.data.error, '');
});

test('保存失败与写入被吞都如实报错', () => {
  createWx({ failWrite: true });
  const failed = store().saveRecord(fixture.buildDevResult());
  assert.equal(failed.ok, false);
  assert.match(failed.error, /写入本地存储失败/);

  createWx({ swallowWrite: true });
  const swallowed = store().saveRecord(fixture.buildDevResult());
  assert.equal(swallowed.ok, false);
  assert.ok(/保存未生效|未找到/.test(swallowed.error));
});

test('缺少练习编号或题目时拒绝保存', () => {
  createWx();
  assert.equal(store().saveRecord({ items: [] }).ok, false);
  assert.equal(store().saveRecord({ practiceId: 'p-empty', items: [] }).ok, false);
  assert.equal(store().countRecords(), 0);
});

test('超过 100 条删除最早记录', () => {
  createWx();
  for (let i = 1; i <= 105; i++) {
    const input = fixture.buildDevResult();
    input.practiceId = 'dev-' + i;
    store().saveRecord(input);
  }
  const loaded = store().loadRecords();
  assert.equal(loaded.records.length, 100);
  assert.equal(loaded.records[0].id, 'dev-105');
  assert.equal(loaded.records[99].id, 'dev-6');
});

// ---------- 结果页 ----------
test('无数据时进入空状态，不编造结果', () => {
  createWx();
  const page = instantiate(resultOptions);
  page.onLoad({});
  assert.equal(page.data.mode, 'empty');
  assert.equal(page.data.summary, null);
  assert.equal(store().countRecords(), 0);
});

test('开发测试数据渲染汇总与逐题，并自动保存', () => {
  createWx();
  const page = instantiate(resultOptions);
  page.onLoad({ source: 'dev' });

  assert.equal(page.data.mode, 'preview');
  assert.equal(page.data.isDev, true);
  assert.equal(page.data.summary.total, 4);
  assert.equal(page.data.summary.correct, 2);
  assert.equal(page.data.summary.wrong, 1);
  assert.equal(page.data.summary.unanswered, 1);
  assert.equal(page.data.summary.accuracyText, '50.0%');
  assert.equal(page.data.rows.length, 4);
  assert.equal(page.data.rows[1].correctAnswerText, '4');
  assert.equal(page.data.savedState, 'saved');
  assert.equal(store().countRecords(), 1);
});

test('再次进入同一练习不产生重复记录', () => {
  createWx();
  instantiate(resultOptions).onLoad({ source: 'dev' });
  const second = instantiate(resultOptions);
  second.onLoad({ source: 'dev' });
  assert.equal(second.data.savedState, 'deduped');
  assert.equal(store().countRecords(), 1);
});

test('重复点击保存按钮也不重复写入', () => {
  createWx();
  const page = instantiate(resultOptions);
  page.onLoad({ source: 'dev' });
  page.onSaveTap();
  page.onSaveTap();
  assert.equal(store().countRecords(), 1);
});

test('从记录页进入详情不重复保存', () => {
  createWx();
  instantiate(resultOptions).onLoad({ source: 'dev' });
  const detail = instantiate(resultOptions);
  detail.onLoad({ id: encodeURIComponent(fixture.DEV_PRACTICE_ID) });
  assert.equal(detail.data.mode, 'detail');
  assert.equal(detail.data.summary.correct, 2);
  assert.equal(store().countRecords(), 1);
});

test('记录被清除后进入详情明确报错', () => {
  createWx();
  const page = instantiate(resultOptions);
  page.onLoad({ id: 'not-exist' });
  assert.equal(page.data.mode, 'empty');
  assert.match(page.data.error, /未找到/);
});

test('保存失败时显示失败，不显示保存成功', () => {
  const wx = createWx({ failWrite: true });
  const page = instantiate(resultOptions);
  page.onLoad({ source: 'dev' });

  assert.equal(page.data.savedState, 'failed');
  assert.match(page.data.savedText, /^保存失败/);
  assert.ok(wx.calls.some((call) => call.type === 'modal'));
  assert.equal(store().countRecords(), 0);
});

test('答题页交来的待保存结果可以渲染并保存', () => {
  createWx();
  session.setPendingResult(fixture.buildDevResult());
  const page = instantiate(resultOptions);
  page.onLoad({});

  assert.equal(page.data.mode, 'preview');
  assert.equal(page.data.summary.accuracyText, '50.0%');
  assert.equal(store().countRecords(), 1);
  assert.equal(session.peekPendingResult(), null);
});

// ---------- 记录页 ----------
test('无记录时显示空状态', () => {
  createWx();
  const page = instantiate(historyOptions);
  page.onShow();
  assert.equal(page.data.empty, true);
  assert.equal(page.data.count, 0);
  assert.equal(page.data.error, '');
});

test('有记录时列出题量、正确数与正确率', () => {
  createWx();
  instantiate(resultOptions).onLoad({ source: 'dev' });
  const page = instantiate(historyOptions);
  page.onShow();

  assert.equal(page.data.count, 1);
  assert.equal(page.data.records[0].total, 4);
  assert.equal(page.data.records[0].correct, 2);
  assert.equal(page.data.records[0].accuracyText, '50.0%');
  assert.equal(page.data.records[0].isDevData, true);
});

test('点击记录跳转到详情并带上 id', () => {
  const wx = createWx();
  instantiate(resultOptions).onLoad({ source: 'dev' });
  const page = instantiate(historyOptions);
  page.onShow();

  wx.calls.length = 0;
  page.onOpen({ currentTarget: { dataset: { id: fixture.DEV_PRACTICE_ID } } });
  const navigation = wx.calls.find((call) => call.type === 'navigateTo');
  assert.ok(navigation);
  assert.equal(navigation.url, '/pages/result/result?id=' + encodeURIComponent(fixture.DEV_PRACTICE_ID));
});

test('清除记录前需要确认，取消时不删除', () => {
  createWx({ modalConfirm: false });
  const page = instantiate(historyOptions);
  page.onShow();
  page.onClear();
  assert.equal(store().countRecords(), 0);
});

test('读取存储失败时明确报错，不显示为 0 条', () => {
  createWx({ failRead: true });
  const page = instantiate(historyOptions);
  page.onShow();
  assert.match(page.data.error, /读取本地记录失败/);
});

// ---------- 模板与工程一致性 ----------
test('模板绑定的方法在页面里都存在', () => {
  for (const [relative, options] of [
    ['pages/result/result', resultOptions],
    ['pages/history/history', historyOptions]
  ]) {
    const wxml = fs.readFileSync(path.join(root, relative + '.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const names = [...wxml.matchAll(/(?:bindtap|catchtap)="([A-Za-z_$][\w$]*)"/g)].map((match) => match[1]);
    assert.ok(names.length > 0, relative + ' 应至少有事件绑定');
    for (const name of names) {
      assert.equal(typeof options[name], 'function', relative + ' 缺少方法 ' + name);
    }
  }
});

test('WXML 标签闭合且 WXSS 花括号配对', () => {
  for (const relative of ['pages/result/result', 'pages/history/history']) {
    const wxml = fs.readFileSync(path.join(root, relative + '.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const stack = [];
    for (const match of wxml.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
      if (match[4] === '/') continue;
      if (match[1] === '/') assert.equal(stack.pop(), match[2], relative + ' 标签未闭合');
      else stack.push(match[2]);
    }
    assert.equal(stack.length, 0, relative + ' 存在未闭合标签');

    const wxss = fs.readFileSync(path.join(root, relative + '.wxss'), 'utf8');
    assert.equal((wxss.match(/{/g) || []).length, (wxss.match(/}/g) || []).length, relative + ' 花括号不配对');
  }
});
