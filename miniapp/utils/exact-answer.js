// 有界整数比值判等；不执行输入表达式，也不对小数四舍五入后判分。
function parseAnswer(raw, kind) {
  if (typeof raw !== 'string' || raw.length > 24) return { ok: false, message: '答案请输入不超过24个字符的数字。' };
  const text = raw.trim();
  if (!text) return { ok: false, message: '请先填写答案。' };
  let numerator, denominator;
  if (kind === 'fraction' && /^-?\d{1,6}\s*\/\s*\d{1,6}$/.test(text)) {
    const parts = text.split('/'); numerator = Number(parts[0]); denominator = Number(parts[1]);
  } else if (/^-?\d{1,6}(?:\.\d{1,6})?$/.test(text)) {
    const parts = text.split('.'); denominator = parts[1] ? Math.pow(10, parts[1].length) : 1;
    numerator = Number(parts[0]) * denominator + (text[0] === '-' ? -1 : 1) * Number(parts[1] || 0);
  } else return { ok: false, message: kind === 'fraction' ? '请输入分数（如2/4）或有限小数，分母不能为0。' : '请输入数字，不支持算式或科学计数法。' };
  if (!denominator || !Number.isSafeInteger(numerator) || Math.abs(numerator) > 999999999999) return { ok: false, message: '答案超出范围或分母为0。' };
  return { ok: true, text, numerator, denominator };
}
function exactValue(question) {
  if (question.answerKind === 'fraction') return { numerator: question.answerNumerator, denominator: question.answerDenominator };
  if (question.answerKind === 'decimal') return { numerator: question.answerTenths, denominator: 10 };
  return { numerator: question.answer, denominator: 1 };
}
function judgeQuestion(question, raw) {
  const parsed = parseAnswer(raw, question.answerKind);
  if (!parsed.ok) return parsed;
  const expected = exactValue(question);
  if (!Number.isInteger(expected.numerator) || !Number.isInteger(expected.denominator) || expected.denominator < 1) throw new Error('Invalid exact answer');
  const left = parsed.numerator * expected.denominator, right = expected.numerator * parsed.denominator;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return { ok: false, message: '答案数值过大。' };
  return { ok: true, text: parsed.text, correct: left === right };
}
function answerText(question) {
  const value = exactValue(question);
  return question.answerKind === 'fraction' ? value.numerator + '/' + value.denominator
    : question.answerKind === 'decimal' ? (value.numerator / 10).toFixed(1) : String(value.numerator);
}
module.exports = { parseAnswer, judgeQuestion, answerText };
