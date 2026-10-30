/**
 * 云函数入口：createQuestionSet
 *
 * 小程序的出题与收卷都从这里走。前端拿到的题目不含答案；
 * 判分逻辑在云端跑一遍（当前版本题目答案由客户端回传，下一步把题目写进云数据库后用 quizId 反查）。
 *
 * 约定：event = { action: 'createQuestionSet' | 'submitAnswers', payload: {...} }
 * 返回：{ ok: true, data } 或 { ok: false, code, message }
 *
 * 注意：lib/ 下的三个文件与 practice-rules.js 是 miniapp 端的副本，改完要同步（见 lib/README.md）。
 */
const { handleRequest } = require('./lib/session-core');

exports.main = async function main(event) {
  try {
    return handleRequest(event);
  } catch (error) {
    console.error('[createQuestionSet] 未捕获异常', error);
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: '出题服务异常，请重试'
    };
  }
};
