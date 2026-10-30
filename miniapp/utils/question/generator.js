/**
 * 整数四则出题器（纯函数，不依赖 wx / 云开发，可在小程序端与云函数端复用）。
 *
 * P3 + P4 整数部分：按 ruleId 出题，策略表见 rule-strategies.js。
 * 已覆盖 10 个预设：20/100/1000 以内加减法、表内乘除、两位数×一位数、两位数÷一位数。
 * 混合运算、小数、分数仍未接入，由 session-core 拦截并返回 UNSUPPORTED_RULE。
 *
 * 规则：
 * 1. 加法：两个非负整数，和不超过 limit；
 * 2. 减法：两个数 0—limit，差不能为负数；
 * 3. 表内乘法：两个乘数 1—9，交换乘数算重复（45 种）；
 * 4. 表内除法：除数、商 1—9，被除数 = 除数 × 商；
 * 5. 两位数乘一位数、两位数除一位数（整除）；
 * 6. 同一次练习不重复；每题有唯一题号、算式、正确答案和 ruleId。
 *
 * 生成是确定性的：同样的 (ruleId, sessionId, count) 得到同一套题。
 */
const { getStrategy } = require('./rule-strategies');

const ENGINE_VERSION = '1.2.0';
const MAX_COUNT = 50;
const OPERATIONS = ['add', 'subtract', 'multiply', 'divide'];

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

/** 加法 / 减法的算式总数：加法与减法数量相同，都是 (limit+1)(limit+2)/2。 */
function addSubtractPoolSize(strategy) {
  return ((strategy.limit + 1) * (strategy.limit + 2)) / 2;
}

/** 列出某题型下全部合法算式（只用于规模不大的题库）。 */
function buildPool(strategy) {
  const pairs = [];
  const operation = strategy.operation;
  if (operation === 'add') {
    for (let a = 0; a <= strategy.limit; a += 1) {
      for (let b = 0; b <= strategy.limit - a; b += 1) pairs.push({ a: a, b: b });
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
        // 交换乘数算重复：只保留 a <= b 的一种
        if (strategy.commutative && a > b) continue;
        pairs.push({ a: a, b: b });
      }
    }
    return pairs;
  }
  if (operation === 'divide') {
    for (let divisor = strategy.divisorMin; divisor <= strategy.divisorMax; divisor += 1) {
      if (strategy.quotientMin !== undefined) {
        // 表内除法：被除数 = 除数 × 商，商 1—9
        for (let quotient = strategy.quotientMin; quotient <= strategy.quotientMax; quotient += 1) {
          pairs.push({ a: divisor * quotient, b: divisor });
        }
      } else {
        // 两位数 ÷ 一位数：被除数在范围内且能整除
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

function pairKey(a, b) {
  return a + ':' + b;
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
    const key = pairKey(a, b);
    if (seen[key]) continue;
    seen[key] = true;
    picked.push({ a: a, b: b });
  }
  return picked;
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

/** 结果页回显用：拼出带正确答案的式子，例如 "12 − 5 = 7"。 */
function buildEquation(question, answer) {
  const operation = canonicalOperation(question && question.operation) || 'add';
  const left = Number(question && question.left);
  const right = Number(question && question.right);
  if (!Number.isInteger(left) || !Number.isInteger(right)) {
    return question && question.formula ? String(question.formula) : '';
  }
  return left + ' ' + OP_CHAR[operation] + ' ' + right + ' = ' + String(answer);
}

function answerOf(operation, a, b) {
  if (operation === 'subtract') return a - b;
  if (operation === 'multiply') return a * b;
  if (operation === 'divide') return a / b;
  return a + b;
}

function makeSeed(ruleId, sessionId) {
  return hashSeed([ENGINE_VERSION, ruleId, sessionId].join('|'));
}

function buildQuestion(ruleId, operation, sessionId, index, pair) {
  return {
    id: sessionId + '-' + (index + 1),
    index: index + 1,
    ruleId: ruleId,
    operation: operation,
    formula: String(pair.a) + OP_CHAR[operation] + String(pair.b),
    text: expressionText(operation, pair.a, pair.b, { withAnswer: false }),
    left: pair.a,
    right: pair.b,
    answer: answerOf(operation, pair.a, pair.b)
  };
}

/**
 * 生成一套题目。
 *
 * @param {object} input
 * @param {string} input.ruleId 题型编号，例如 g2_multiply_table
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

  const smallAddSubtract = (strategy.operation === 'add' || strategy.operation === 'subtract') &&
    addSubtractPoolSize(strategy) > SHUFFLE_LIMIT;
  let pool = null;
  if (!smallAddSubtract) {
    pool = buildPool(strategy);
    if (count > pool.length) {
      return {
        ok: false,
        code: 'POOL_EXHAUSTED',
        message: '该范围内只有 ' + pool.length + ' 种算式，请把题量调小'
      };
    }
  } else if (count > addSubtractPoolSize(strategy)) {
    return { ok: false, code: 'POOL_EXHAUSTED', message: '该范围内算式不足，请把题量调小' };
  }

  const seedText = normalizeSeed(source.seed);
  const sessionId = normalizeSeed(source.sessionId) ||
    'local-' + hashSeed([ruleId, count, seedText || 'seed'].join('|')).toString(36);
  const finalSessionId = seedText ? sessionId + '-' + hashSeed(seedText).toString(36) : sessionId;

  const random = createRandom(makeSeed(ruleId, finalSessionId));
  let pairs;
  if (smallAddSubtract) {
    pairs = sampleAddSubtract(strategy, count, random);
  } else {
    pairs = shuffle(pool, random).slice(0, count);
  }
  if (pairs.length < count) {
    return { ok: false, code: 'GENERATION_FAILED', message: '出题失败，请重试' };
  }

  const questions = pairs.map(function (pair, index) {
    return buildQuestion(ruleId, strategy.operation, finalSessionId, index, pair);
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

/** 供云函数使用的「脱敏」题目：去掉 answer。 */
function toPublicQuestion(question) {
  return {
    id: question.id,
    index: question.index,
    ruleId: question.ruleId,
    text: question.text,
    formula: question.formula,
    operation: question.operation,
    left: question.left,
    right: question.right
  };
}

module.exports = {
  ENGINE_VERSION,
  MAX_COUNT,
  OPERATIONS,
  SHUFFLE_LIMIT,
  hashSeed,
  createRandom,
  canonicalOperation,
  expressionText,
  buildEquation,
  addSubtractPoolSize,
  buildPool,
  generateQuestions,
  validateQuestionSpec,
  toPublicQuestion
};
