const { judgeQuestion, parseAnswer } = require('./exact-answer');
function selectedItems(record) {
  if (!record || !Array.isArray(record.items) || record.isDevData) throw new Error('找不到可订正的真实记录。');
  return record.items.filter(item => item.status !== 'correct');
}
function gradeCorrection(item, raw) {
  if (!raw.trim()) return { ok: true, status: 'unanswered', answer: '' };
  const question = item.question;
  const fields = question && ({ integer: ['answer'], decimal: ['answerTenths'], fraction: ['answerNumerator', 'answerDenominator'] })[question.answerKind];
  if (fields && fields.every(field => question[field] !== undefined && question[field] !== null)) {
    try {
      const judged = judgeQuestion(question, raw);
      return judged.ok ? { ok: true, status: judged.correct ? 'correct' : 'wrong', answer: judged.text } : judged;
    } catch (_) {
      return { ok: false, message: '原记录的标准答案数据异常，请重新练习该题型。' };
    }
  }
  // 单人整数/混合快照未包含answer，旧历史也可能无快照；比较保存的标准答案，不重新出题。
  const left = parseAnswer(raw, 'fraction'), right = parseAnswer(String(item.correctAnswer), 'fraction');
  if (!left.ok) return left;
  if (!right.ok) return { ok: false, message: '旧记录的标准答案格式无法订正，请重新练习该题型。' };
  const a = left.numerator * right.denominator, b = right.numerator * left.denominator;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return { ok: false, message: '数值超过精确比较范围。' };
  return { ok: true, answer: left.text, status: a === b ? 'correct' : 'wrong' };
}
module.exports = { selectedItems, gradeCorrection };
