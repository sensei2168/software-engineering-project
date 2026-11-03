/**
 * 答题页 → 结果页 → 练习记录 的交接自测。
 *
 * 验证 PR #5 审查意见第 2 条：结果必须走 main 的 practice-session / items 契约，
 * 而不是旧的 pendingPracticeResult 缓存。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MINIAPP = path.join(__dirname, '..', 'miniapp');
const PRACTICE = path.join(MINIAPP, 'pages/practice/practice.js');
const RESULT = path.join(MINIAPP, 'pages/result/result.js');
const HISTORY = path.join(MINIAPP, 'pages/history/history.js');
const generator = require(path.join(MINIAPP, 'utils/question', 'generator.js'));
const session = require(path.join(MINIAPP, 'utils', 'practice-session.js'));
const { RULE_VERSION } = require(path.join(MINIAPP, 'utils', 'practice-rules.js'));

const STORAGE_KEY = 'kousuan_practice_records_v1';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness() {
  let definition = null;
  const storage = {};
  const calls = { navigate: [], modal: [], toast: [] };

  global.wx = {
    showToast(options) { calls.toast.push(options.title); },
    showModal(options) {
      calls.modal.push(options.title);
      if (options.success) options.success({ confirm: true });
    },
    navigateTo(options) {
      calls.navigate.push(options.url);
      if (options.success) options.success({});
    },
    navigateBack() {},
    redirectTo() {},
    setStorageSync(key, value) { storage[key] = value; },
    getStorageSync(key) { return storage[key]; },
    removeStorageSync(key) { delete storage[key]; },
    getAccountInfoSync() { return { miniProgram: { envVersion: 'develop' } }; },
    getRandomValues(buffer) { for (let i = 0; i < buffer.length; i += 1) buffer[i] = i; }
  };
  global.Page = (config) => { definition = config; };

  function loadPage(file) {
    delete require.cache[require.resolve(file)];
    require(file);
    const page = Object.assign({}, definition);
    page.data = JSON.parse(JSON.stringify(definition.data));
    page.setData = function setData(patch) {
      Object.keys(patch).forEach((key) => {
        if (key.indexOf('.') === -1 && key.indexOf('[') === -1) {
          this.data[key] = patch[key];
          return;
        }
        const tokens = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target = this.data;
        for (let i = 0; i < tokens.length - 1; i += 1) target = target[tokens[i]];
        target[tokens[tokens.length - 1]] = patch[key];
      });
    };
    return page;
  }

  return { storage, calls, loadPage };
}

test('答题 → 查看结果 → 保存记录 → 历史列表走通，重复打开只留一条', async function () {
  const { storage, calls, loadPage } = createHarness();
  session.clearPendingResult();

  const practice = loadPage(PRACTICE);
  practice.onLoad({
    grade: '1', ruleId: 'g1_add_20', operation: 'add', limit: '20',
    count: '10', mode: 'normal', durationSeconds: '120'
  });
  await wait(200);
  assert.equal(practice.data.total, 10);

  const questions = generator.generateQuestions({
    ruleId: 'g1_add_20', count: 10, sessionId: practice.data.quizId
  }).questions;
  questions.forEach((question, index) => {
    practice.onAnswerInput({
      currentTarget: { dataset: { index: index } },
      detail: { value: String(question.answer) }
    });
  });
  practice.onSubmitTap();
  await wait(400);
  assert.equal(practice.data.summary.correct, 10);
  // 交卷后立即保存，不依赖用户点「查看结果」
  assert.equal(storage[STORAGE_KEY].length, 1);

  practice.openResultPage();
  const resultUrl = calls.navigate[calls.navigate.length - 1];
  assert.ok(resultUrl.indexOf('/pages/result/result?id=') === 0, resultUrl);

  const result = loadPage(RESULT);
  result.onLoad({ id: decodeURIComponent(resultUrl.split('?id=')[1]) });
  assert.equal(result.data.mode, 'detail');
  assert.equal(result.data.summary.total, 10);
  assert.equal(result.data.summary.correct, 10);
  assert.equal(result.data.savedState, 'saved');
  assert.equal(result.data.rows.length, 10);

  const records = storage[STORAGE_KEY];
  assert.ok(Array.isArray(records), '应写入本机练习记录');
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.id, practice.data.quizId);
  assert.equal(record.ruleId, 'g1_add_20');
  assert.equal(record.ruleVersion, RULE_VERSION);
  assert.ok(record.configText.indexOf('一年级') !== -1, record.configText);
  assert.equal(record.items.length, 10);
  assert.equal(record.items[0].status, 'correct');
  assert.ok(record.items[0].question, '记录应保存结构化原题快照');
  assert.equal(record.items[0].question.kind, 'integer');
  assert.equal(record.items[0].userAnswer, String(questions[0].answer));

  // 再打开一次：仍按同一条记录查看，不重复保存
  practice.openResultPage();
  const resultUrl2 = calls.navigate[calls.navigate.length - 1];
  const again = loadPage(RESULT);
  again.onLoad({ id: decodeURIComponent(resultUrl2.split('?id=')[1]) });
  assert.equal(again.data.mode, 'detail');
  assert.equal(storage[STORAGE_KEY].length, 1);

  // 记录页能看到这一条
  const history = loadPage(HISTORY);
  history.onShow();
  assert.equal(history.data.count, 1);
  assert.equal(history.data.records[0].id, practice.data.quizId);
});

test('小数、分数、混合结果保留原输入与结构化原题快照', async function () {
  const cases = [
    {
      ruleId: 'g3_decimal_1place', operation: 'decimal_add_sub', limit: '10', kind: 'decimal',
      input: (question) => Number(question.answer).toFixed(2)
    },
    {
      ruleId: 'g3_fraction_same_den', operation: 'fraction_add_sub', limit: '1', kind: 'fraction',
      input: (question) => String(question.answer)
    },
    {
      ruleId: 'g3_mixed_2step', operation: 'mixed', limit: '100', kind: 'integer',
      input: (question) => String(question.answer)
    }
  ];

  for (const sample of cases) {
    const { storage, calls, loadPage } = createHarness();
    session.clearPendingResult();

    const practice = loadPage(PRACTICE);
    practice.onLoad({
      grade: '3', ruleId: sample.ruleId, operation: sample.operation, limit: sample.limit,
      count: '10', mode: 'normal', durationSeconds: '120'
    });
    await wait(250);
    const questions = generator.generateQuestions({
      ruleId: sample.ruleId, count: 10, sessionId: practice.data.quizId
    }).questions;
    practice.answers = questions.map((question) => sample.input(question));
    practice.onSubmitTap();
    await wait(400);
    assert.equal(storage[STORAGE_KEY].length, 1, sample.ruleId + ' 交卷后应立即保存');

    practice.openResultPage();
    const resultUrl = calls.navigate[calls.navigate.length - 1];
    const result = loadPage(RESULT);
    result.onLoad({ id: decodeURIComponent(resultUrl.split('?id=')[1]) });
    assert.equal(result.data.mode, 'detail', sample.ruleId);
    assert.equal(result.data.savedState, 'saved', sample.ruleId);

    const record = storage[STORAGE_KEY][0];
    assert.equal(record.items[0].userAnswer, sample.input(questions[0]), sample.ruleId);
    assert.equal(record.items[0].question.kind, sample.kind, sample.ruleId);
    if (sample.kind === 'decimal') {
      assert.equal(record.items[0].question.answerTenths, questions[0].answerTenths);
    } else if (sample.kind === 'fraction') {
      assert.equal(record.items[0].question.denominator, questions[0].denominator);
    } else {
      assert.equal(record.items[0].question.tokens.length, 5);
    }
  }
});
