const { judgeQuestion, parseAnswer } = require('./exact-answer');
function selectedItems(record) {
  if (!record || !Array.isArray(record.items) || record.isDevData) throw new Error('找不到可订正的真实记录。');
  return record.items.filter(item => item.status !== 'correct');
}
function gradeCorrection(item, raw) {
  if (!raw.trim()) return { ok: true, status: 'unanswered', answer: '' };
  if (item.question && ['integer', 'decimal', 'fraction'].includes(item.question.answerKind)) {
    const judged = judgeQuestion(item.question, raw);
    return judged.ok ? { ok: true, status: judged.correct ? 'correct' : 'wrong', answer: judged.text } : judged;
  }
  // 旧历史没有结构化原题时，只比较原记录中的标准答案；不猜测或重新生成原题。
  const left = parseAnswer(raw, 'fraction'), right = parseAnswer(String(item.correctAnswer), 'fraction');
  if (!left.ok) return left;
  if (!right.ok) return { ok: false, message: '旧记录的标准答案格式无法订正，请重新练习该题型。' };
  const a = left.numerator * right.denominator, b = right.numerator * left.denominator;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return { ok: false, message: '数值超过精确比较范围。' };
  return { ok: true, answer: left.text, status: a === b ? 'correct' : 'wrong' };
}
module.exports = { selectedItems, gradeCorrection };
