const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuestions, publicQuestion } = require('../miniapp/cloudfunctions/roomService/question-set');
const { generateQuestions } = require('../miniapp/cloudfunctions/roomService/question-generator');
const { STRATEGIES } = require('../miniapp/cloudfunctions/roomService/question-strategies');
const contract = require('../miniapp/cloudfunctions/roomService/rules.generated.json');

// 独立计算两步算式：先归并乘除项，再累加带符号的加减项，不调用生成器求值函数。
function mixedValue(tokens) {
  const terms = [tokens[0]], signs = [1];
  for (let i = 1; i < tokens.length; i += 2) {
    const operation = tokens[i], value = tokens[i + 1];
    if (operation === 'multiply') terms[terms.length - 1] *= value;
    else if (operation === 'divide') { assert.notEqual(value, 0); terms[terms.length - 1] /= value; }
    else { terms.push(value); signs.push(operation === 'subtract' ? -1 : 1); }
  }
  return terms.reduce((total, term, index) => total + term * signs[index], 0);
}
function canonicalKey(q) {
  if (q.operation === 'add' || q.operation === 'multiply') return [q.left, q.right].sort((a, b) => a - b).join(':');
  if (q.answerKind === 'decimal' && q.op === 'add') return 'add:' + [q.leftTenths, q.rightTenths].sort((a, b) => a - b).join(':');
  if (q.answerKind === 'fraction' && q.op === 'add') return q.denominator + ':add:' + [q.leftNumerator, q.rightNumerator].sort((a, b) => a - b).join(':');
  return q.formula;
}

test('room generator covers exactly the current thirteen rule IDs', () => {
  assert.deepEqual(Object.keys(STRATEGIES).sort(), contract.rules.map(r => r.id).sort());
});
for (const rule of contract.rules) {
  test(rule.id + ': independently check 1000 answers, range and commutative deduplication', () => {
    const count = rule.id === 'g2_multiply_table' ? 40 : 50;
    for (let batch = 0; batch < 1000 / count; batch++) {
      const set = createQuestions({ ruleId: rule.id, count }, 'a_' + '1'.repeat(40), 'server-secret-' + batch);
      assert.equal(set.ruleVersion, contract.ruleVersion); assert.equal(set.questions.length, count);
      const keys = new Set();
      for (const q of set.questions) {
        const key = canonicalKey(q); assert.equal(keys.has(key), false, q.formula); keys.add(key);
        if (q.answerKind === 'fraction') {
          assert.ok(q.denominator >= 2 && q.denominator <= 9);
          assert.ok(q.leftNumerator > 0 && q.leftNumerator < q.denominator);
          assert.ok(q.rightNumerator > 0 && q.rightNumerator < q.denominator);
          const n = q.op === 'subtract' ? q.leftNumerator - q.rightNumerator : q.leftNumerator + q.rightNumerator;
          assert.ok(n >= 0 && n <= q.denominator); assert.equal(q.answerNumerator, n);
          assert.equal(q.answer, n + '/' + q.denominator); assert.equal(q.answerDenominator, q.denominator);
        } else if (q.answerKind === 'decimal') {
          assert.ok(q.leftTenths >= 0 && q.leftTenths <= 100 && Number.isInteger(q.leftTenths));
          assert.ok(q.rightTenths >= 0 && q.rightTenths <= 100 && Number.isInteger(q.rightTenths));
          const n = q.op === 'subtract' ? q.leftTenths - q.rightTenths : q.leftTenths + q.rightTenths;
          assert.ok(n >= 0 && n <= 100); assert.equal(q.answerTenths, n); assert.equal(q.answer, n / 10);
        } else if (q.tokens) {
          assert.equal(q.tokens.length, 5); assert.ok([q.tokens[0], q.tokens[2], q.tokens[4]].every(n => Number.isInteger(n) && n >= 0 && n <= 100));
          assert.equal(q.answer, mixedValue(q.tokens)); assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 100);
        } else {
          const value = { add: () => q.left + q.right, subtract: () => q.left - q.right,
            multiply: () => q.left * q.right, divide: () => q.left / q.right }[q.operation]();
          assert.equal(q.answer, value); assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= rule.limit);
          if (['add','subtract'].includes(q.operation)) assert.ok(q.left >= 0 && q.right >= 0 && q.left <= rule.limit && q.right <= rule.limit);
          if (rule.id === 'g2_multiply_table') assert.ok(q.left >= 1 && q.left <= 9 && q.right >= 1 && q.right <= 9);
          if (rule.id === 'g2_divide_table') assert.ok(q.right >= 1 && q.right <= 9 && q.answer >= 1 && q.answer <= 9);
          if (rule.id === 'g3_multiply_2by1' || rule.id === 'g3_divide_2by1') assert.ok(q.left >= 10 && q.left <= 99 && q.right >= 1 && q.right <= 9);
        }
      }
    }
  });
}
test('server seed determines a stable set for transaction replay, without exposing seed or future private fields', () => {
  const cfg = { ruleId: 'g1_add_20', count: 30 };
  const a = createQuestions(cfg, 'batch', 'server-a'), again = createQuestions(cfg, 'batch', 'server-a');
  assert.deepEqual(a, again); assert.notDeepEqual(a.questions, createQuestions(cfg, 'batch', 'server-b').questions);
  const publicItem = publicQuestion({ ...a.questions[0], futureSecret: 'never return' });
  assert.deepEqual(Object.keys(publicItem).sort(), ['answerKind','id','index','ruleId','text']);
  assert.equal(new Set(a.questions.map(q => q.id)).size, 30);
});
test('limited multiplication pool never fabricates additional questions', () => {
  assert.equal(generateQuestions({ ruleId: 'g2_multiply_table', count: 45, sessionId: 'capacity' }).ok, true);
  assert.equal(generateQuestions({ ruleId: 'g2_multiply_table', count: 46, sessionId: 'capacity' }).code, 'POOL_EXHAUSTED');
});
