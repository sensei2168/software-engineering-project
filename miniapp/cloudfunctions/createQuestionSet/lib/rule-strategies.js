/**
 * 题型 → 出题策略（纯数据，不依赖 wx / 云开发）。
 *
 * 只描述「怎么生成」，不描述展示文案；展示用的年级、名称、范围仍在 practice-rules.js。
 * 两个文件都改时注意保持 ruleId 一致；tests/question.test.js 会检查每个策略都有对应规则。
 *
 * 规则来源：docs/年级题型设置交付说明.md 的题型表。
 */
const STRATEGIES = {
  // 整数加减法：两个 0—limit 的数，和/差不超过 limit
  g1_add_20: { operation: 'add', limit: 20 },
  g1_subtract_20: { operation: 'subtract', limit: 20 },
  g2_add_100: { operation: 'add', limit: 100 },
  g2_subtract_100: { operation: 'subtract', limit: 100 },
  g3_add_1000: { operation: 'add', limit: 1000 },
  g3_subtract_1000: { operation: 'subtract', limit: 1000 },

  // 表内乘法：两个乘数 1—9，交换乘数算重复 → 45 种
  g2_multiply_table: {
    operation: 'multiply', aMin: 1, aMax: 9, bMin: 1, bMax: 9, commutative: true
  },
  // 表内除法：除数和商都是 1—9，被除数 = 除数 × 商
  g2_divide_table: {
    operation: 'divide', divisorMin: 1, divisorMax: 9, quotientMin: 1, quotientMax: 9
  },
  // 两位数 × 一位数：10—99 × 1—9
  g3_multiply_2by1: {
    operation: 'multiply', aMin: 10, aMax: 99, bMin: 1, bMax: 9, commutative: false
  },
  // 两位数 ÷ 一位数：被除数 10—99，除数 1—9，必须整除
  g3_divide_2by1: {
    operation: 'divide', divisorMin: 1, divisorMax: 9, dividendMin: 10, dividendMax: 99
  }
};

function getStrategy(ruleId) {
  return STRATEGIES[ruleId] || null;
}

function listSupportedRuleIds() {
  return Object.keys(STRATEGIES);
}

module.exports = { STRATEGIES, getStrategy, listSupportedRuleIds };
