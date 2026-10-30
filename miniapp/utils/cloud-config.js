/**
 * 出题云函数配置。
 *
 * 环境 ID 统一来自 `config/cloud.js`（袁嘉亮维护），不要在这里重复写。
 * `QUESTION_CLOUD_ENABLED` 暂时保持 false：云函数还没有把每次练习的题目和答案
 * 写入云数据库，云端收卷时拿不到答案。题库入库完成、云函数部署后再打开。
 * 关闭时练习页走本地兜底，逻辑与云端完全一致。
 */
const cloud = require('../config/cloud');

module.exports = {
  CLOUD_ENV: cloud.envId,
  FUNCTION_NAME: 'createQuestionSet',
  QUESTION_CLOUD_ENABLED: false
};
