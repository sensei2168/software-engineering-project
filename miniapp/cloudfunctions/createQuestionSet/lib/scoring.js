/**
 * 判分与结果汇总（纯函数，不依赖 wx / 云开发，可在小程序端与云函数端复用）。
 *
 * 判分规则：
 * 1. 未填写（空白）记为「未答」，不算答错；
 * 2. 数字 0 是有效答案；
 * 3. 整数题按整数比较；一位小数题按「十分之一整数」比较，1 与 1.0 等值；
 * 4. 分数题接受等值分数与 0／1，例如 2/4 与 1/2 都算对；
 * 5. 格式不合法（小数点不完整、分母为 0 等）记为答错，reason 为 invalidFormat；
 * 6. 每题结果只有 correct / wrong / blank 三种，数量之和必须等于总题数。
 */
const { canonicalOperation, buildEquation, formatTenths } = require('./generator');

const MAX_ANSWER = 1000;

function isBlankAnswer(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/** 整数归一化（保留给旧调用方）：' 07 ' -> 7；'' -> null；'abc' -> NaN。 */
function normalizeAnswer(value) {
  if (isBlankAnswer(value)) return null;
  const text = String(value).trim();
  if (!/^\d{1,4}$/.test(text)) return Number.NaN;
  const number = Number(text);
  return Number.isInteger(number) ? number : Number.NaN;
}

/**
 * 按题型解析用户输入。
 * @returns {{blank?: true, invalid?: boolean, text?: string, value?: number, tenths?: number, numerator?: number, denominator?: number}}
 */
function parseAnswer(question, raw) {
  if (isBlankAnswer(raw)) return { blank: true };
  const text = String(raw).trim();
  const kind = (question && question.answerKind) || 'integer';

  if (kind === 'decimal') {
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) return { invalid: true, text: text };
    const value = Number(text);
    return { value: value, tenths: Math.round(value * 10), text: text };
  }
  if (kind === 'fraction') {
    const match = /^(\d{1,3})\s*\/\s*(\d{1,3})$/.exec(text);
    if (match) {
      const numerator = Number(match[1]);
      const denominator = Number(match[2]);
      if (denominator === 0) return { invalid: true, text: text };
      return { numerator: numerator, denominator: denominator, text: text };
    }
    // 允许直接填 0 或 1
    if (/^\d{1,3}$/.test(text)) {
      return { numerator: Number(text), denominator: 1, text: text };
    }
    return { invalid: true, text: text };
  }
  if (!/^\d{1,4}$/.test(text)) return { invalid: true, text: text };
  return { value: Number(text), text: text };
}

function isAnswerCorrect(question, parsed) {
  const kind = (question && question.answerKind) || 'integer';
  if (kind === 'decimal') {
    return parsed.tenths === Number(question.answerTenths);
  }
  if (kind === 'fraction') {
    const expectedNumerator = Number(question.answerNumerator);
    const expectedDenominator = Number(question.answerDenominator);
    if (!Number.isInteger(expectedDenominator) || expectedDenominator === 0) return false;
    return parsed.numerator * expectedDenominator === expectedNumerator * parsed.denominator;
  }
  return parsed.value === Number(question.answer);
}

function correctAnswerText(question) {
  const kind = (question && question.answerKind) || 'integer';
  if (kind === 'decimal') return formatTenths(Number(question.answerTenths));
  if (kind === 'fraction') return question.answerNumerator + '/' + question.answerDenominator;
  return String(question.answer);
}

function correctAnswerValue(question) {
  const kind = (question && question.answerKind) || 'integer';
  if (kind === 'fraction') return String(question.answer);
  return Number(question.answer);
}

function summarize(results) {
  let correct = 0;
  let wrong = 0;
  let blank = 0;
  for (let i = 0; i < results.length; i += 1) {
    const verdict = results[i].verdict;
    if (verdict === 'correct') correct += 1;
    else if (verdict === 'wrong') wrong += 1;
    else blank += 1;
  }
  const total = results.length;
  const answered = correct + wrong;
  const accuracy = total === 0 ? 0 : correct / total;
  return {
    total: total,
    answered: answered,
    correct: correct,
    wrong: wrong,
    blank: blank,
    accuracyPercent: Math.round(accuracy * 100),
    accuracy: Number(accuracy.toFixed(4))
  };
}

/**
 * 批改一次作答。
 *
 * @param {object} input
 * @param {Array}  input.questions 出题结果；每题需含答案字段
 * @param {Array}  input.answers   与 questions 等长、同序的作答
 * @param {string} [input.quizId]
 * @param {string} [input.ruleId]
 * @param {number} [input.grade]
 * @param {object} [input.config]
 * @param {number} [input.durationSeconds]
 * @param {string} [input.finishedBy]
 * @returns {object} { ok: true, result } 或 { ok: false, code, message }
 */
function gradeAnswers(input) {
  const source = input || {};
  const questions = source.questions;
  const answers = source.answers;

  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, code: 'INVALID_QUESTIONS', message: '题目为空或格式不正确，无法批改' };
  }
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return {
      ok: false,
      code: 'ANSWER_COUNT_MISMATCH',
      message: '提交的作答数量（' + (Array.isArray(answers) ? answers.length : 0) + '）与题目数量（' + questions.length + '）不一致'
    };
  }

  const results = [];
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    if (!question || question.answer === undefined || question.answer === null) {
      return { ok: false, code: 'INVALID_QUESTIONS', message: '第 ' + (i + 1) + ' 题缺少正确答案，无法批改' };
    }
    const raw = answers[i];
    const parsed = parseAnswer(question, raw);
    const kind = question.answerKind || 'integer';
    if (kind === 'decimal' && question.answerTenths === undefined) {
      return { ok: false, code: 'INVALID_QUESTIONS', message: '第 ' + (i + 1) + ' 题缺少小数答案，无法批改' };
    }
    if (kind === 'fraction' && (question.answerNumerator === undefined || question.answerDenominator === undefined)) {
      return { ok: false, code: 'INVALID_QUESTIONS', message: '第 ' + (i + 1) + ' 题缺少分数答案，无法批改' };
    }

    let verdict = 'wrong';
    let reason = 'incorrect';
    if (parsed.blank) {
      verdict = 'blank';
      reason = 'blank';
    } else if (parsed.invalid) {
      verdict = 'wrong';
      reason = 'invalidFormat';
    } else if (isAnswerCorrect(question, parsed)) {
      verdict = 'correct';
      reason = 'correct';
    }

    const operation = canonicalOperation(question.operation) || canonicalOperation(source.operation) || 'add';
    results.push({
      questionId: question.id === undefined ? String(i + 1) : String(question.id),
      index: i + 1,
      ruleId: question.ruleId || source.ruleId || '',
      operation: operation,
      answerKind: kind,
      text: question.text,
      formula: question.formula,
      left: question.left,
      right: question.right,
      userAnswer: parsed.blank
        ? null
        : (kind === 'fraction' ? parsed.text : (kind === 'decimal' ? parsed.value : parsed.value)),
      userText: parsed.blank ? '' : (parsed.text || ''),
      correctAnswer: correctAnswerValue(question),
      verdict: verdict,
      reason: reason,
      correctText: buildEquation(question, correctAnswerText(question))
    });
  }

  const summary = summarize(results);
  const operation = canonicalOperation(source.operation) ||
    (results.length && results[0].operation) || 'add';

  return {
    ok: true,
    result: {
      version: 1,
      quizId: source.quizId ? String(source.quizId) : '',
      ruleId: source.ruleId || (results.length ? results[0].ruleId : '') || '',
      grade: Number.isInteger(Number(source.grade)) ? Number(source.grade) : null,
      operation: operation,
      config: source.config || null,
      total: summary.total,
      answered: summary.answered,
      correct: summary.correct,
      wrong: summary.wrong,
      blank: summary.blank,
      accuracy: summary.accuracy,
      accuracyPercent: summary.accuracyPercent,
      durationSeconds: Number.isInteger(Number(source.durationSeconds)) ? Number(source.durationSeconds) : null,
      finishedBy: source.finishedBy === 'timeup' ? 'timeup' : 'manual',
      questions: results,
      generatedAt: Date.now()
    }
  };
}

module.exports = {
  MAX_ANSWER,
  isBlankAnswer,
  normalizeAnswer,
  parseAnswer,
  isAnswerCorrect,
  correctAnswerText,
  summarize,
  gradeAnswers
};
