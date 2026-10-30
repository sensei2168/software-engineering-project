// 结果统计：只把已经批改好的逐题结果汇总成统计，不负责判断对错。
// 对错判定属于出题/批改模块（何顺），本文件只消费 status 字段。
//
// 与 docs/07 的约定一致：历史展示只读取保存时的快照，
// 不使用当前规则表重新计算旧题，因此本文件不认识任何题型规则。

const STATUS = { CORRECT: 'correct', WRONG: 'wrong', UNANSWERED: 'unanswered' };
const STATUS_TEXT = { correct: '正确', wrong: '错误', unanswered: '未答' };
const VALID_STATUS = [STATUS.CORRECT, STATUS.WRONG, STATUS.UNANSWERED];

// 空作答判定。注意 0 是有效作答，不能算空。
function isBlankAnswer(value) {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && value.trim() === '';
}

// 空作答显示「未作答」；数字 0 正常显示为 "0"。
// 精确答案（如 1.20、3/5）按保存时的原文显示，不做数值归一化，
// 否则历史记录会与保存时的标准答案不一致。
function formatAnswer(value) {
  if (isBlankAnswer(value)) return '未作答';
  return String(value).trim();
}

// 正确率 = 正确题数 ÷ 总题数 × 100%，保留一位小数（与立项稿口径一致）
function formatAccuracy(correct, total) {
  if (!total || total <= 0) return '0.0%';
  return (Math.round((correct / total) * 1000) / 10).toFixed(1) + '%';
}

// 汇总统计。不变式：correct + wrong + unanswered === total
// 未答题单独计数，既不并进错误，也不当成 0。
function computeSummary(items) {
  if (!Array.isArray(items)) throw new Error('题目数据必须是数组');
  if (items.length === 0) throw new Error('没有可统计的题目，无法生成结果');

  let correct = 0;
  let wrong = 0;
  let unanswered = 0;

  items.forEach(function (item, index) {
    const status = item && item.status;
    if (VALID_STATUS.indexOf(status) === -1) {
      // 缺少状态时明确失败，不猜成错误，否则统计会被静默污染
      throw new Error('第 ' + (index + 1) + ' 题的结果状态无效');
    }
    if (status === STATUS.CORRECT) correct++;
    else if (status === STATUS.WRONG) wrong++;
    else unanswered++;
  });

  const total = items.length;
  if (correct + wrong + unanswered !== total) throw new Error('统计结果与总题数不一致');

  return {
    total: total,
    correct: correct,
    wrong: wrong,
    unanswered: unanswered,
    accuracyText: formatAccuracy(correct, total)
  };
}

// 逐题行数据，供 WXML 直接渲染，模板里不写判断逻辑。
// 使用的字段全部来自保存时的快照，不查规则表。
function toRows(items) {
  return (items || []).map(function (item, index) {
    return {
      index: index + 1,
      expression: item.expression,
      userAnswerText: formatAnswer(item.userAnswer),
      correctAnswerText: formatAnswer(item.correctAnswer),
      status: item.status,
      statusText: STATUS_TEXT[item.status] || '未知',
      isBlank: isBlankAnswer(item.userAnswer)
    };
  });
}

module.exports = {
  STATUS,
  STATUS_TEXT,
  VALID_STATUS,
  isBlankAnswer,
  formatAnswer,
  formatAccuracy,
  computeSummary,
  toRows
};
