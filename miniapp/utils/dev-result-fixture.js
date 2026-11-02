// 开发测试数据。
//
// 出题与批改模块尚未接入时，结果页用这组数据验证页面与统计。
// 这组用例由组内指定，只用于开发验证，页面上会明确标注「开发测试数据」。
//
//   3＋2  用户答 5   → 正确
//   7－3  用户答 5   → 错误（正确答案 4）
//   8－8  用户答 0   → 正确
//   4＋1  未填写     → 未答（正确答案 5）
// 预期统计：总题数 4、正确 2、错误 1、未答 1、正确率 50.0%
//
// 两个容易写错的地方，用例特意覆盖：
//   1. 8－8 用户答的是数字 0，这是有效答案，不是漏答；
//   2. 4＋1 才是漏答，必须单独计入「未答」，不能并进「错误」。
//
// 同时验证精确答案与结构化原题快照能被保存并在历史中还原。
// ruleId 置为 null：这组数据混合加减法，不冒充某个具体题型规则。

const DEV_PRACTICE_ID = 'dev-fixture-0001';
const { RULE_VERSION } = require('./practice-rules');

// 与后端联调页一致：只允许开发版／体验版，版本未知时不开放。
function canUseDevResult() {
  try {
    const info = wx.getAccountInfoSync();
    return !!info.miniProgram && ['develop', 'trial'].includes(info.miniProgram.envVersion);
  } catch (_) {
    return false;
  }
}

function buildDevResult() {
  return {
    practiceId: DEV_PRACTICE_ID,
    isDevData: true,
    ruleId: null,
    config: null,
    items: [
      { expression: '3＋2', userAnswer: '5', correctAnswer: '5', status: 'correct' },
      { expression: '7－3', userAnswer: '5', correctAnswer: '4', status: 'wrong' },
      { expression: '8－8', userAnswer: '0', correctAnswer: '0', status: 'correct' },
      { expression: '4＋1', userAnswer: '', correctAnswer: '5', status: 'unanswered' }
    ]
  };
}

// 小数与分数的精确答案示例，用于验证历史可还原且不被规则表重算
const DECIMAL_FRACTION_SAMPLE = {
  practiceId: 'dev-precise-0001',
  isDevData: true,
  ruleId: 'g3_decimal_1place',
  ruleVersion: RULE_VERSION,
  config: null,
  items: [
    { expression: '1.2 ＋ 0.5 ＝ ?', userAnswer: '1.7', correctAnswer: '1.7', status: 'correct' },
    { expression: '0.9 ＋ 0.4 ＝ ?', userAnswer: '1.3', correctAnswer: '1.3', status: 'correct' },
    {
      expression: '1/5 ＋ 2/5 ＝ ?',
      question: { kind: 'fraction', denominator: 5, numerators: [1, 2] },
      userAnswer: '3/5',
      correctAnswer: '3/5',
      status: 'correct'
    }
  ]
};

const EXPECTED = { total: 4, correct: 2, wrong: 1, unanswered: 1, accuracyText: '50.0%' };

module.exports = { DEV_PRACTICE_ID, EXPECTED, DECIMAL_FRACTION_SAMPLE, buildDevResult, canUseDevResult };
