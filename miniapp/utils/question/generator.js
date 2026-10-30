/**
 * 整数加减法出题器（纯函数，不依赖 wx / 云开发，可在小程序端与云函数端复用）。
 *
 * P3 范围：按 ruleId 出「整数加减法」，覆盖设置目录里的 6 个预设：
 *   g1_add_20 / g1_subtract_20（20 以内）
 *   g2_add_100 / g2_subtract_100（100 以内）
 *   g3_add_1000 / g3_subtract_1000（1000 以内）
 * 乘法、除法、混合运算、小数、分数由 P4 接入，调用前由 session-core 拦截。
 *
 * 规则：
 * 1. 加法：两个非负整数，和不超过 limit；
 * 2. 减法：两个数 0—limit，差不能为负数；
 * 3. 一次练习内同一个算式不重复；
 * 4. 每题有唯一题号、算式文本、正确答案和 ruleId。
 *
 * 生成是「确定性」的：同样的 (ruleId, sessionId, count) 永远得到同样的一套题。
 */
const ENGINE_VERSION = '1.1.0';
const MAX_COUNT = 50;
const MAX_LIMIT = 1000;
const OPERATIONS = ['add', 'subtract'];

// 题库规模不超过这个值时全量洗牌取子集（覆盖均匀）；更大时改用拒绝采样
const SHUFFLE_LIMIT = 20000;

const OP_CHAR = { add: '+', subtract: '-' };

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
  return '';
}

function normalizeCount(input) {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1) return 0;
  return value;
}

function normalizeLimit(input) {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 2 || value > MAX_LIMIT) return 0;
  return value;
}

function normalizeSeed(input) {
  if (input === undefined || input === null || input === '') return null;
  return String(input).slice(0, 200);
}

/** 该题型在给定上限下的算式总数：加法与减法数量相同，都是 (limit+1)(limit+2)/2。 */
function poolSize(limit) {
  return ((limit + 1) * (limit + 2)) / 2;
}

/**
 * 列出某题型下全部合法算式（仅用于规模不大的题库）。
 * 加法：a + b <= limit；减法：0 <= b <= a <= limit。
 */
function buildPairs(operation, limit) {
  const pairs = [];
  if (operation === 'add') {
    for (let a = 0; a <= limit; a += 1) {
      for (let b = 0; b <= limit - a; b += 1) pairs.push({ a: a, b: b });
    }
    return pairs;
  }
  for (let a = 0; a <= limit; a += 1) {
    for (let b = 0; b <= a; b += 1) pairs.push({ a: a, b: b });
  }
  return pairs;
}

function pairKey(a, b) {
  return a + ':' + b;
}

/** 算式文本：题干用 "12 - 5 = ?"，答案回显用 "12 - 5 = 7"。 */
function expressionText(operation, a, b, options) {
  const withAnswer = Boolean(options && options.withAnswer);
  const value = operation === 'subtract' ? a - b : a + b;
  const right = withAnswer ? String(value) : '?';
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

function makeSeed(ruleId, limit, sessionId) {
  return hashSeed([ENGINE_VERSION, ruleId || 'legacy', limit, sessionId].join('|'));
}

function buildQuestion(ruleId, operation, limit, index, pair) {
  const answer = operation === 'subtract' ? pair.a - pair.b : pair.a + pair.b;
  return {
    id: String(index + 1),
    index: index + 1,
    ruleId: ruleId || '',
    operation: operation,
    formula: String(pair.a) + OP_CHAR[operation] + String(pair.b),
    text: expressionText(operation, pair.a, pair.b, { withAnswer: false }),
    left: pair.a,
    right: pair.b,
    limit: limit,
    answer: answer
  };
}

/**
 * 从大题库里抽样（limit 很大时全量洗牌代价太高）。
 * 先均匀取 (a, b)，再用规则过滤，重复就用 Set 跳过。
 */
function samplePairs(operation, limit, count, random) {
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

/**
 * 生成一套题目。
 *
 * @param {object} input
 * @param {string} input.ruleId 题型编号，例如 g1_add_20；会写进每题
 * @param {string} input.operation 'add' | 'subtract'
 * @param {number} input.limit 数值上限，2—1000
 * @param {number} input.count 需要的题量（1—50）
 * @param {string} [input.sessionId] 练习会话号；不传时按配置自动生成
 * @param {string} [input.seed] 可选随机种子，会并入 sessionId
 * @returns {object} { ok: true, questions, seed, sessionId } 或 { ok: false, code, message }
 */
function generateQuestions(input) {
  const source = input || {};
  const operation = canonicalOperation(source.operation);
  if (!operation) {
    return { ok: false, code: 'INVALID_CONFIG', message: '请选择加法或减法' };
  }
  const limit = normalizeLimit(source.limit);
  if (!limit) {
    return { ok: false, code: 'INVALID_CONFIG', message: '题目范围必须是 2 到 1000 之间的整数' };
  }
  const count = normalizeCount(source.count);
  if (count === 0 || count > MAX_COUNT) {
    return { ok: false, code: 'INVALID_CONFIG', message: '题量必须是 1 到 ' + MAX_COUNT + ' 之间的整数' };
  }
  const total = poolSize(limit);
  if (count > total) {
    return {
      ok: false,
      code: 'POOL_EXHAUSTED',
      message: '该范围内只有 ' + total + ' 种算式，请把题量调小'
    };
  }

  const seedText = normalizeSeed(source.seed);
  const sessionId = normalizeSeed(source.sessionId) ||
    'local-' + hashSeed([source.ruleId || '', operation, limit, count, seedText || 'seed'].join('|')).toString(36);
  const finalSessionId = seedText ? sessionId + '-' + hashSeed(seedText).toString(36) : sessionId;

  const random = createRandom(makeSeed(source.ruleId, limit, finalSessionId));
  let pairs;
  if (total <= SHUFFLE_LIMIT) {
    pairs = shuffle(buildPairs(operation, limit), random).slice(0, count);
  } else {
    pairs = samplePairs(operation, limit, count, random);
  }
  if (pairs.length < count) {
    return { ok: false, code: 'GENERATION_FAILED', message: '出题失败，请重试' };
  }

  const questions = pairs.map(function (pair, index) {
    const question = buildQuestion(source.ruleId, operation, limit, index, pair);
    question.sessionId = finalSessionId;
    question.id = finalSessionId + '-' + (index + 1);
    return question;
  });

  return {
    ok: true,
    questions: questions,
    seed: makeSeed(source.ruleId, limit, finalSessionId),
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
  if (!Number.isInteger(Number(question.answer))) return false;
  const expected = operation === 'subtract' ? left - right : left + right;
  return Number(question.answer) === expected;
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
  MAX_LIMIT,
  OPERATIONS,
  SHUFFLE_LIMIT,
  hashSeed,
  createRandom,
  canonicalOperation,
  expressionText,
  buildEquation,
  poolSize,
  buildPairs,
  generateQuestions,
  validateQuestionSpec,
  toPublicQuestion
};
