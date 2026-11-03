/**
 * 答题页「题目导航 + 交卷回顾」自测。
 *
 * 运行：
 *   node --test tests/practice-navigation.test.cjs
 *
 * 用最小的 Page / wx 假实现跑真实页面代码，不依赖微信开发者工具。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MINIAPP = path.join(__dirname, '..', 'miniapp');
const PAGE = path.join(MINIAPP, 'pages/practice/practice.js');
const generator = require(path.join(MINIAPP, 'utils', 'question', 'generator.js'));
const session = require(path.join(MINIAPP, 'utils', 'practice-session.js'));
const { RULE_VERSION } = require(path.join(MINIAPP, 'utils', 'practice-rules.js'));
const STORAGE_KEY = 'kousuan_practice_records_v1';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness() {
  let definition = null;
  const storage = {};
  const calls = { toast: [], modal: [], navigate: [] };

  global.wx = {
    showToast(options) { calls.toast.push(options.title); },
    showModal(options) {
      calls.modal.push(options.title);
      if (options.success) options.success({ confirm: true });
    },
    navigateTo(options) {
      calls.navigate.push(options.url);
      if (options.success) {
        options.success({ eventChannel: { emit(name) { calls.navigate.push('emit:' + name); } } });
      }
    },
    navigateBack() {},
    redirectTo() {},
    setStorageSync(key, value) { storage[key] = value; },
    getStorageSync(key) { return storage[key]; },
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

function configFor(ruleId, grade, operation, limit, count) {
  return {
    grade: String(grade),
    ruleId: ruleId,
    operation: operation,
    limit: String(limit),
    count: String(count),
    mode: 'normal',
    durationSeconds: '120'
  };
}

test('作答阶段：未答灰色、已答标记，点题号可跳到最后一题', async function () {
  const { page } = createHarness();
  page.onLoad(configFor('g1_add_20', 1, 'add', 20, 10));
  await wait(150);

  assert.equal(page.data.total, 10);
  assert.equal(page.data.navCells.length, 10);
  assert.ok(page.data.navCells.every((cell) => cell.state === 'unanswered'));

  page.onAnswerInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: '5' } });
  page.onAnswerInput({ currentTarget: { dataset: { index: 1 } }, detail: { value: '6' } });
  assert.equal(page.data.navCells[0].state, 'answered');
  assert.equal(page.data.navCells[1].state, 'answered');
  assert.equal(page.data.navCells[2].state, 'unanswered');

  page.jumpTo({ currentTarget: { dataset: { index: 9 } } });
  assert.equal(page.data.currentIndex, 9);
  assert.equal(page.data.reviewMode, false);
});

test('交卷后：正确绿 / 错误红 / 未答橙，点题号回看答案，查看结果按 practice-session 交接', async function () {
  const { page, storage, calls } = createHarness();
  session.clearPendingResult();
  page.onLoad(configFor('g1_add_20', 1, 'add', 20, 10));
  await wait(150);

  const quizId = page.data.quizId;
  const questions = generator.generateQuestions({ ruleId: 'g1_add_20', count: 10, sessionId: quizId }).questions;
  page.onAnswerInput({ currentTarget: { dataset: { index: 0 } }, detail: { value: String(questions[0].answer) } });
  page.onAnswerInput({
    currentTarget: { dataset: { index: 1 } },
    detail: { value: questions[1].answer === 0 ? '1' : '0' }
  });

  page.onSubmitTap();
  await wait(400);

  assert.equal(page.data.reviewMode, true);
  assert.deepEqual(
    { total: page.data.summary.total, correct: page.data.summary.correct, wrong: page.data.summary.wrong, blank: page.data.summary.blank },
    { total: 10, correct: 1, wrong: 1, blank: 8 }
  );
  assert.equal(page.data.navCells[0].state, 'correct');
  assert.equal(page.data.navCells[1].state, 'wrong');
  assert.equal(page.data.navCells[2].state, 'blank');

  assert.equal(page.data.reviewUserText, String(questions[0].answer));
  assert.equal(page.data.reviewVerdict, 'correct');

  page.jumpTo({ currentTarget: { dataset: { index: 1 } } });
  assert.equal(page.data.currentIndex, 1);
  assert.equal(page.data.reviewVerdict, 'wrong');
  assert.ok(page.data.reviewCorrectAnswer.length > 0);

  page.jumpTo({ currentTarget: { dataset: { index: 2 } } });
  assert.equal(page.data.reviewVerdict, 'blank');
  assert.equal(page.data.reviewUserText, '未答');

  const records = storage[STORAGE_KEY];
  assert.equal(records.length, 1, '交卷后应立即保存记录');

  page.openResultPage();
  const resultUrl = calls.navigate[calls.navigate.length - 1];
  assert.ok(resultUrl.indexOf('/pages/result/result?id=') === 0, resultUrl);
  assert.equal(session.peekPendingResult(), null, '已保存时直接按 id 查看详情');

  const record = records[0];
  assert.equal(record.id, page.data.quizId);
  assert.equal(record.ruleId, 'g1_add_20');
  assert.equal(record.ruleVersion, RULE_VERSION);
  assert.equal(record.items.length, 10);
  assert.equal(record.items[0].status, 'correct');
  assert.equal(record.items[1].status, 'wrong');
  assert.equal(record.items[2].status, 'unanswered');
  assert.equal(typeof record.items[1].userAnswer, 'string');
  assert.equal(record.items[2].userAnswer, '');
  assert.ok(record.items[0].expression.indexOf('= ?') === -1, 'expression 不应带 = ?');
  assert.ok(record.items[0].question, '应带结构化原题快照');
  assert.equal(record.items[0].question.kind, 'integer');
});

test('50 题：题号方块全部展开，可跳到最后一题', async function () {
  const { page } = createHarness();
  page.onLoad(configFor('g3_add_1000', 3, 'add', 1000, 50));
  await wait(250);

  assert.equal(page.data.total, 50);
  assert.equal(page.data.navCells.length, 50);
  page.jumpTo({ currentTarget: { dataset: { index: 49 } } });
  assert.equal(page.data.currentIndex, 49);
  assert.equal(page.data.currentText.length > 0, true);
});
