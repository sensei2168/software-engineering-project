/**
 * 出题 / 收卷的「一次请求」处理层。
 *
 * 小程序端和云函数端都调用 handleRequest，保证两边的校验规则、返回结构完全一致：
 * 本地兜底跑出来的结果，和云函数上线后跑出来的结果可以直接对比。
 *
 * 已开放 10 个整数预设：20/100/1000 以内加减法、表内乘除、两位数×一位数、
 * 两位数÷一位数。混合运算、小数、分数明确返回 UNSUPPORTED_RULE，
 * 不会静默降级成别的题型。
 */
const { RULE_VERSION, getRule, getGradeLabel, selectedRuleIds } = require('../practice-rules');
const { getStrategy } = require('./rule-strategies');
const { generateQuestions, validateQuestionSpec, toPublicQuestion } = require('./generator');
const { gradeAnswers } = require('./scoring');

const MAX_COUNT = 50;
const MIN_COUNT = 10;
const MAX_TEXT = 200;
const VALID_MODES = ['normal', 'timed'];
const VALID_DURATIONS = [60, 120, 180];

function fail(code, message, details) {
  return { ok: false, code: code, message: message, details: details || null };
}

function pickString(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  if (text.length === 0 || text.length > MAX_TEXT) return fallback;
  return text;
}

/**
 * 校验并规范化设置。规则表是唯一依据，不靠 grade 或 limit 猜题型。
 * @returns {{ok: true, value: object} | {ok: false, code: string, message: string}}
 */
function sanitizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const grade = Number(config.grade);
  const rule = getRule(config.ruleId);
  if (!rule) {
    return { ok: false, code: 'INVALID_CONFIG', message: '请选择有效的练习题型' };
  }
  const ids = selectedRuleIds({ ...config, grade });
  if (!ids) {
    return { ok: false, code: 'INVALID_CONFIG', message: '年级与题型不匹配，请返回设置页重新选择' };
  }
  if (config.operation !== undefined && String(config.operation) !== rule.operation) {
    return { ok: false, code: 'INVALID_CONFIG', message: '题型与练习规则不一致，请返回设置页重新选择' };
  }
  if (config.limit !== undefined && Number(config.limit) !== rule.limit) {
    return { ok: false, code: 'INVALID_CONFIG', message: '题目范围与练习规则不一致，请返回设置页重新选择' };
  }
  const count = Number(config.count);
  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    return { ok: false, code: 'INVALID_CONFIG', message: '题量请输入 ' + MIN_COUNT + ' 到 ' + MAX_COUNT + ' 之间的整数' };
  }
  const mode = String(config.mode);
  if (VALID_MODES.indexOf(mode) === -1) {
    return { ok: false, code: 'INVALID_CONFIG', message: '请选择普通练习或限时练习' };
  }
  const durationSeconds = Number(config.durationSeconds);
  if (VALID_DURATIONS.indexOf(durationSeconds) === -1) {
    return { ok: false, code: 'INVALID_CONFIG', message: '请选择 60、120 或 180 秒' };
  }
  return {
    ok: true,
    value: {
      grade: rule.grade,
      ruleId: rule.id,
      ...(ids.length > 1 ? { ruleIds: ids } : {}),
      operation: rule.operation,
      limit: rule.limit,
      count: count,
      mode: mode,
      durationSeconds: durationSeconds
    }
  };
}

/**
 * createQuestionSet：按设置出题，返回给客户端的题目里没有答案。
 *
 * 入参 payload：{ config: {grade, ruleId, operation, limit, count, mode, durationSeconds}, sessionId?, seed? }
 * 入参 options：{ includePrivate: true } 时额外返回 privateQuestions（含答案）。
 *   只有小程序端的本地兜底会用到：把题目留在内存里，收卷时再取出来判分。
 *   云函数永远不传这个选项。
 * 出参：{ ok: true, data: { quizId, config, ruleVersion, engineVersion, questions: [...] } }
 */
function createQuestionSet(payload, options) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const sanitized = sanitizeConfig(source.config);
  if (!sanitized.ok) return fail(sanitized.code, sanitized.message);
  const config = sanitized.value;
  const rule = getRule(config.ruleId);
  const strategy = getStrategy(rule.id);

  if (!strategy) {
    return fail(
      'UNSUPPORTED_RULE',
      '「' + getGradeLabel(rule.grade) + ' · ' + rule.label + '」尚未开放，请先选择整数四则运算。'
    );
  }

  const sessionId = pickString(source.sessionId, '') ||
    'q' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const seed = pickString(source.seed, '');

  const ids = config.ruleIds || [config.ruleId];
  const groups = [];
  for (const [i, ruleId] of ids.entries()) {
    const count = Math.floor(config.count / ids.length) + Number(i < config.count % ids.length);
    const set = generateQuestions({ ruleId, count, sessionId, seed });
    if (!set.ok) return fail(set.code, set.message);
    groups.push(set);
  }
  const generated = groups[0];
  const questions = [];
  for (let row = 0; questions.length < config.count; row++) {
    for (const group of groups) {
      const q = group.questions[row];
      if (q) {
        const index = questions.length + 1;
        questions.push({ ...q, id: generated.sessionId + '-' + index, index });
      }
    }
  }

  const data = {
    quizId: generated.sessionId,
    config: config,
    // 规则版本统一取题型目录的 RULE_VERSION；生成时固定，收卷时由页面原样带回
    ruleVersion: RULE_VERSION,
    engineVersion: generated.engineVersion,
    questions: questions.map(toPublicQuestion)
  };
  if (options && options.includePrivate) {
    data.privateQuestions = questions;
  }

  return { ok: true, data: data };
}

/**
 * submitAnswers：收卷并批改。
 *
 * 入参 payload：
 *   { quizId, config, questions: [{id, ruleId, operation, left, right, answer}], answers: [...], durationSeconds, finishedBy }
 * 出参：{ ok: true, data: { result } }
 *
 * 说明：题目由出题接口下发时是脱敏的，收卷时把题目（含答案）再带回来。
 * 当前没有服务端题库，所以正确答案由客户端回传；这一层能保证「判分逻辑只在云端跑一遍」，
 * 但要做到防篡改，还要把题目写进云数据库，再用 quizId 反查答案（下一阶段做）。
 */
function submitAnswers(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const questions = Array.isArray(source.questions) ? source.questions : [];
  const answers = Array.isArray(source.answers) ? source.answers : [];

  if (questions.length === 0) return fail('INVALID_QUESTIONS', '没有收到题目，无法批改');
  if (questions.length > MAX_COUNT) return fail('INVALID_QUESTIONS', '题目数量超过上限 ' + MAX_COUNT);
  if (answers.length !== questions.length) {
    return fail('ANSWER_COUNT_MISMATCH', '作答数量与题目数量不一致');
  }
  for (let i = 0; i < questions.length; i += 1) {
    if (!validateQuestionSpec(questions[i])) {
      return fail('INVALID_QUESTIONS', '第 ' + (i + 1) + ' 题的数据不完整或前后不一致');
    }
  }
  const ids = {};
  for (let i = 0; i < questions.length; i += 1) {
    const id = String(questions[i].id === undefined ? '' : questions[i].id);
    if (id !== '' && ids[id]) return fail('INVALID_QUESTIONS', '题目编号重复：' + id);
    ids[id] = true;
  }

  let config = null;
  if (source.config) {
    const sanitized = sanitizeConfig(source.config);
    if (!sanitized.ok) return fail(sanitized.code, sanitized.message);
    config = sanitized.value;
  }

  const graded = gradeAnswers({
    questions: questions,
    answers: answers,
    quizId: pickString(source.quizId, ''),
    ruleId: config ? config.ruleId : '',
    ruleVersion: pickString(source.ruleVersion, '') || RULE_VERSION,
    grade: config ? config.grade : undefined,
    operation: config ? config.operation : undefined,
    config: config,
    durationSeconds: source.durationSeconds,
    finishedBy: source.finishedBy
  });
  if (!graded.ok) return fail(graded.code, graded.message);

  return { ok: true, data: { result: graded.result } };
}

/**
 * 统一入口：云函数 event 和小程序本地兜底都走这里。
 * @param {{action: string, payload: object}} request
 */
function handleRequest(request) {
  const source = request && typeof request === 'object' ? request : {};
  const action = pickString(source.action, '');
  if (action === 'createQuestionSet') return createQuestionSet(source.payload);
  if (action === 'submitAnswers') return submitAnswers(source.payload);
  return fail('UNKNOWN_ACTION', '未知操作：' + (action || '(空)'));
}

module.exports = {
  MAX_COUNT,
  MIN_COUNT,
  RULE_VERSION,
  sanitizeConfig,
  createQuestionSet,
  submitAnswers,
  handleRequest
};
