// 服务端开赛适配层：标准答案及结构化原题只存数据库，公开题目逐字段白名单输出。
const { generateQuestions, ENGINE_VERSION } = require('./question-generator');
const contract = require('./rules.generated.json');

function createQuestions(config, attemptId, secretSeed) {
  const ids = config.ruleIds || [config.ruleId];
  const groups = ids.map((ruleId, i) => {
    const count = Math.floor(config.count / ids.length) + Number(i < config.count % ids.length);
    const result = generateQuestions({ ruleId, count, sessionId: attemptId, seed: secretSeed });
    if (!result.ok) throw new Error('Question generation failed');
    return result.questions;
  });
  const questions = [];
  for (let row = 0; questions.length < config.count; row++) {
    for (const group of groups) if (group[row]) questions.push(group[row]);
  }
  return { ruleVersion: contract.ruleVersion, engineVersion: ENGINE_VERSION,
    questions: questions.map((question, index) => ({ ...question, index: index + 1, id: 'q_' + (index + 1) })) };
}

function publicQuestion(question) {
  // 不使用展开或删除字段黑名单，避免新增私有字段随响应泄露。
  return { id: question.id, index: question.index, ruleId: question.ruleId,
    text: question.text, answerKind: question.answerKind };
}

module.exports = { createQuestions, publicQuestion };
