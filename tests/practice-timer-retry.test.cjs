/**
 * 限时练习：批改失败后的计时、冻结与重试。
 *
 * 覆盖 PR #5 审查意见第 4 条：
 * - 提前提交失败：恢复倒计时，仍可改答案；
 * - 到截止后失败：冻结答案，只允许重试同一份提交；
 * - 手动与到时同时触发只提交一次。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MINIAPP = path.join(__dirname, '..', 'miniapp');
const PAGE = path.join(MINIAPP, 'pages/practice/practice.js');
const generator = require(path.join(MINIAPP, 'utils', 'question', 'generator.js'));
const service = require(path.join(MINIAPP, 'services', 'question-service.js'));

const STORAGE_KEY = 'kousuan_practice_records_v1';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness() {
  let definition = null;
  const storage = {};
  const calls = { modal: [], toast: [], navigate: [] };

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
  delete require.cache[require.resolve(PAGE)];
  require(PAGE);

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
  return { page, storage, calls };
}

async function loadTimedPage(page) {
  page.onLoad({
    grade: '1', ruleId: 'g1_add_20', operation: 'add', limit: '20',
    count: '10', mode: 'timed', durationSeconds: '60'
  });
  await wait(200);
}

function fillAllCorrect(page) {
  const questions = generator.generateQuestions({
    ruleId: 'g1_add_20', count: 10, sessionId: page.data.quizId
  }).questions;
  questions.forEach((question, index) => {
    page.onAnswerInput({
      currentTarget: { dataset: { index: index } },
      detail: { value: String(question.answer) }
    });
  });
}

test('提前提交失败：恢复倒计时，仍可改答案，重试成功', async function () {
  const original = service.submitAnswers;
  const { page, calls } = createHarness();
  try {
    await loadTimedPage(page);
    fillAllCorrect(page);
    service.submitAnswers = async () => ({ ok: false, code: 'MOCK', message: '模拟批改失败' });

    page.onSubmitTap();
    await wait(350);

    assert.equal(page.data.deadlineLocked, false);
    assert.equal(page.data.submitting, false);
    assert.equal(page.submitted, false);
    assert.ok(page.tickTimer, '提前失败后应恢复倒计时');
    assert.ok(calls.modal.indexOf('提交失败') !== -1);

    page.onAnswerInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: '999' } });
    assert.equal(page.answers[0], '999', '未到截止时仍可修改答案');

    service.submitAnswers = original;
    page.onSubmitTap();
    await wait(450);
    assert.equal(page.data.finished, true);
    assert.equal(page.data.summary.correct + page.data.summary.wrong + page.data.summary.blank, 10);
  } finally {
    service.submitAnswers = original;
    page.onUnload();
  }
});

test('到截止后提交失败：答案冻结，只能重试同一份提交', async function () {
  const original = service.submitAnswers;
  const { page, storage } = createHarness();
  try {
    await loadTimedPage(page);
    fillAllCorrect(page);
    page.startTime = Date.now() - 61000; // 已经超过 60 秒
    service.submitAnswers = async () => ({ ok: false, code: 'MOCK', message: '模拟批改失败' });

    page.onSubmitTap();
    await wait(350);

    assert.equal(page.data.deadlineLocked, true);
    assert.equal(page.data.submitting, false);
    assert.equal(page.submitted, false);
    assert.equal(page.tickTimer, null, '截止后不应再恢复倒计时');

    const before = page.answers.slice();
    page.onAnswerInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: '999' } });
    assert.deepEqual(page.answers, before, '截止后不能修改答案');

    service.submitAnswers = original;
    page.onSubmitTap();
    await wait(450);
    assert.equal(page.data.finished, true);
    assert.equal(page.result.finishedBy, 'timeup');
    assert.equal(storage[STORAGE_KEY].length, 1);
  } finally {
    service.submitAnswers = original;
    page.onUnload();
  }
});

test('后台收到批改失败：不卡在提交中，回前台恢复倒计时', async function () {
  const original = service.submitAnswers;
  const { page } = createHarness();
  let resolveSubmit = null;
  try {
    await loadTimedPage(page);
    fillAllCorrect(page);
    service.submitAnswers = () => new Promise((resolve) => { resolveSubmit = resolve; });

    page.onSubmitTap();
    await wait(50);
    assert.equal(page.data.submitting, true);
    page.onHide();
    resolveSubmit({ ok: false, code: 'MOCK', message: '后台失败' });
    await wait(120);

    assert.equal(page.data.submitting, false);
    assert.equal(page.submitted, false);
    assert.equal(page.data.deadlineLocked, false);

    page.onShow();
    assert.ok(page.tickTimer, '回到前台后应恢复倒计时');
  } finally {
    service.submitAnswers = original;
    page.onUnload();
  }
});

test('手动提交与到时同时触发，只调用一次批改服务', async function () {
  const original = service.submitAnswers;
  const { page } = createHarness();
  let calls = 0;
  try {
    await loadTimedPage(page);
    fillAllCorrect(page);
    service.submitAnswers = async () => {
      calls += 1;
      return { ok: false, code: 'MOCK', message: '模拟批改失败' };
    };

    const first = page.submit('manual');
    const second = page.submit('timeup');
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  } finally {
    service.submitAnswers = original;
    page.onUnload();
  }
});
