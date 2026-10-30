// 已确认的 V2 设置预设。这里只描述题型，不生成题目或执行判题。
const GRADES = [
  { value: 1, label: '一年级' },
  { value: 2, label: '二年级' },
  { value: 3, label: '三年级' }
];

const RULE_GROUPS = [
  { value: 'integer', label: '整数口算' },
  { value: 'rational', label: '小数与分数' }
];

const RULES = [
  {
    id: 'g1_add_20', grade: 1, operation: 'add', group: 'integer',
    label: '加法', rangeLabel: '20 以内', limit: 20,
    example: '8 ＋ 7 ＝ ?'
  },
  {
    id: 'g1_subtract_20', grade: 1, operation: 'subtract', group: 'integer',
    label: '减法', rangeLabel: '20 以内', limit: 20,
    example: '16 − 9 ＝ ?'
  },
  {
    id: 'g2_add_100', grade: 2, operation: 'add', group: 'integer',
    label: '加法', rangeLabel: '100 以内', limit: 100,
    example: '36 ＋ 28 ＝ ?'
  },
  {
    id: 'g2_subtract_100', grade: 2, operation: 'subtract', group: 'integer',
    label: '减法', rangeLabel: '100 以内', limit: 100,
    example: '72 − 35 ＝ ?'
  },
  {
    id: 'g2_multiply_table', grade: 2, operation: 'multiply', group: 'integer',
    label: '表内乘法', rangeLabel: '1—9 的乘法口诀', limit: 81,
    example: '7 × 8 ＝ ?'
  },
  {
    id: 'g2_divide_table', grade: 2, operation: 'divide', group: 'integer',
    label: '表内除法', rangeLabel: '乘法口诀对应整除', limit: 81,
    example: '56 ÷ 7 ＝ ?'
  },
  {
    id: 'g3_add_1000', grade: 3, operation: 'add', group: 'integer',
    label: '加法', rangeLabel: '1000 以内', limit: 1000,
    example: '230 ＋ 150 ＝ ?'
  },
  {
    id: 'g3_subtract_1000', grade: 3, operation: 'subtract', group: 'integer',
    label: '减法', rangeLabel: '1000 以内', limit: 1000,
    example: '560 − 240 ＝ ?'
  },
  {
    id: 'g3_multiply_2by1', grade: 3, operation: 'multiply', group: 'integer',
    label: '乘法', rangeLabel: '两位数 × 一位数', limit: 891,
    example: '24 × 3 ＝ ?'
  },
  {
    id: 'g3_divide_2by1', grade: 3, operation: 'divide', group: 'integer',
    label: '除法', rangeLabel: '两位数 ÷ 一位数 · 整除', limit: 99,
    example: '72 ÷ 3 ＝ ?'
  },
  {
    id: 'g3_mixed_2step', grade: 3, operation: 'mixed', group: 'integer',
    label: '混合运算', rangeLabel: '整数两步 · 无括号', limit: 100,
    example: '18 ＋ 6 × 3 ＝ ?', wide: true,
    note: '先乘除，后加减；中间结果非负，除法可整除。'
  },
  {
    id: 'g3_decimal_1place', grade: 3, operation: 'decimal_add_sub', group: 'rational',
    label: '小数加减', rangeLabel: '一位小数 · 10 以内', limit: 10,
    example: '1.2 ＋ 0.5 ＝ ?',
    note: '每题只做一次加或减，不出现负数。'
  },
  {
    id: 'g3_fraction_same_den', grade: 3, operation: 'fraction_add_sub', group: 'rational',
    label: '分数加减', rangeLabel: '同分母 · 分母 2—9', limit: 1,
    exampleKind: 'fraction',
    fractionExample: { leftNumerator: 1, rightNumerator: 2, denominator: 5 },
    note: '和不超过1，差不小于0；不要求约分。'
  }
].map((rule) => Object.assign({ wide: false, note: '', exampleKind: 'text' }, rule));

function getRule(ruleId) {
  return RULES.find((rule) => rule.id === ruleId);
}

function getRulesForGrade(grade, group) {
  return RULES.filter((rule) => rule.grade === grade && (!group || rule.group === group));
}

function getGradeLabel(grade) {
  const item = GRADES.find((entry) => entry.value === grade);
  return item ? item.label : '';
}

module.exports = { GRADES, RULE_GROUPS, RULES, getRule, getRulesForGrade, getGradeLabel };
