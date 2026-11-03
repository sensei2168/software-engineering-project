/**
 * 出题响应的页面生命周期：后台返回、后台失败、卸载后晚响应。
 *
 * 对应 PR #5 复查 P1：后台返回出题响应不能把页面永久卡在 loading。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MINIAPP = path.join(__dirname, '..', 'miniapp');
const PAGE = path.join(MINIAPP, 'pages/practice/practice.js');
const service = require(path.join(MINIAPP, 'services', 'question-service.js'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONFIG = {
  grade: 1, ruleId: 'g1_add_20', operation: 'add', limit: 20,
  count: 10, mode: 'normal', durationSeconds: 120
};

function createHarness() {
  let definition = null;
  const storage = {};
  global.wx = {
    showToast() {},
    showModal() {},
    navigateTo() {},
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
  page.setData = function setData(patch) { Object.assign(this.data, patch); };
  return page;
}

function deferredCreate() {
  let resolveCreate = null;
  let calls = 0;
  const original = service.createQuestionSet;
  service.createQuestionSet = () => {
    calls += 1;
    return new Promise((resolve) => { resolveCreate = resolve; });
  };
  return {
    resolve: (value) => resolveCreate(value),
    calls: () => calls,
    restore: () => { service.createQuestionSet = original; },
    original: original
  };
}

test('后台返回出题成功：恢复后直接显示题目并开始计时', async function () {
  const page = createHarness();
  const pending = deferredCreate();
  try {
    page.onLoad(CONFIG);
    await wait(30);
    assert.equal(page.data.loading, true);

    page.onHide();
    const real = await pending.original(CONFIG);
    pending.resolve(real);
    await wait(80);

    assert.equal(page.data.loading, false);
    assert.equal(page.data.questions.length, 10);
    assert.equal(page.startTime, 0, '后台返回不应提前开始计时');

    page.onShow();
    assert.ok(page.startTime > 0, '回到前台应开始计时');
    assert.equal(pending.calls(), 1, '不应重新出第二套题');
  } finally {
    pending.restore();
    page.onUnload();
  }
});

test('后台返回出题失败：停止 loading 并显示错误，可重新出题', async function () {
  const page = createHarness();
  const pending = deferredCreate();
  try {
    page.onLoad(CONFIG);
    await wait(30);
    page.onHide();
    pending.resolve({ ok: false, code: 'MOCK', message: '模拟出题失败' });
    await wait(80);

    assert.equal(page.data.loading, false);
    assert.equal(page.data.questions.length, 0);
    assert.ok(page.data.loadError.indexOf('模拟出题失败') !== -1);

    pending.restore();
    page.retry();
    await wait(200);
    assert.equal(page.data.loading, false);
    assert.equal(page.data.questions.length, 10);
    assert.equal(page.data.loadError, '');
  } finally {
    pending.restore();
    page.onUnload();
  }
});

test('页面卸载后晚到的出题响应不会覆盖页面', async function () {
  const page = createHarness();
  const pending = deferredCreate();
  try {
    page.onLoad(CONFIG);
    await wait(30);
    page.onUnload();
    const real = await pending.original(CONFIG);
    pending.resolve(real);
    await wait(80);

    assert.equal(page.data.loading, true);
    assert.equal(page.data.questions.length, 0);
    assert.equal(page.questions.length, 0);
  } finally {
    pending.restore();
    page.onUnload();
  }
});
