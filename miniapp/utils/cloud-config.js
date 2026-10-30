/**
 * 云开发环境配置。
 *
 * 现在还没有创建云环境，所以 CLOUD_ENV 留空，练习页会自动走本地兜底（逻辑与云函数完全相同）。
 * 袁嘉亮在云开发控制台建好环境后，把环境 ID 填进来（形如 'kousuan-3g8xxxx'），
 * 再把 cloudfunctions/createQuestionSet 上传部署，小程序就会自动改走云端。
 *
 * 注意：云端出题下发的题目不带 answer，而收卷需要服务端按 quizId 反查答案。
 * 在「题目写入云数据库」完成之前先不要填环境 ID，否则交卷会报"题目数据不完整"。
 * 详见 docs/接口与判分说明.md 第 7 节。
 */
module.exports = {
  CLOUD_ENV: '',
  FUNCTION_NAME: 'createQuestionSet'
};
