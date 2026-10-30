/**
 * 出题与判分自测（整数四则：加减乘除）。
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
const strategies = require(path.join(MINIAPP, 'utils', 'question', 'rule-strategies.js'));
const rulesTable = require(path.join(MINIAPP, 'utils', 'practice-rules.js'));
const practiceConfig = require(path.join(MINIAPP, 'utils', 'practice-config.js'));

const IMPLEMENTED = rulesTable.RULES.filter(function (rule) {
  return Boolean(strategies.getStrategy(rule.id));
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
    count: count,
    sessionId: sessionId || 'test-session'
  });
}

function assertInRange(rule, strategy, q) {
  const op = rule.operation;
  if (op === 'add') {
    assert.ok(q.left + q.right <= rule.limit, q.formula + ' 和超范围');
    assert.equal(q.answer, q.left + q.right);
  } else if (op === 'subtract') {
    assert.ok(q.left <= rule.limit && q.right <= q.left, q.formula + ' 越界或负数');
    assert.equal(q.answer, q.left - q.right);
  } else if (op === 'multiply') {
    assert.ok(q.left >= strategy.aMin && q.left <= strategy.aMax, q.left + ' 不在被乘数范围');
    assert.ok(q.right >= strategy.bMin && q.right <= strategy.bMax, q.right + ' 不在乘数范围');
    assert.equal(q.answer, q.left * q.right);
    if (strategy.commutative) assert.ok(q.left <= q.right, q.formula + ' 交换乘数未合并');
  } else if (op === 'divide') {
    assert.ok(q.right >= strategy.divisorMin && q.right <= strategy.divisorMax, q.right + ' 不在除数范围');
    assert.equal(q.left % q.right, 0, q.formula + ' 不能整除');
    assert.equal(q.answer, q.left / q.right);
    if (strategy.quotientMin !== undefined) {
      assert.ok(q.answer >= strategy.quotientMin && q.answer <= strategy.quotientMax, q.answer + ' 商越界');
    } else {
      assert.ok(q.left >= strategy.dividendMin && q.left <= strategy.dividendMax, q.left + ' 被除数越界');
    }
  } else if (op === 'mixed') {
    assert.equal(q.answerKind, 'integer');
    assert.equal(q.tokens.length, 5);
    assert.ok([q.tokens[0], q.tokens[2], q.tokens[4]].every(function (v) {
      return Number.isInteger(v) && v >= 0 && v <= 100;
    }), q.formula + ' 操作数越界');
    assert.equal(generator.evaluateMixed(q.tokens), q.answer);
    assert.ok(q.tokens[1] === 'multiply' || q.tokens[1] === 'divide' ||
      q.tokens[3] === 'multiply' || q.tokens[3] === 'divide', q.formula + ' 不含乘除');
  } else if (op === 'decimal_add_sub') {
    assert.equal(q.answerKind, 'decimal');
    assert.ok(q.leftTenths >= 0 && q.leftTenths <= 100);
    assert.ok(q.rightTenths >= 0 && q.rightTenths <= 100);
    assert.ok(q.answerTenths >= 0 && q.answerTenths <= 100);
    assert.equal(q.answerTenths, q.op === 'add' ? q.leftTenths + q.rightTenths : q.leftTenths - q.rightTenths);
    assert.equal(q.answer, q.answerTenths / 10);
  } else if (op === 'fraction_add_sub') {
    assert.equal(q.answerKind, 'fraction');
    assert.ok(q.denominator >= 2 && q.denominator <= 9);
    assert.ok(q.leftNumerator >= 1 && q.leftNumerator < q.denominator);
    assert.ok(q.rightNumerator >= 1 && q.rightNumerator < q.denominator);
    const expected = q.op === 'add' ? q.leftNumerator + q.rightNumerator : q.leftNumerator - q.rightNumerator;
    assert.ok(expected >= 0 && expected <= q.denominator, q.formula + ' 结果越界');
    assert.equal(q.answerNumerator, expected);
    assert.equal(q.answer, expected + '/' + q.denominator);
  }
}

// ---------------------------------------------------------------- 规则与范围

test('13 个设置预设全部有出题策略', function () {
  assert.equal(IMPLEMENTED.length, 13);
  assert.equal(IMPLEMENTED.length, rulesTable.RULES.length);
  assert.equal(strategies.listSupportedRuleIds().length, 13);
});

test('策略表与规则表一一对应，不会出现有策略没规则的情况', function () {
  strategies.listSupportedRuleIds().forEach(function (id) {
    assert.ok(rulesTable.getRule(id), id + ' 在练习规则表里不存在');
  });
  assert.equal(strategies.listSupportedRuleIds().length, IMPLEMENTED.length);
});

for (const rule of IMPLEMENTED) {
  test(rule.id + '：出题数量、范围、题干都符合规则', function () {
    const strategy = strategies.getStrategy(rule.id);
    const generated = gen(rule, 30, 'range-' + rule.id);
    assert.equal(generated.ok, true, generated.message);
    assert.equal(generated.questions.length, 30);
    generated.questions.forEach(function (q) {
      assert.equal(q.ruleId, rule.id);
      assert.equal(q.operation, rule.operation);
      assertInRange(rule, strategy, q);
      assert.ok(q.text.endsWith('= ?'), '题干不应包含答案：' + q.text);
    });
  });

  test(rule.id + '：同一次练习不重复，题号唯一', function () {
    const generated = gen(rule, 40, 'unique-' + rule.id);
    assert.equal(generated.questions.length, 40);
    const formulas = generated.questions.map(function (q) { return q.formula; });
    assert.equal(new Set(formulas).size, formulas.length, '出现重复算式');
    const ids = generated.questions.map(function (q) { return q.id; });
    assert.equal(new Set(ids).size, ids.length, '题号重复');
  });
}

// ---------------------------------------------------------------- 各题型特性

test('表内乘法交换乘数算重复：最多 45 种，50 题明确提示题库不足', function () {
  const rule = rulesTable.getRule('g2_multiply_table');
  const pool = generator.buildPool(strategies.getStrategy(rule.id));
  assert.equal(pool.length, 45);
  const result = gen(rule, 50);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'POOL_EXHAUSTED');
  assert.ok(result.message.indexOf('45') !== -1, result.message);
});

test('表内除法：除数、商都是 1—9，被除数是整除结果', function () {
  const rule = rulesTable.getRule('g2_divide_table');
  const generated = gen(rule, 40);
  assert.equal(generated.questions.length, 40);
  generated.questions.forEach(function (q) {
    assert.ok(q.right >= 1 && q.right <= 9);
    assert.ok(q.answer >= 1 && q.answer <= 9);
    assert.equal(q.left, q.right * q.answer);
  });
});

test('两位数 × 一位数：被乘数 10—99，乘数 1—9', function () {
  const rule = rulesTable.getRule('g3_multiply_2by1');
  gen(rule, 50).questions.forEach(function (q) {
    assert.ok(q.left >= 10 && q.left <= 99);
    assert.ok(q.right >= 1 && q.right <= 9);
    assert.equal(q.answer, q.left * q.right);
  });
});

test('两位数 ÷ 一位数：被除数 10—99，能整除，除数 1—9', function () {
  const rule = rulesTable.getRule('g3_divide_2by1');
  gen(rule, 50).questions.forEach(function (q) {
    assert.ok(q.left >= 10 && q.left <= 99);
    assert.ok(q.right >= 1 && q.right <= 9);
    assert.equal(q.left % q.right, 0);
    assert.ok(Number.isInteger(q.answer));
  });
});

test('混合运算按优先级计算，不是简单从左到右', function () {
  assert.equal(generator.evaluateMixed([18, 'add', 6, 'multiply', 3]), 36);
  assert.equal(generator.evaluateMixed([24, 'divide', 3, 'multiply', 2]), 16);
  assert.equal(generator.evaluateMixed([10, 'subtract', 4, 'divide', 2]), 8);
  assert.equal(generator.evaluateMixed([8, 'divide', 4, 'divide', 2]), 1);
  assert.equal(generator.evaluateMixed([10, 'subtract', 2, 'subtract', 3]), 5);
  assert.equal(generator.evaluateMixed([5, 'divide', 0, 'add', 1]), null);
  assert.equal(generator.evaluateMixed([7, 'divide', 2, 'add', 1]), null);
  assert.equal(generator.evaluateMixed([60, 'multiply', 2, 'add', 1]), null);
});

test('混合运算题：三个 0—100 的数、至少一个乘除、答案与表达式一致', function () {
  const rule = rulesTable.getRule('g3_mixed_2step');
  const questions = gen(rule, 50).questions;
  assert.equal(questions.length, 50);
  questions.forEach(function (q) {
    assert.equal(q.tokens.length, 5);
    assert.equal(generator.evaluateMixed(q.tokens), q.answer);
    assert.ok(q.tokens[1] === 'multiply' || q.tokens[1] === 'divide' ||
      q.tokens[3] === 'multiply' || q.tokens[3] === 'divide', q.formula + ' 不含乘除');
    assert.ok(q.tokens[0] >= 0 && q.tokens[0] <= 100);
  });
});

test('小数题：一位小数、结果非负、加减各半', function () {
  const rule = rulesTable.getRule('g3_decimal_1place');
  [10, 11].forEach(function (count) {
    const questions = gen(rule, count, 'decimal-' + count).questions;
    const adds = questions.filter(function (q) { return q.op === 'add'; }).length;
    const subs = questions.filter(function (q) { return q.op === 'subtract'; }).length;
    assert.equal(adds, Math.ceil(count / 2));
    assert.equal(subs, Math.floor(count / 2));
    questions.forEach(function (q) {
      assert.equal(q.answer, q.op === 'add' ? (q.leftTenths + q.rightTenths) / 10 : (q.leftTenths - q.rightTenths) / 10);
      assert.ok(q.answer >= 0 && q.answer <= 10);
    });
  });
  assert.equal(generator.formatTenths(17), '1.7');
  assert.equal(generator.formatTenths(100), '10.0');
});

test('分数题：同分母真分数、结果 0—1、加减各半', function () {
  const rule = rulesTable.getRule('g3_fraction_same_den');
  [10, 11].forEach(function (count) {
    const questions = gen(rule, count, 'fraction-' + count).questions;
    const adds = questions.filter(function (q) { return q.op === 'add'; }).length;
    const subs = questions.filter(function (q) { return q.op === 'subtract'; }).length;
    assert.equal(adds, Math.ceil(count / 2));
    assert.equal(subs, Math.floor(count / 2));
    questions.forEach(function (q) {
      assert.ok(q.denominator >= 2 && q.denominator <= 9);
      assert.ok(q.leftNumerator < q.denominator && q.rightNumerator < q.denominator);
      assert.ok(q.answerNumerator >= 0 && q.answerNumerator <= q.denominator);
      assert.equal(q.answer, q.answerNumerator + '/' + q.denominator);
    });
  });
});

// ---------------------------------------------------------------- 确定性与抽样

test('同 ruleId + sessionId 出题可复现，换 sessionId 会变', function () {
  const rule = rulesTable.getRule('g2_multiply_table');
  const a = gen(rule, 20, 'same-seed').questions.map(function (q) { return q.formula; });
  const b = gen(rule, 20, 'same-seed').questions.map(function (q) { return q.formula; });
  const c = gen(rule, 20, 'other-seed').questions.map(function (q) { return q.formula; });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('1000 以内加法走抽样也不重复、不越界', function () {
  const rule = rulesTable.getRule('g3_add_1000');
  const generated = gen(rule, 50, 'big-sample');
  assert.equal(generated.questions.length, 50);
  const seen = new Set();
  generated.questions.forEach(function (q) {
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

test('出题器拒绝未知题型、非法题量', function () {
  assert.equal(generator.generateQuestions({ ruleId: 'nope', count: 10 }).ok, false);
  assert.equal(generator.generateQuestions({ ruleId: 'g1_add_20', count: 0 }).ok, false);
  assert.equal(generator.generateQuestions({ ruleId: 'g1_add_20', count: 51 }).ok, false);
  assert.equal(generator.generateQuestions({ ruleId: 'g1_add_20', count: 1.5 }).ok, false);
});

test('请求层拒绝年级与题型不匹配、兼容字段被改', function () {
  const rule = rulesTable.getRule('g2_multiply_table');
  const bad = [
    Object.assign(configFor(rule), { grade: 3 }),
    Object.assign(configFor(rule), { ruleId: 'unknown' }),
    Object.assign(configFor(rule), { operation: 'add' }),
    Object.assign(configFor(rule), { limit: 20 }),
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
  const rule = rulesTable.getRule('g2_divide_table');
  const questions = gen(rule, 10).questions;
  const graded = scoring.gradeAnswers({
    questions: questions,
    answers: questions.map(function (q) { return q.answer; })
  });
  assert.equal(graded.ok, true, graded.message);
  assert.equal(graded.result.correct, 10);
  assert.equal(graded.result.accuracyPercent, 100);
});

test('全错：全部 wrong，正确率 0%', function () {
  const rule = rulesTable.getRule('g3_multiply_2by1');
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
});

test('前导零、空格、非法格式与 4 位答案', function () {
  const questions = [{ id: '1', operation: 'multiply', left: 500, right: 2, answer: 1000, text: '500 × 2 = ?' }];
  assert.equal(scoring.gradeAnswers({ questions: questions, answers: [' 1000 '] }).result.questions[0].verdict, 'correct');
  assert.equal(scoring.gradeAnswers({ questions: questions, answers: ['1000'] }).result.questions[0].verdict, 'correct');
  ['abc', '1.5', '-3', '1e3'].forEach(function (bad) {
    const graded = scoring.gradeAnswers({ questions: questions, answers: [bad] });
    assert.equal(graded.result.questions[0].verdict, 'wrong');
    assert.equal(graded.result.questions[0].reason, 'invalidFormat');
  });
  assert.equal(scoring.gradeAnswers({ questions: questions, answers: [''] }).result.blank, 1);
  assert.equal(scoring.gradeAnswers({ questions: questions, answers: [null] }).result.blank, 1);
});

test('小数答案等值：1 与 1.0、1.7 与 1.70 都算对；格式错误记 invalidFormat', function () {
  const question = {
    id: 'd1', operation: 'decimal_add_sub', answerKind: 'decimal', op: 'add',
    text: '1.2 + 0.5 = ?', leftTenths: 12, rightTenths: 5, answerTenths: 17, answer: 1.7
  };
  ['1.7', '1.70', ' 1.7 '].forEach(function (answer) {
    assert.equal(scoring.gradeAnswers({ questions: [question], answers: [answer] }).result.questions[0].verdict, 'correct', answer);
  });
  ['1.', '.5', '1.2.3', 'abc'].forEach(function (answer) {
    const graded = scoring.gradeAnswers({ questions: [question], answers: [answer] }).result.questions[0];
    assert.equal(graded.verdict, 'wrong');
    assert.equal(graded.reason, 'invalidFormat', answer);
  });
  const whole = {
    id: 'd2', operation: 'decimal_add_sub', answerKind: 'decimal', op: 'add',
    text: '0.5 + 0.5 = ?', leftTenths: 5, rightTenths: 5, answerTenths: 10, answer: 1
  };
  ['1', '1.0', '1.00'].forEach(function (answer) {
    assert.equal(scoring.gradeAnswers({ questions: [whole], answers: [answer] }).result.questions[0].verdict, 'correct', answer);
  });
});

test('分数答案等值：2/4 与 1/2、0/1、1 都算对；分母为 0 非法', function () {
  const half = {
    id: 'f1', operation: 'fraction_add_sub', answerKind: 'fraction', op: 'add',
    text: '1/4 + 1/4 = ?', answerNumerator: 2, answerDenominator: 4, answer: '2/4'
  };
  ['2/4', '1/2', ' 1/2 ', '3/6'].forEach(function (answer) {
    assert.equal(scoring.gradeAnswers({ questions: [half], answers: [answer] }).result.questions[0].verdict, 'correct', answer);
  });
  assert.equal(scoring.gradeAnswers({ questions: [half], answers: ['1/3'] }).result.questions[0].verdict, 'wrong');
  assert.equal(scoring.gradeAnswers({ questions: [half], answers: ['1/0'] }).result.questions[0].reason, 'invalidFormat');
  assert.equal(scoring.gradeAnswers({ questions: [half], answers: ['2/4'] }).result.questions[0].correctText, '1/4 + 1/4 = 2/4');

  const zero = {
    id: 'f2', operation: 'fraction_add_sub', answerKind: 'fraction', op: 'subtract',
    text: '1/8 - 1/8 = ?', answerNumerator: 0, answerDenominator: 8, answer: '0/8'
  };
  ['0/1', '0/8', '0'].forEach(function (answer) {
    assert.equal(scoring.gradeAnswers({ questions: [zero], answers: [answer] }).result.questions[0].verdict, 'correct', answer);
  });

  const one = {
    id: 'f3', operation: 'fraction_add_sub', answerKind: 'fraction', op: 'add',
    text: '4/8 + 4/8 = ?', answerNumerator: 8, answerDenominator: 8, answer: '8/8'
  };
  ['1', '1/1', '8/8'].forEach(function (answer) {
    assert.equal(scoring.gradeAnswers({ questions: [one], answers: [answer] }).result.questions[0].verdict, 'correct', answer);
  });
});

test('混合运算题干与正确答案回显', function () {
  const question = {
    id: 'm1', operation: 'mixed', answerKind: 'integer',
    tokens: [18, 'add', 6, 'multiply', 3], text: '18 + 6 × 3 = ?', answer: 36
  };
  const graded = scoring.gradeAnswers({ questions: [question], answers: ['36'] }).result.questions[0];
  assert.equal(graded.verdict, 'correct');
  assert.equal(graded.correctText, '18 + 6 × 3 = 36');
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
  const rule = rulesTable.getRule('g2_divide_table');
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
  });
});

test('13 个预设都能通过请求层出题，且题目不含答案', function () {
  rulesTable.RULES.forEach(function (rule) {
    const response = core.handleRequest({
      action: 'createQuestionSet',
      payload: { config: configFor(rule, { count: 10 }), sessionId: 'all-' + rule.id }
    });
    assert.equal(response.ok, true, rule.id + ': ' + response.message);
    assert.equal(response.data.questions.length, 10);
    response.data.questions.forEach(function (q) {
      assert.equal(q.answer, undefined, rule.id + ' 下发了答案');
    });
  });
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
});

test('createQuestionSet -> submitAnswers 走通（乘法），结果带 ruleId、grade 和设置', function () {
  const rule = rulesTable.getRule('g2_multiply_table');
  const config = configFor(rule, { count: 10, mode: 'timed', durationSeconds: 60 });
  const created = core.handleRequest({
    action: 'createQuestionSet',
    payload: { config: config, sessionId: 'req-2' }
  });
  assert.equal(created.ok, true, created.message);

  const questions = gen(rule, 10, created.data.quizId).questions;
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
  assert.equal(r.correct, 8);
  assert.equal(r.durationSeconds, 42);
  assert.equal(r.finishedBy, 'timeup');
});

test('submitAnswers 拒绝被篡改的题目和数量不一致', function () {
  const tampered = core.handleRequest({
    action: 'submitAnswers',
    payload: {
      questions: [{ id: 'x', operation: 'multiply', left: 7, right: 8, answer: 99, text: '7 × 8 = ?' }],
      answers: [99]
    }
  });
  assert.equal(tampered.code, 'INVALID_QUESTIONS');
  const mismatch = core.handleRequest({
    action: 'submitAnswers',
    payload: {
      questions: [{ id: 'y', operation: 'divide', left: 56, right: 7, answer: 8, text: '56 ÷ 7 = ?' }],
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
  const rule = rulesTable.getRule('g2_divide_table');
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

test('本地服务：未知 ruleId 返回 INVALID_CONFIG', async function () {
  const service = require(path.join(MINIAPP, 'services', 'question-service.js'));
  const response = await service.createQuestionSet({
    grade: 1, ruleId: 'unknown', count: 10, mode: 'normal', durationSeconds: 120
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'INVALID_CONFIG');
});

// ---------------------------------------------------------------- 副本一致性

test('云函数副本与小程序端逐字节一致（5 个文件）', function () {
  const pairs = [
    ['utils/question/generator.js', 'cloudfunctions/createQuestionSet/lib/generator.js'],
    ['utils/question/scoring.js', 'cloudfunctions/createQuestionSet/lib/scoring.js'],
    ['utils/question/session-core.js', 'cloudfunctions/createQuestionSet/lib/session-core.js'],
    ['utils/question/rule-strategies.js', 'cloudfunctions/createQuestionSet/lib/rule-strategies.js'],
    ['utils/practice-rules.js', 'cloudfunctions/createQuestionSet/practice-rules.js']
  ];
  pairs.forEach(function (pair) {
    const a = fs.readFileSync(path.join(MINIAPP, pair[0]), 'utf8').replace(/\r\n/g, '\n');
    const b = fs.readFileSync(path.join(MINIAPP, pair[1]), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(b, a, pair[1] + ' 与 ' + pair[0] + ' 不一致，请按 lib/README.md 同步');
  });
});
