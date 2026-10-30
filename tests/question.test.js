/**
 * 出题与判分自测（P3：整数加减法）。
 *
 * 运行：
 *   node --test tests/question.test.js
 * 或：
 *   node tests/question.test.js
 *
 * 只依赖 Node 内置模块，不需要微信开发者工具；云函数副本的逐字节一致性也在最后检查。
 */
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const MINIAPP = path.join(__dirname, '..', 'miniapp');
const generator = require(path.join(MINIAPP, 'utils', 'question', 'generator.js'));
const scoring = require(path.join(MINIAPP, 'utils', 'question', 'scoring.js'));
const core = require(path.join(MINIAPP, 'utils', 'question', 'session-core.js'));
const rulesTable = require(path.join(MINIAPP, 'utils', 'practice-rules.js'));
const practiceConfig = require(path.join(MINIAPP, 'utils', 'practice-config.js'));

const IMPLEMENTED = rulesTable.RULES.filter(function (rule) {
  return rule.operation === 'add' || rule.operation === 'subtract';
});
const UNSUPPORTED = rulesTable.RULES.filter(function (rule) {
  return rule.operation !== 'add' && rule.operation !== 'subtract';
});

function configFor(rule, extra) {
  return Object.assign({
    grade: rule.grade,
    ruleId: rule.id,
    operation: rule.operation,
    limit: rule.limit,
    count: 10,
    mode: 'normal',
    durationSeconds: 120
  }, extra || {});
}

function gen(rule, count, sessionId) {
  return generator.generateQuestions({
    ruleId: rule.id,
    operation: rule.operation,
    limit: rule.limit,
    count: count,
    sessionId: sessionId || 'test-session'
  });
}

// ---------------------------------------------------------------- 规则与范围

test('规则表里 6 个整数加减法预设可出题，其余 7 个留给 P4', function () {
  assert.equal(IMPLEMENTED.length, 6);
  assert.deepEqual(IMPLEMENTED.map(function (r) { return r.id; }).sort(), [
    'g1_add_20', 'g1_subtract_20',
    'g2_add_100', 'g2_subtract_100',
    'g3_add_1000', 'g3_subtract_1000'
  ]);
  assert.equal(UNSUPPORTED.length, 7);
});

for (const rule of IMPLEMENTED) {
  test(rule.id + '：出题数量和范围都符合规则表', function () {
    const generated = gen(rule, 30, 'range-' + rule.id);
    assert.equal(generated.ok, true, generated.message);
    assert.equal(generated.questions.length, 30);
    generated.questions.forEach(function (q) {
      assert.equal(q.ruleId, rule.id);
      assert.ok(q.left >= 0 && q.left <= rule.limit, q.left + ' 越界');
      assert.ok(q.right >= 0 && q.right <= rule.limit, q.right + ' 越界');
      if (rule.operation === 'add') {
        assert.ok(q.left + q.right <= rule.limit, q.formula + ' 和超范围');
        assert.equal(q.answer, q.left + q.right);
      } else {
        assert.ok(q.right <= q.left, q.formula + ' 出现负数');
        assert.equal(q.answer, q.left - q.right);
      }
    });
  });

  test(rule.id + '：同一次练习不重复，题号唯一，题干不含答案', function () {
    const generated = gen(rule, 50, 'unique-' + rule.id);
    assert.equal(generated.questions.length, 50);
    const formulas = generated.questions.map(function (q) { return q.formula; });
    assert.equal(new Set(formulas).size, formulas.length, '出现重复算式');
    const ids = generated.questions.map(function (q) { return q.id; });
    assert.equal(new Set(ids).size, ids.length, '题号重复');
    generated.questions.forEach(function (q) {
      assert.ok(q.text.endsWith('= ?'), '题干不应包含答案：' + q.text);
    });
  });
}

// ---------------------------------------------------------------- 确定性与抽样

test('同 ruleId + sessionId 出题可复现，换 sessionId 会变', function () {
  const rule = rulesTable.getRule('g1_add_20');
  const a = gen(rule, 20, 'same-seed').questions.map(function (q) { return q.formula; });
  const b = gen(rule, 20, 'same-seed').questions.map(function (q) { return q.formula; });
  const c = gen(rule, 20, 'other-seed').questions.map(function (q) { return q.formula; });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('1000 以内走抽样也不重复、不越界', function () {
  const rule = rulesTable.getRule('g3_add_1000');
  const generated = gen(rule, 50, 'big-sample');
  assert.equal(generated.questions.length, 50);
  const seen = new Set();
  generated.questions.forEach(function (q) {
    assert.ok(q.answer <= 1000);
    assert.ok(q.left + q.right <= 1000);
    seen.add(q.formula);
  });
  assert.equal(seen.size, 50);
});

test('同样的抽样 seed 在 1000 以内也可复现', function () {
  const rule = rulesTable.getRule('g3_subtract_1000');
  const a = gen(rule, 30, 'big-seed').questions.map(function (q) { return q.formula; });
  const b = gen(rule, 30, 'big-seed').questions.map(function (q) { return q.formula; });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------- 输入校验

test('出题器拒绝非法运算、范围和题量', function () {
  assert.equal(generator.generateQuestions({ operation: 'multiply', limit: 20, count: 10 }).ok, false);
  assert.equal(generator.generateQuestions({ operation: 'add', limit: 1, count: 10 }).ok, false);
  assert.equal(generator.generateQuestions({ operation: 'add', limit: 20, count: 0 }).ok, false);
  assert.equal(generator.generateQuestions({ operation: 'add', limit: 20, count: 51 }).ok, false);
  assert.equal(generator.generateQuestions({ operation: 'add', limit: 20, count: 1.5 }).ok, false);
});

test('题库不够时返回 POOL_EXHAUSTED 而不是死循环', function () {
  const result = generator.generateQuestions({ operation: 'add', limit: 3, count: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'POOL_EXHAUSTED');
  assert.ok(result.message.indexOf('10') !== -1, result.message);
});

test('请求层拒绝年级与题型不匹配、兼容字段被改', function () {
  const rule = rulesTable.getRule('g1_add_20');
  const bad = [
    Object.assign(configFor(rule), { grade: 2 }),
    Object.assign(configFor(rule), { ruleId: 'unknown' }),
    Object.assign(configFor(rule), { operation: 'subtract' }),
    Object.assign(configFor(rule), { limit: 100 }),
    Object.assign(configFor(rule), { count: 9 }),
    Object.assign(configFor(rule), { count: 51 }),
    Object.assign(configFor(rule), { mode: 'unknown' }),
    Object.assign(configFor(rule), { durationSeconds: 59 })
  ];
  bad.forEach(function (config) {
    const response = core.handleRequest({ action: 'createQuestionSet', payload: { config: config } });
    assert.equal(response.ok, false, JSON.stringify(config));
    assert.equal(response.code, 'INVALID_CONFIG');
  });
});

// ---------------------------------------------------------------- 判分

test('全对：全部 correct，正确率 100%', function () {
  const rule = rulesTable.getRule('g1_subtract_20');
  const questions = gen(rule, 10).questions;
  const graded = scoring.gradeAnswers({
    questions: questions,
    answers: questions.map(function (q) { return q.answer; })
  });
  assert.equal(graded.result.correct, 10);
  assert.equal(graded.result.blank, 0);
  assert.equal(graded.result.accuracyPercent, 100);
});

test('全错：全部 wrong，正确率 0%', function () {
  const rule = rulesTable.getRule('g2_add_100');
  const questions = gen(rule, 10).questions;
  const graded = scoring.gradeAnswers({
    questions: questions,
    answers: questions.map(function (q) { return q.answer + 1; })
  });
  assert.equal(graded.result.wrong, 10);
  assert.equal(graded.result.accuracyPercent, 0);
});

test('空白记未答，0 是有效答案', function () {
  const questions = [
    { id: '1', ruleId: 'g1_subtract_20', operation: 'subtract', left: 8, right: 8, answer: 0, text: '8 - 8 = ?' },
    { id: '2', ruleId: 'g1_add_20', operation: 'add', left: 4, right: 1, answer: 5, text: '4 + 1 = ?' },
    { id: '3', ruleId: 'g1_add_20', operation: 'add', left: 2, right: 2, answer: 4, text: '2 + 2 = ?' }
  ];
  const graded = scoring.gradeAnswers({ questions: questions, answers: ['0', '0', ''] });
  assert.equal(graded.result.questions[0].verdict, 'correct');
  assert.equal(graded.result.questions[1].verdict, 'wrong');
  assert.equal(graded.result.questions[2].verdict, 'blank');
  assert.equal(graded.result.blank, 1);
  assert.equal(graded.result.answered, 2);
});

test('前导零、空格、非法格式与 4 位答案', function () {
  const questions = [{ id: '1', operation: 'add', left: 500, right: 500, answer: 1000, text: '500 + 500 = ?' }];
  assert.equal(scoring.gradeAnswers({ questions: questions, answers: [' 1000 '] }).result.questions[0].verdict, 'correct');
  assert.equal(scoring.gradeAnswers({ questions: questions, answers: ['01000'] }).result.questions[0].verdict, 'wrong');
  assert.equal(scoring.gradeAnswers({ questions: questions, answers: ['1000'] }).result.questions[0].verdict, 'correct');
  ['abc', '1.5', '-3', '1e3'].forEach(function (bad) {
    const graded = scoring.gradeAnswers({ questions: questions, answers: [bad] });
    assert.equal(graded.result.questions[0].verdict, 'wrong');
    assert.equal(graded.result.questions[0].reason, 'invalidFormat');
  });
  assert.equal(scoring.gradeAnswers({ questions: questions, answers: [''] }).result.blank, 1);
  assert.equal(scoring.gradeAnswers({ questions: questions, answers: [null] }).result.blank, 1);
});

test('数量不一致或题目缺答案时拒绝批改', function () {
  const questions = gen(rulesTable.getRule('g1_add_20'), 5).questions;
  assert.equal(scoring.gradeAnswers({ questions: questions, answers: [1] }).code, 'ANSWER_COUNT_MISMATCH');
  assert.equal(scoring.gradeAnswers({ questions: [{ id: 'x', operation: 'add', left: 1, right: 1 }], answers: [2] }).code, 'INVALID_QUESTIONS');
});

test('正确 + 错误 + 未答恒等于总题数（100 组随机作答）', function () {
  for (let round = 0; round < 100; round += 1) {
    const rule = IMPLEMENTED[round % IMPLEMENTED.length];
    const questions = gen(rule, 30, 'conservation-' + round).questions;
    const answers = questions.map(function (q, index) {
      const mode = (index + round) % 5;
      if (mode === 0) return '';
      if (mode === 1) return q.answer;
      return q.answer + 2;
    });
    const graded = scoring.gradeAnswers({ questions: questions, answers: answers });
    const r = graded.result;
    assert.equal(r.correct + r.wrong + r.blank, r.total);
    assert.equal(r.answered, r.correct + r.wrong);
  }
});

test('需求验收样例：2 对 1 错 1 未答，正确率 50%', function () {
  const questions = [
    { id: '1', operation: 'add', left: 3, right: 2, answer: 5, text: '3 + 2 = ?', ruleId: 'g1_add_20' },
    { id: '2', operation: 'subtract', left: 7, right: 3, answer: 4, text: '7 - 3 = ?', ruleId: 'g1_subtract_20' },
    { id: '3', operation: 'subtract', left: 8, right: 8, answer: 0, text: '8 - 8 = ?', ruleId: 'g1_subtract_20' },
    { id: '4', operation: 'add', left: 4, right: 1, answer: 5, text: '4 + 1 = ?', ruleId: 'g1_add_20' }
  ];
  const r = scoring.gradeAnswers({ questions: questions, answers: ['5', '5', '0', ''] }).result;
  assert.deepEqual(
    { total: r.total, correct: r.correct, wrong: r.wrong, blank: r.blank, percent: r.accuracyPercent },
    { total: 4, correct: 2, wrong: 1, blank: 1, percent: 50 }
  );
  assert.equal(r.questions[2].correctText, '8 - 8 = 0');
});

// ---------------------------------------------------------------- 请求层

test('createQuestionSet 下发脱敏题目，带 ruleId 与规则版本', function () {
  const rule = rulesTable.getRule('g2_subtract_100');
  const response = core.handleRequest({
    action: 'createQuestionSet',
    payload: { config: configFor(rule, { count: 20 }), sessionId: 'req-1' }
  });
  assert.equal(response.ok, true, response.message);
  assert.equal(response.data.questions.length, 20);
  assert.ok(response.data.ruleVersion);
  response.data.questions.forEach(function (q) {
    assert.equal(q.answer, undefined);
    assert.equal(q.ruleId, rule.id);
    assert.ok(q.text && q.id);
  });
});

test('未实现的题型返回 UNSUPPORTED_RULE，并说明原因', function () {
  const rule = UNSUPPORTED[0];
  const response = core.handleRequest({
    action: 'createQuestionSet',
    payload: { config: configFor(rule) }
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'UNSUPPORTED_RULE');
  assert.ok(response.message.indexOf('尚未开放') !== -1, response.message);
});

test('旧链接（只有 operation + limit=20）仍按一年级规则解析', function () {
  const legacy = practiceConfig.fromQuery({
    operation: 'subtract', limit: '20', count: '20', mode: 'timed', durationSeconds: '60'
  });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.value.ruleId, 'g1_subtract_20');
  const response = core.handleRequest({
    action: 'createQuestionSet',
    payload: { config: legacy.value, sessionId: 'legacy-1' }
  });
  assert.equal(response.ok, true, response.message);
  assert.equal(response.data.questions.length, 20);
});

test('createQuestionSet -> submitAnswers 走通，结果带 ruleId、grade 和设置', function () {
  const rule = rulesTable.getRule('g3_add_1000');
  const config = configFor(rule, { count: 12, mode: 'timed', durationSeconds: 60 });
  const created = core.handleRequest({
    action: 'createQuestionSet',
    payload: { config: config, sessionId: 'req-2' }
  });
  assert.equal(created.ok, true, created.message);

  // 真实流程里题目由服务端保存；这里用同 sessionId 重放拿到含答案的题目
  const questions = gen(rule, 12, created.data.quizId).questions;
  const answers = questions.map(function (q, index) {
    if (index === 0) return '';
    if (index === 1) return q.answer + 1;
    return q.answer;
  });
  const submitted = core.handleRequest({
    action: 'submitAnswers',
    payload: {
      quizId: created.data.quizId,
      config: config,
      questions: questions,
      answers: answers,
      durationSeconds: 42,
      finishedBy: 'timeup'
    }
  });
  assert.equal(submitted.ok, true, submitted.message);
  const r = submitted.data.result;
  assert.equal(r.ruleId, rule.id);
  assert.equal(r.grade, rule.grade);
  assert.equal(r.blank, 1);
  assert.equal(r.wrong, 1);
  assert.equal(r.correct, 10);
  assert.equal(r.durationSeconds, 42);
  assert.equal(r.finishedBy, 'timeup');
  assert.equal(r.config.ruleId, rule.id);
});

test('submitAnswers 拒绝被篡改的题目和数量不一致', function () {
  const tampered = core.handleRequest({
    action: 'submitAnswers',
    payload: {
      questions: [{ id: 'x', operation: 'add', left: 3, right: 4, answer: 99, text: '3 + 4 = ?' }],
      answers: [99]
    }
  });
  assert.equal(tampered.code, 'INVALID_QUESTIONS');
  const mismatch = core.handleRequest({
    action: 'submitAnswers',
    payload: {
      questions: [{ id: 'y', operation: 'add', left: 3, right: 4, answer: 7, text: '3 + 4 = ?' }],
      answers: []
    }
  });
  assert.equal(mismatch.code, 'ANSWER_COUNT_MISMATCH');
});

test('未知 action 返回 UNKNOWN_ACTION', function () {
  assert.equal(core.handleRequest({ action: 'nope' }).code, 'UNKNOWN_ACTION');
});

// ---------------------------------------------------------------- 本地服务层

test('本地服务：页面只交 quizId 和作答，也能取回题目并判分', async function () {
  const service = require(path.join(MINIAPP, 'services', 'question-service.js'));
  service._clearLocalSessions();
  const rule = rulesTable.getRule('g1_subtract_20');
  const config = configFor(rule, { count: 10 });
  const created = await service.createQuestionSet(config);
  assert.equal(created.ok, true, created.message);
  assert.equal(created.source, 'local');
  assert.equal(created.data.questions[0].answer, undefined, '页面拿到的题目不应带答案');

  const questions = gen(rule, 10, created.data.quizId).questions;
  const submitted = await service.submitAnswers({
    quizId: created.data.quizId,
    config: config,
    answers: questions.map(function (q) { return String(q.answer); })
  });
  assert.equal(submitted.ok, true, submitted.message);
  assert.equal(submitted.source, 'local');
  assert.equal(submitted.data.result.correct, 10);
  assert.equal(submitted.data.result.ruleId, rule.id);
});

test('本地服务：quizId 找不到时给出可读错误', async function () {
  const service = require(path.join(MINIAPP, 'services', 'question-service.js'));
  service._clearLocalSessions();
  const response = await service.submitAnswers({
    quizId: 'no-such-quiz',
    config: configFor(rulesTable.getRule('g1_add_20')),
    answers: ['1']
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'QUIZ_NOT_FOUND');
});

test('本地服务：未开放题型返回 UNSUPPORTED_RULE', async function () {
  const service = require(path.join(MINIAPP, 'services', 'question-service.js'));
  const response = await service.createQuestionSet(configFor(rulesTable.getRule('g3_mixed_2step')));
  assert.equal(response.ok, false);
  assert.equal(response.code, 'UNSUPPORTED_RULE');
});

// ---------------------------------------------------------------- 副本一致性

test('云函数副本与小程序端逐字节一致（4 个文件）', function () {
  const pairs = [
    ['utils/question/generator.js', 'cloudfunctions/createQuestionSet/lib/generator.js'],
    ['utils/question/scoring.js', 'cloudfunctions/createQuestionSet/lib/scoring.js'],
    ['utils/question/session-core.js', 'cloudfunctions/createQuestionSet/lib/session-core.js'],
    ['utils/practice-rules.js', 'cloudfunctions/createQuestionSet/practice-rules.js']
  ];
  pairs.forEach(function (pair) {
    const a = fs.readFileSync(path.join(MINIAPP, pair[0]), 'utf8').replace(/\r\n/g, '\n');
    const b = fs.readFileSync(path.join(MINIAPP, pair[1]), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(b, a, pair[1] + ' 与 ' + pair[0] + ' 不一致，请按 lib/README.md 同步');
  });
});
