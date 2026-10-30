const { envId: DEFAULT_ENV_ID } = require('../config/cloud');
const WRITE_ACTIONS = ['create', 'join', 'setReady', 'leave'];
function problem(code, message) { const error = new Error(message); error.code = code; return error; }
function createRoomClient({ wxApi, envId = DEFAULT_ENV_ID, makeRequestId = () => 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2) }) {
  if (typeof envId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{2,100}$/.test(envId) || /^wx[0-9a-f]{16}$/i.test(envId)) {
    throw problem('ENV_NOT_CONFIGURED', '请填写云开发环境 ID，而不是小程序 AppID');
  }
  if (!wxApi.cloud || typeof wxApi.cloud.init !== 'function' || typeof wxApi.cloud.callFunction !== 'function') {
    throw problem('CLOUD_UNSUPPORTED', '当前环境不支持云开发，请检查微信基础库和开发者工具');
  }
  const key = 'room-p2.pending.' + envId;
  function storage(method, ...args) {
    try { return wxApi[method](...args); }
    catch (_) { throw problem('LOCAL_STORAGE_FAILED', '本机未能保存请求状态，请检查存储后重试'); }
  }
  function pending() { return storage('getStorageSync', key) || null; }
  wxApi.cloud.init({ env: envId, traceUser: false });

  async function invoke(request) {
    let response;
    try {
      response = await wxApi.cloud.callFunction({ name: 'roomService', data: request, config: { env: envId } });
    } catch (_) {
      throw problem('CLOUD_CALL_FAILED', '云函数调用失败，请确认环境和部署；写入操作请使用“重试未确认操作”');
    }
    const result = response && response.result;
    if (!result || result.apiVersion !== 1 || typeof result.ok !== 'boolean' || !Number.isFinite(result.serverNow) ||
        (result.ok ? !result.data || typeof result.data !== 'object' : !result.error || typeof result.error.code !== 'string' || typeof result.error.message !== 'string')) {
      throw problem('INVALID_RESPONSE', '服务返回格式不正确，请检查云函数版本后重试');
    }
    if (WRITE_ACTIONS.includes(request.action) && (result.ok || result.error.code !== 'SERVICE_UNAVAILABLE')) {
      // 先保存恢复入口，再清除请求；中途存储失败时仍能用原编号安全重试。
      if (result.ok && result.data.room) storage('setStorageSync', 'room-p2.last-room.' + envId, result.data.room.roomId);
      if (result.ok && result.data.left) storage('removeStorageSync', 'room-p2.last-room.' + envId);
      storage('removeStorageSync', key);
    }
    if (!result.ok) throw problem(result.error.code, result.error.message);
    return result;
  }
  return {
    pending,
    async call(action, payload = {}) {
      const request = { action, payload };
      if (WRITE_ACTIONS.includes(action)) {
        if (pending()) throw problem('PENDING_REQUEST', '存在尚未确认的操作，请先重试该操作');
        request.requestId = makeRequestId();
        storage('setStorageSync', key, request);
      }
      return invoke(request);
    },
    async retryPending() {
      const request = pending();
      if (!request) throw problem('NO_PENDING_REQUEST', '没有需要重试的操作');
      return invoke(request);
    }
  };
}
module.exports = { createRoomClient };
