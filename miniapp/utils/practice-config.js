const { getRule, getRulesForGrade, getGradeLabel } = require('./practice-rules');

const DEFAULT_CONFIG = {
  grade: 1,
  ruleId: 'g1_add_20',
  operation: 'add',
  limit: 20,
  count: 30,
  mode: 'normal',
  durationSeconds: 120
};
const DURATIONS = [60, 120, 180];

function validateConfig(input) {
  if (!input) return { ok: false, message: '练习设置不能为空' };

  let grade = input.grade;
  let ruleId = input.ruleId;
  // 兼容原先已经分享或打开的“20以内加减法”链接。
  if (grade === undefined && ruleId === undefined && input.limit === 20) {
    const legacyRule = getRulesForGrade(1).find((rule) => rule.operation === input.operation);
    if (legacyRule) {
      grade = legacyRule.grade;
      ruleId = legacyRule.id;
    }
  }
  if (!Number.isInteger(grade) || !getGradeLabel(grade)) {
    return { ok: false, message: '请选择一年级、二年级或三年级' };
  }
  const rule = getRule(ruleId);
  if (!rule || rule.grade !== grade) {
    return { ok: false, message: '请选择当前年级支持的题型' };
  }
  if (input.operation !== undefined && input.operation !== rule.operation) {
    return { ok: false, message: '题型与练习规则不一致，请重新选择' };
  }
  if (input.limit !== undefined && input.limit !== rule.limit) {
    return { ok: false, message: '题目范围与练习规则不一致，请重新选择' };
  }
  if (!Number.isInteger(input.count) || input.count < 10 || input.count > 50) {
    return { ok: false, message: '题量请输入 10 到 50 之间的整数' };
  }
  if (['normal', 'timed'].indexOf(input.mode) === -1) {
    return { ok: false, message: '请选择普通练习或限时练习' };
  }
  if (DURATIONS.indexOf(input.durationSeconds) === -1) {
    return { ok: false, message: '请选择 60、120 或 180 秒' };
  }
  return { ok: true, value: {
    grade, ruleId: rule.id, operation: rule.operation, limit: rule.limit, count: input.count,
    mode: input.mode, durationSeconds: input.durationSeconds
  } };
}

function toQuery(config) {
  return Object.keys(config).map((key) => key + '=' + encodeURIComponent(config[key])).join('&');
}

function fromQuery(query) {
  if (!query) return { ok: false, message: '练习设置不能为空' };
  return validateConfig({
    grade: query.grade === undefined ? undefined : Number(query.grade),
    ruleId: query.ruleId,
    operation: query.operation,
    limit: query.limit === undefined ? undefined : Number(query.limit),
    count: Number(query.count), mode: query.mode,
    durationSeconds: Number(query.durationSeconds)
  });
}

function getConfigDisplay(config) {
  const rule = getRule(config.ruleId);
  return {
    gradeLabel: getGradeLabel(config.grade),
    ruleLabel: rule.label,
    rangeLabel: rule.rangeLabel,
    ruleNote: rule.note
  };
}

module.exports = { DEFAULT_CONFIG, DURATIONS, validateConfig, toQuery, fromQuery, getConfigDisplay };
