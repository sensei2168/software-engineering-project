/**
 * 练习服务：对页面暴露 createQuestionSet / submitAnswers 两个方法。
 *
 * 优先走云函数（答案与判分逻辑在云端），云环境没配好、调用失败或超时的时候，
 * 自动回落到本地同一套模块——两边调用的都是 utils/question/session-core.js，
 * 返回结构完全一致，所以页面代码不需要区分。
 *
 * 本地兜底会把「含答案的题目」留在本模块内存里（localSessions），页面只拿到脱敏题目。
 * 收卷时按 quizId 取回，页面完全不需要接触答案。
 *
 * 返回值里带 source: 'cloud' | 'local'，方便开发时确认现在走的是哪条路。
 */
const cloudConfig = require('../utils/cloud-config');
const core = require('../utils/question/session-core');

const CLOUD_TIMEOUT_MS = 6000;
const MAX_LOCAL_SESSIONS = 20;

let cloudReady = false;
const localSessions = {};
const localOrder = [];

function canUseCloud() {
  if (!cloudConfig.QUESTION_CLOUD_ENABLED) return false;
  if (!cloudConfig.CLOUD_ENV) return false;
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return false;
  return true;
}

function ensureCloud() {
  if (cloudReady) return true;
  if (!canUseCloud()) return false;
  try {
    wx.cloud.init({ env: cloudConfig.CLOUD_ENV, traceUser: true });
    cloudReady = true;
    return true;
  } catch (error) {
    console.warn('[question-service] 云开发初始化失败，改用本地出题', error);
    return false;
  }
}

function createId(prefix) {
  let randomPart = '';
  try {
    if (typeof wx !== 'undefined' && wx.getRandomValues) {
      const buffer = new Uint8Array(4);
      wx.getRandomValues(buffer);
      for (let i = 0; i < buffer.length; i += 1) randomPart += buffer[i].toString(36);
    }
  } catch (error) {
    randomPart = '';
  }
  if (!randomPart) randomPart = Math.random().toString(36).slice(2, 10);
  return prefix + Date.now().toString(36) + '-' + randomPart;
}

/** 本地会话只保留最近若干次，避免长时间使用后内存一直增长。 */
function rememberLocalSession(quizId, questions) {
  if (!quizId) return;
  localSessions[quizId] = questions;
  localOrder.push(quizId);
  while (localOrder.length > MAX_LOCAL_SESSIONS) {
    const expired = localOrder.shift();
    delete localSessions[expired];
  }
}

function takeLocalQuestions(quizId) {
  return (quizId && localSessions[quizId]) || null;
}

function callCloud(action, payload) {
  return new Promise(function (resolve, reject) {
    if (!ensureCloud()) {
      reject(new Error('CLOUD_NOT_CONFIGURED'));
      return;
    }
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('CLOUD_TIMEOUT'));
    }, CLOUD_TIMEOUT_MS);
    wx.cloud.callFunction({
      name: cloudConfig.FUNCTION_NAME,
      data: { action: action, payload: payload },
      success: function (res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const body = res && res.result;
        if (!body || typeof body.ok !== 'boolean') {
          reject(new Error('CLOUD_BAD_RESPONSE'));
          return;
        }
        resolve(body);
      },
      fail: function (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error((error && error.errMsg) || 'CLOUD_CALL_FAILED'));
      }
    });
  });
}

/**
 * 出题。云端失败时自动改用本地，返回结构一致。
 * @param {object} config 来自 practice-config 的设置（含 grade / ruleId）
 * @returns {Promise<{ok: boolean, data?: object, code?: string, message?: string, source: string}>}
 */
async function createQuestionSet(config) {
  const sessionId = createId('q');
  if (canUseCloud()) {
    try {
      const body = await callCloud('createQuestionSet', { config: config, sessionId: sessionId });
      body.source = 'cloud';
      return body;
    } catch (error) {
      console.warn('[question-service] 云端不可用，本次改用本地兜底：' + error.message);
    }
  }
  const body = core.createQuestionSet({ config: config, sessionId: sessionId }, { includePrivate: true });
  body.source = 'local';
  if (body.ok) {
    rememberLocalSession(body.data.quizId, body.data.privateQuestions);
    delete body.data.privateQuestions;
  }
  return body;
}

/**
 * 收卷。页面只提交 quizId 和作答；本地模式下由本模块补回题目（含答案）再判分。
 * @param {{quizId: string, config: object, answers: Array, durationSeconds?: number, finishedBy?: string}} input
 */
async function submitAnswers(input) {
  const payload = Object.assign({}, input || {});
  const quizId = payload.quizId;

  if (canUseCloud()) {
    try {
      const body = await callCloud('submitAnswers', payload);
      body.source = 'cloud';
      return body;
    } catch (error) {
      console.warn('[question-service] 云端收卷失败，本次改用本地兜底：' + error.message);
    }
  }

  let questions = Array.isArray(payload.questions) ? payload.questions : null;
  if (!questions || !questions.length || questions[0].answer === undefined) {
    questions = takeLocalQuestions(quizId);
  }
  if (!questions) {
    return {
      ok: false,
      code: 'QUIZ_NOT_FOUND',
      message: '找不到这次练习的题目，请返回设置页重新开始。',
      source: 'local'
    };
  }
  const localPayload = Object.assign({}, payload, { questions: questions });
  const body = core.submitAnswers(localPayload);
  body.source = 'local';
  return body;
}

module.exports = {
  createQuestionSet,
  submitAnswers,
  createId,
  // 仅测试使用：清空本地会话
  _clearLocalSessions() {
    Object.keys(localSessions).forEach(function (key) { delete localSessions[key]; });
    localOrder.length = 0;
  }
};
