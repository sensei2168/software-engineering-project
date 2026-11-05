const { sanitizeConfig } = require('./question/session-core');
const { validateQuestionSpec } = require('./question/generator');
const KEY = 'kousuan_active_practice_v1';
function validate(d) {
  if (!d || d.version !== 1 || typeof d.quizId !== 'string' || !d.quizId ||
      !Number.isFinite(d.startTime) || d.startTime <= 0 || typeof d.ruleVersion !== 'string') throw Error('未完成练习数据无效，请返回首页重新开始。');
  const c = sanitizeConfig(d.config);
  if (!c.ok || !Array.isArray(d.questions) || d.questions.length !== c.value.count ||
      !d.questions.every(q => validateQuestionSpec(q) && (c.value.ruleIds || [c.value.ruleId]).includes(q.ruleId)) ||
      !Array.isArray(d.answers) || d.answers.length !== d.questions.length ||
      !d.answers.every(a => typeof a === 'string' && a.length <= 24) ||
      !Number.isInteger(d.index) || d.index < 0 || d.index >= d.questions.length ||
      !['', 'manual', 'timeup'].includes(d.pending)) throw Error('未完成练习数据不完整，请返回首页重新开始。');
  return d;
}
function read() {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return { ok: true, draft: null };
    const d = wx.getStorageSync(KEY);
    return { ok: true, draft: d ? validate(d) : null };
  } catch (_) { return { ok: false, error: '未完成练习读取失败，数据已保留。请返回首页重试或重新开始。' }; }
}
function save(d) {
  try {
    validate(d); wx.setStorageSync(KEY, d);
    if (JSON.stringify(wx.getStorageSync(KEY)) !== JSON.stringify(d)) throw Error('verify');
    return { ok: true };
  } catch (_) { return { ok: false, error: '进度保存失败，关闭后可能无法恢复最新答案，请留在本页完成并交卷。' }; }
}
function clear() {
  try { wx.setStorageSync(KEY, null); if (wx.getStorageSync(KEY)) throw Error('verify'); return { ok: true }; }
  catch (_) { return { ok: false, error: '未完成练习清除失败，请重试。' }; }
}
module.exports = { KEY, read, save, clear, validate };
