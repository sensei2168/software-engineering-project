/**
 * 整数四则、混合运算、小数与分数出题器（纯函数，不依赖 wx / 云开发）。
 *
 * 全部 13 个预设都可出题，策略表见 rule-strategies.js：
 *   - 20/100/1000 以内加减法
 *   - 表内乘除、两位数乘/除以一位数
 *   - 整数两步混合（按优先级计算，绝不使用字符串 eval）
 *   - 一位小数加减（内部用十分之一整数，避免浮点误差）
 *   - 同分母分数加减（内部用分子/分母整数对，接受等值答案）
 *
 * 生成是确定性的：同样的 (ruleId, sessionId, count) 得到同一套题。
 */
const { getStrategy } = require('./question-strategies');

const ENGINE_VERSION = '1.3.0-room.1';
const MAX_COUNT = 50;
// 题库不超过这个值时全量洗牌取子集；更大时改用拒绝采样
const SHUFFLE_LIMIT = 20000;

const OP_CHAR = { add: '+', subtract: '-', multiply: '×', divide: '÷' };

/** 32 位 FNV-1a，把字符串变成稳定的非负整数种子。 */
function hashSeed(input) {
  const text = String(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 线性同余发生器：给定种子后输出固定的伪随机序列。 */
function createRandom(seed) {
  let state = (seed >>> 0) || 0x1a2b3c4d;
  const next = function () {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  // 预热：LCG 的低位质量差，且种子可能很小，先丢弃两轮再使用
  next();
  next();
  return next;
}

/** Fisher-Yates，用同一个随机源保证结果可复现。 */
function shuffle(list, random) {
  const result = list.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

function canonicalOperation(input) {
  const text = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
  if (text === 'add' || text === 'addition' || text === '+' || text === '加' || text === '加法') return 'add';
  if (text === 'subtract' || text === 'sub' || text === '-' || text === '减' || text === '减法') return 'subtract';
  if (text === 'multiply' || text === 'mul' || text === '*' || text === '×' || text === '乘' || text === '乘法') return 'multiply';
  if (text === 'divide' || text === 'div' || text === '/' || text === '÷' || text === '除' || text === '除法') return 'divide';
  if (text === 'mixed' || text === '混合' || text === '混合运算') return 'mixed';
  if (text === 'decimal_add_sub' || text === 'decimal' || text === '小数' || text === '小数加减') return 'decimal_add_sub';
  if (text === 'fraction_add_sub' || text === 'fraction' || text === '分数' || text === '分数加减') return 'fraction_add_sub';
  return '';
}

function normalizeCount(input) {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1) return 0;
  return value;
}

function normalizeSeed(input) {
  if (input === undefined || input === null || input === '') return null;
  return String(input).slice(0, 200);
}

function addSubtractPoolSize(strategy) {
  if (strategy.operation === 'add') {
    const half = Math.floor(strategy.limit / 2);
    return (half + 1) * (strategy.limit + 1 - half);
  }
  return ((strategy.limit + 1) * (strategy.limit + 2)) / 2;
}

function pairKey(a, b) {
  return a + ':' + b;
}

function isMulDiv(operation) {
  return operation === 'multiply' || operation === 'divide';
}

/** 单步计算：结果必须是非负整数且不超过 100；除法必须整除。 */
function applyStep(a, operation, b) {
  let result;
  if (operation === 'add') result = a + b;
  else if (operation === 'subtract') result = a - b;
  else if (operation === 'multiply') result = a * b;
  else if (operation === 'divide') {
    if (b === 0 || a % b !== 0) return null;
    result = a / b;
  } else return null;
  if (!Number.isInteger(result) || result < 0 || result > 100) return null;
  return result;
}

/**
 * 计算两步表达式 [n1, op1, n2, op2, n3]。
 * 先乘除后加减；同级从左到右；任一步不合法返回 null。
 */
function evaluateMixed(tokens) {
  if (!Array.isArray(tokens) || tokens.length !== 5) return null;
  const n1 = Number(tokens[0]);
  const op1 = tokens[1];
  const n2 = Number(tokens[2]);
  const op2 = tokens[3];
  const n3 = Number(tokens[4]);
  if (![n1, n2, n3].every(function (v) { return Number.isInteger(v) && v >= 0 && v <= 100; })) return null;
  if (!OP_CHAR[op1] || !OP_CHAR[op2]) return null;
  const p1 = isMulDiv(op1) ? 2 : 1;
  const p2 = isMulDiv(op2) ? 2 : 1;
  if (p1 >= p2) {
    const left = applyStep(n1, op1, n2);
    if (left === null) return null;
    return applyStep(left, op2, n3);
  }
  const right = applyStep(n2, op2, n3);
  if (right === null) return null;
  return applyStep(n1, op1, right);
}

/** 混合运算题库由抽样产生：合法组合太多，不建全集。 */
function buildMixedSpec(strategy, random) {
  const max = strategy.valueMax;
  const n1 = Math.floor(random() * (max + 1));
  const n2 = Math.floor(random() * (max + 1));
  const n3 = Math.floor(random() * (max + 1));
  const ops = ['add', 'subtract', 'multiply', 'divide'];
  const op1 = ops[Math.floor(random() * ops.length)];
  const op2 = ops[Math.floor(random() * ops.length)];
  // 至少含一个乘除，避免变成纯加减的两步题
  if (!isMulDiv(op1) && !isMulDiv(op2)) return null;
  const tokens = [n1, op1, n2, op2, n3];
  const answer = evaluateMixed(tokens);
  if (answer === null) return null;
  return {
    tokens: tokens,
    answer: answer,
    formula: n1 + OP_CHAR[op1] + n2 + OP_CHAR[op2] + n3
  };
}

function buildDecimalSpecs(strategy) {
  const max = strategy.tenthsMax;
  const adds = [];
  const subs = [];
  for (let a = strategy.tenthsMin; a <= max; a += 1) {
    for (let b = a; a + b <= max; b += 1) adds.push({ op: 'add', aTenths: a, bTenths: b });
  }
  for (let a = strategy.tenthsMin; a <= max; a += 1) {
    for (let b = strategy.tenthsMin; b <= a; b += 1) subs.push({ op: 'subtract', aTenths: a, bTenths: b });
  }
  return { adds: adds, subs: subs };
}

function buildFractionSpecs(strategy) {
  const adds = [];
  const subs = [];
  for (let d = strategy.denominatorMin; d <= strategy.denominatorMax; d += 1) {
    for (let n1 = 1; n1 < d; n1 += 1) {
      for (let n2 = n1; n1 + n2 <= d; n2 += 1) adds.push({ op: 'add', n1: n1, n2: n2, n3: d });
      for (let n2 = 1; n2 <= n1; n2 += 1) subs.push({ op: 'subtract', n1: n1, n2: n2, n3: d });
    }
  }
  return { adds: adds, subs: subs };
}

/** 整数题库（加减乘除）。 */
function buildIntegerPool(strategy) {
  const pairs = [];
  const operation = strategy.operation;
  if (operation === 'add') {
    for (let a = 0; a <= strategy.limit; a += 1) {
      for (let b = a; b <= strategy.limit - a; b += 1) pairs.push({ a: a, b: b });
    }
    return pairs;
  }
  if (operation === 'subtract') {
    for (let a = 0; a <= strategy.limit; a += 1) {
      for (let b = 0; b <= a; b += 1) pairs.push({ a: a, b: b });
    }
    return pairs;
  }
  if (operation === 'multiply') {
    for (let a = strategy.aMin; a <= strategy.aMax; a += 1) {
      for (let b = strategy.bMin; b <= strategy.bMax; b += 1) {
        if (strategy.commutative && a > b) continue;
        pairs.push({ a: a, b: b });
      }
    }
    return pairs;
  }
  if (operation === 'divide') {
    for (let divisor = strategy.divisorMin; divisor <= strategy.divisorMax; divisor += 1) {
      if (strategy.quotientMin !== undefined) {
        for (let quotient = strategy.quotientMin; quotient <= strategy.quotientMax; quotient += 1) {
          pairs.push({ a: divisor * quotient, b: divisor });
        }
      } else {
        for (let dividend = strategy.dividendMin; dividend <= strategy.dividendMax; dividend += 1) {
          if (dividend % divisor !== 0) continue;
          pairs.push({ a: dividend, b: divisor });
        }
      }
    }
    return pairs;
  }
  return pairs;
}

function buildPool(strategy) {
  if (strategy.kind === 'decimal') return buildDecimalSpecs(strategy);
  if (strategy.kind === 'fraction') return buildFractionSpecs(strategy);
  if (strategy.kind === 'mixed') return null;
  return buildIntegerPool(strategy);
}

/** 大题库抽样：加法/减法在 1000 以内时使用，避免建 50 万个对象。 */
function sampleAddSubtract(strategy, count, random) {
  const operation = strategy.operation;
  const limit = strategy.limit;
  const seen = {};
  const picked = [];
  const guardMax = count * 2000 + 1000;
  let guard = 0;
  while (picked.length < count && guard < guardMax) {
    guard += 1;
    const a = Math.floor(random() * (limit + 1));
    const b = Math.floor(random() * (limit + 1));
    if (operation === 'add' ? a + b > limit : b > a) continue;
    const key = operation === 'add' ? pairKey(Math.min(a, b), Math.max(a, b)) : pairKey(a, b);
    if (seen[key]) continue;
    seen[key] = true;
    picked.push({ a: a, b: b });
  }
  return picked;
}

/** 小数/分数：一份练习里加、减尽量各半，奇数题量多一道加法。 */
function selectBalanced(specs, count, random) {
  const addCount = Math.ceil(count / 2);
  const subCount = count - addCount;
  if (addCount > specs.adds.length || subCount > specs.subs.length) return null;
  const pickedAdds = shuffle(specs.adds, random).slice(0, addCount);
  const pickedSubs = shuffle(specs.subs, random).slice(0, subCount);
  return shuffle(pickedAdds.concat(pickedSubs), random);
}

function formatTenths(tenths) {
  return (tenths / 10).toFixed(1);
}

/** 算式文本：题干用 "12 - 5 = ?"，答案回显用 "12 - 5 = 7"。 */
function expressionText(operation, a, b, options) {
  const withAnswer = Boolean(options && options.withAnswer);
  const left = operation === 'subtract' ? a - b
    : operation === 'multiply' ? a * b
      : operation === 'divide' ? a / b
        : a + b;
  const right = withAnswer ? String(left) : '?';
  return a + ' ' + OP_CHAR[operation] + ' ' + b + ' = ' + right;
}

/** 由题干直接拼出带答案的式子，兼容混合/小数/分数。 */
function buildEquation(question, answerText) {
  const text = String(question && question.text ? question.text : '');
  if (/=\s*\?$/.test(text)) return text.replace(/=\s*\?$/, '= ' + String(answerText));
  const operation = canonicalOperation(question && question.operation) || 'add';
  const left = Number(question && question.left);
  const right = Number(question && question.right);
  if (!Number.isInteger(left) || !Number.isInteger(right)) return text;
  return left + ' ' + OP_CHAR[operation] + ' ' + right + ' = ' + String(answerText);
}

function makeSeed(ruleId, sessionId) {
  return hashSeed([ENGINE_VERSION, ruleId, sessionId].join('|'));
}

function buildIntegerQuestion(ruleId, strategy, sessionId, index, spec) {
  const operation = strategy.operation;
  const answer = operation === 'subtract' ? spec.a - spec.b
    : operation === 'multiply' ? spec.a * spec.b
      : operation === 'divide' ? spec.a / spec.b
        : spec.a + spec.b;
  return {
    id: sessionId + '-' + (index + 1),
    index: index + 1,
    ruleId: ruleId,
    operation: operation,
    answerKind: 'integer',
    formula: String(spec.a) + OP_CHAR[operation] + String(spec.b),
    text: expressionText(operation, spec.a, spec.b, { withAnswer: false }),
    left: spec.a,
    right: spec.b,
    answer: answer
  };
}

function buildDecimalQuestion(ruleId, strategy, sessionId, index, spec) {
  const answerTenths = spec.op === 'add' ? spec.aTenths + spec.bTenths : spec.aTenths - spec.bTenths;
  return {
    id: sessionId + '-' + (index + 1),
    index: index + 1,
    ruleId: ruleId,
    operation: 'decimal_add_sub',
    answerKind: 'decimal',
    op: spec.op,
    formula: formatTenths(spec.aTenths) + (spec.op === 'add' ? '+' : '-') + formatTenths(spec.bTenths),
    text: formatTenths(spec.aTenths) + ' ' + (spec.op === 'add' ? '+' : '-') + ' ' + formatTenths(spec.bTenths) + ' = ?',
    leftTenths: spec.aTenths,
    rightTenths: spec.bTenths,
    answerTenths: answerTenths,
    left: spec.aTenths / 10,
    right: spec.bTenths / 10,
    answer: answerTenths / 10
  };
}

function buildFractionQuestion(ruleId, strategy, sessionId, index, spec) {
  const answerNumerator = spec.op === 'add' ? spec.n1 + spec.n2 : spec.n1 - spec.n2;
  const opChar = spec.op === 'add' ? '+' : '-';
  return {
    id: sessionId + '-' + (index + 1),
    index: index + 1,
    ruleId: ruleId,
    operation: 'fraction_add_sub',
    answerKind: 'fraction',
    op: spec.op,
    formula: spec.n1 + '/' + spec.n3 + (spec.op === 'add' ? '+' : '-') + spec.n2 + '/' + spec.n3,
    text: spec.n1 + '/' + spec.n3 + ' ' + opChar + ' ' + spec.n2 + '/' + spec.n3 + ' = ?',
    leftNumerator: spec.n1,
    rightNumerator: spec.n2,
    denominator: spec.n3,
    answerNumerator: answerNumerator,
    answerDenominator: spec.n3,
    answer: answerNumerator + '/' + spec.n3
  };
}

function buildMixedQuestion(ruleId, strategy, sessionId, index, spec) {
  const t = spec.tokens;
  return {
    id: sessionId + '-' + (index + 1),
    index: index + 1,
    ruleId: ruleId,
    operation: 'mixed',
    answerKind: 'integer',
    formula: spec.formula,
    text: t[0] + ' ' + OP_CHAR[t[1]] + ' ' + t[2] + ' ' + OP_CHAR[t[3]] + ' ' + t[4] + ' = ?',
    tokens: t.slice(),
    answer: spec.answer
  };
}

function buildQuestion(ruleId, strategy, sessionId, index, spec) {
  if (strategy.kind === 'decimal') return buildDecimalQuestion(ruleId, strategy, sessionId, index, spec);
  if (strategy.kind === 'fraction') return buildFractionQuestion(ruleId, strategy, sessionId, index, spec);
  if (strategy.kind === 'mixed') return buildMixedQuestion(ruleId, strategy, sessionId, index, spec);
  return buildIntegerQuestion(ruleId, strategy, sessionId, index, spec);
}

/**
 * 生成一套题目。
 *
 * @param {object} input
 * @param {string} input.ruleId 题型编号
 * @param {number} input.count 需要的题量（1—50）
 * @param {string} [input.sessionId] 练习会话号；不传时按配置自动生成
 * @param {string} [input.seed] 可选随机种子，会并入 sessionId
 * @returns {object} { ok: true, questions, seed, sessionId } 或 { ok: false, code, message }
 */
function generateQuestions(input) {
  const source = input || {};
  const ruleId = String(source.ruleId === undefined || source.ruleId === null ? '' : source.ruleId);
  const strategy = getStrategy(ruleId);
  if (!strategy) {
    return { ok: false, code: 'UNSUPPORTED_RULE', message: '该题型尚未开放' };
  }
  const count = normalizeCount(source.count);
  if (count === 0 || count > MAX_COUNT) {
    return { ok: false, code: 'INVALID_CONFIG', message: '题量必须是 1 到 ' + MAX_COUNT + ' 之间的整数' };
  }

  const seedText = normalizeSeed(source.seed);
  const sessionId = normalizeSeed(source.sessionId) ||
    'local-' + hashSeed([ruleId, count, seedText || 'seed'].join('|')).toString(36);
  const finalSessionId = seedText ? sessionId + '-' + hashSeed(seedText).toString(36) : sessionId;

  const random = createRandom(makeSeed(ruleId, finalSessionId));
  let specs = null;

  if (strategy.kind === 'mixed') {
    const seen = {};
    const picked = [];
    const guardMax = count * 20000 + 2000;
    let guard = 0;
    while (picked.length < count && guard < guardMax) {
      guard += 1;
      const spec = buildMixedSpec(strategy, random);
      if (!spec || seen[spec.formula]) continue;
      seen[spec.formula] = true;
      picked.push(spec);
    }
    if (picked.length < count) {
      return { ok: false, code: 'POOL_EXHAUSTED', message: '该范围内算式不足，请把题量调小' };
    }
    specs = picked;
  } else if (strategy.kind === 'decimal' || strategy.kind === 'fraction') {
    const pool = buildPool(strategy);
    const selected = selectBalanced(pool, count, random);
    if (!selected) {
      return { ok: false, code: 'POOL_EXHAUSTED', message: '该范围内算式不足，请把题量调小' };
    }
    specs = selected;
  } else {
    const largeAddSubtract = (strategy.kind === 'add' || strategy.kind === 'subtract') &&
      addSubtractPoolSize(strategy) > SHUFFLE_LIMIT;
    if (largeAddSubtract) {
      specs = sampleAddSubtract(strategy, count, random);
    } else {
      const pool = buildPool(strategy);
      if (count > pool.length) {
        return {
          ok: false,
          code: 'POOL_EXHAUSTED',
          message: '该范围内只有 ' + pool.length + ' 种算式，请把题量调小'
        };
      }
      specs = shuffle(pool, random).slice(0, count);
    }
    if (specs.length < count) {
      return { ok: false, code: 'POOL_EXHAUSTED', message: '该范围内算式不足，请把题量调小' };
    }
  }

  const questions = specs.map(function (spec, index) {
    return buildQuestion(ruleId, strategy, finalSessionId, index, spec);
  });

  return {
    ok: true,
    questions: questions,
    seed: makeSeed(ruleId, finalSessionId),
    sessionId: finalSessionId,
    engineVersion: ENGINE_VERSION
  };
}

/** 校验一组题目的结构，云端收卷时用。 */
function validateQuestionSpec(question) {
  if (!question || typeof question !== 'object') return false;
  const operation = canonicalOperation(question.operation);
  if (!operation) return false;
  const answerKind = question.answerKind || 'integer';

  if (answerKind === 'integer' && operation === 'mixed') {
    if (!Array.isArray(question.tokens)) return false;
    const value = evaluateMixed(question.tokens);
    return value !== null && value === Number(question.answer);
  }
  if (answerKind === 'decimal') {
    const a = Number(question.leftTenths);
    const b = Number(question.rightTenths);
    const ans = Number(question.answerTenths);
    if (![a, b, ans].every(Number.isInteger)) return false;
    if (a < 0 || a > 100 || b < 0 || b > 100) return false;
    const expected = question.op === 'subtract' ? a - b : a + b;
    if (expected < 0 || expected > 100) return false;
    return ans === expected && Number(question.answer) === ans / 10;
  }
  if (answerKind === 'fraction') {
    const d = Number(question.denominator);
    const n1 = Number(question.leftNumerator);
    const n2 = Number(question.rightNumerator);
    const an = Number(question.answerNumerator);
    if (![d, n1, n2, an].every(Number.isInteger)) return false;
    if (d < 2 || d > 9 || n1 < 1 || n1 >= d || n2 < 1 || n2 >= d) return false;
    const expected = question.op === 'subtract' ? n1 - n2 : n1 + n2;
    if (expected < 0 || expected > d) return false;
    return an === expected && String(question.answer) === an + '/' + d;
  }

  const left = Number(question.left);
  const right = Number(question.right);
  if (!Number.isInteger(left) || !Number.isInteger(right)) return false;
  if (left < 0 || right < 0) return false;
  const answer = Number(question.answer);
  if (!Number.isInteger(answer)) return false;
  if (operation === 'add') return answer === left + right;
  if (operation === 'subtract') return answer === left - right;
  if (operation === 'multiply') return answer === left * right;
  if (operation === 'divide') return right !== 0 && left % right === 0 && answer === left / right;
  return false;
}

/** 供云函数使用的「脱敏」题目：去掉答案类字段。 */
function toPublicQuestion(question) {
  const publicQuestion = {
    id: question.id,
    index: question.index,
    ruleId: question.ruleId,
    text: question.text,
    formula: question.formula,
    operation: question.operation,
    answerKind: question.answerKind || 'integer'
  };
  if (question.answerKind === 'fraction') {
    publicQuestion.leftNumerator = question.leftNumerator;
    publicQuestion.rightNumerator = question.rightNumerator;
    publicQuestion.denominator = question.denominator;
  }
  if (question.answerKind === 'decimal') {
    publicQuestion.left = question.left;
    publicQuestion.right = question.right;
  }
  if (question.answerKind === 'integer' && !question.tokens) {
    publicQuestion.left = question.left;
    publicQuestion.right = question.right;
  }
  return publicQuestion;
}

module.exports = {
  ENGINE_VERSION,
  MAX_COUNT,
  SHUFFLE_LIMIT,
  OP_CHAR,
  hashSeed,
  createRandom,
  canonicalOperation,
  expressionText,
  buildEquation,
  addSubtractPoolSize,
  evaluateMixed,
  buildPool,
  formatTenths,
  generateQuestions,
  validateQuestionSpec,
  toPublicQuestion
};
