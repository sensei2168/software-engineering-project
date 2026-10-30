/**
 * 判分与结果汇总（纯函数，不依赖 wx / 云开发，可在小程序端与云函数端复用）。
 *
 * 判分规则：
 * 1. 未填写（空白）记为「未答」，不算答错；
 * 2. 数字 0 是有效答案，只要等于正确答案就算对；
 * 3. 填写了但不是整数、或与正确答案不符，记为「答错」；
 * 4. 每题结果只有 correct / wrong / blank 三种，数量之和必须等于总题数。
 *
 * P3 只处理整数答案（最大 1000）；小数、分数由 P4 接入时在这里扩展。
 */
const { canonicalOperation, buildEquation } = require('./generator');

const MAX_ANSWER = 1000;
const MAX_DIGITS = 4;

function isBlankAnswer(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/** ' 07 ' -> 7；'0' -> 0；'' -> null；'abc' / '1.5' / '-1' -> NaN。 */
function normalizeAnswer(value) {
  if (isBlankAnswer(value)) return null;
  const text = String(value).trim();
  const pattern = new RegExp('^\\d{1,' + MAX_DIGITS + '}$');
  if (!pattern.test(text)) return Number.NaN;
  const number = Number(text);
  return Number.isInteger(number) ? number : Number.NaN;
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
    // 展示用整数百分比：2/4 -> 50；1/3 -> 33。
    accuracyPercent: Math.round(accuracy * 100),
    // 保留原始小数，供需要精确值的统计使用。
    accuracy: Number(accuracy.toFixed(4))
  };
}

/**
 * 批改一次作答。
 *
 * @param {object} input
 * @param {Array}  input.questions 出题结果；每题需含 id / answer（正确答案）
 * @param {Array}  input.answers   与 questions 等长、同序的作答；'' / null 表示未答
 * @param {string} [input.quizId]  本次练习号（结果里回传）
 * @param {string} [input.ruleId]  题型编号，写进结果，便于历史还原
 * @param {number} [input.grade]   年级，写进结果
 * @param {string} [input.operation] 'add' | 'subtract'，缺省时取题目上的 operation
 * @param {object} [input.config]  练习设置，原样放进结果，便于结果页/记录页展示
 * @param {number} [input.durationSeconds] 实际用时，单位秒，可选
 * @param {string} [input.finishedBy] 'manual' | 'timeup'，本次如何结束，可选
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
    const normalized = normalizeAnswer(raw);
    const correctAnswer = Number(question.answer);
    const blank = normalized === null;
    const isCorrect = !blank && !Number.isNaN(normalized) && normalized === correctAnswer;

    let verdict = 'wrong';
    let reason = 'incorrect';
    if (blank) {
      verdict = 'blank';
      reason = 'blank';
    } else if (isCorrect) {
      verdict = 'correct';
      reason = 'correct';
    } else if (Number.isNaN(normalized)) {
      reason = 'invalidFormat';
    }

    const operation = canonicalOperation(question.operation) || canonicalOperation(source.operation) || 'add';
    results.push({
      questionId: question.id === undefined ? String(i + 1) : String(question.id),
      index: i + 1,
      ruleId: question.ruleId || source.ruleId || '',
      operation: operation,
      text: question.text,
      formula: question.formula,
      left: question.left,
      right: question.right,
      userAnswer: blank ? null : normalized,
      userText: isBlankAnswer(raw) ? '' : String(raw).trim(),
      correctAnswer: correctAnswer,
      verdict: verdict,
      reason: reason,
      // 结果页直接展示 "12 − 5 = 7"；用户答案单独展示，避免两者混淆
      correctText: correctAnswer === null ? '' : buildEquation(question, correctAnswer)
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
  MAX_DIGITS,
  isBlankAnswer,
  normalizeAnswer,
  summarize,
  gradeAnswers
};
