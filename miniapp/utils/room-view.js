const { DEFAULT_CONFIG, validateConfig, getConfigDisplay } = require('./practice-config');
const { getRule } = require('./practice-rules');

function roomConfig(input = {}) {
  const rule = getRule(input.ruleId || DEFAULT_CONFIG.ruleId);
  const result = validateConfig(Object.assign({}, DEFAULT_CONFIG,
    rule ? { operation: rule.operation, limit: rule.limit } : {}, input, { mode: 'timed' }));
  if (!result.ok) return result;
  const ids = input.ruleIds === undefined ? [result.value.ruleId] : input.ruleIds;
  if (!Array.isArray(ids) || !ids.length || ids[0] !== result.value.ruleId || new Set(ids).size !== ids.length ||
      !ids.every(id => getRule(id) && getRule(id).grade === result.value.grade)) {
    return { ok: false, message: '请选择本年级一个或多个不同的题型' };
  }
  if (ids.length === 1 && result.value.ruleId === 'g2_multiply_table' && result.value.count > 45) {
    return { ok: false, message: '表内乘法去重后最多 45 题，请减少题量' };
  }
  const { grade, ruleId, count, durationSeconds } = result.value;
  return { ok: true, value: { grade, ruleId, ...(ids.length > 1 ? { ruleIds: ids.slice() } : {}), count, mode: 'timed', durationSeconds } };
}

function configSummary(config) {
  const display = getConfigDisplay(config);
  const labels = (config.ruleIds || [config.ruleId]).map(id => getRule(id).label).join('、');
  return [display.gradeLabel, labels, config.count + ' 道', config.durationSeconds + ' 秒'].join(' · ');
}

function viewRoom(room, demo = false) {
  const states = ['waiting', 'countdown', 'playing', 'awaiting_result', 'finished', 'cancelled', 'expired'];
  if (!room || !states.includes(room.status) || !Array.isArray(room.members) ||
      room.members.length < 1 || room.members.length > 2 || !Number.isSafeInteger(room.version) || room.version < 1 ||
      typeof room.roomId !== 'string' || !/^r_[a-f0-9]{40}$/.test(room.roomId) || !/^\d{6}$/.test(room.code) ||
      !room.config || room.config.mode !== 'timed' || !roomConfig(room.config).ok ||
      !Number.isFinite(room.createdAt) || !Number.isFinite(room.expiresAt) || room.expiresAt <= room.createdAt ||
      room.members.filter(member => member.isSelf === true).length !== 1 ||
      room.members.some(member => !['host', 'guest'].includes(member.role) || typeof member.ready !== 'boolean' || typeof member.isSelf !== 'boolean') ||
      room.members.filter(member => member.role === 'host').length !== 1) {
    const error = new Error('房间状态不完整，请刷新后重试'); error.code = 'INVALID_RESPONSE'; throw error;
  }
  const own = room.members.find(member => member.isSelf);
  if (room.selfRole !== own.role || ['countdown', 'playing', 'awaiting_result'].includes(room.status) &&
      (!Number.isFinite(room.startAt) || !Number.isFinite(room.endAt) || room.endAt <= room.startAt || room.members.length !== 2)) {
    const error = new Error('房间阶段与成员状态不一致，请刷新'); error.code = 'INVALID_RESPONSE'; throw error;
  }
  const partner = room.members.find(member => !member.isSelf);
  const allReady = room.members.length === 2 && room.members.every(member => member.ready);
  let stage = room.status;
  if (stage === 'waiting') stage = room.members.length === 1 ? 'waiting' : allReady ? 'both' : 'ready';
  const titles = { waiting: '等一位伙伴加入', ready: '两个人都准备好再开始', both: '准备好就开始吧',
    countdown: '比赛马上开始', playing: demo ? '演示已开赛' : '比赛已开始',
    awaiting_result: '答题时间结束，等待结算', finished: '本场比赛已结束', cancelled: '房间已关闭', expired: '房间已失效' };
  const slots = [own, partner].map((member, index) => ({
    key: index === 0 ? 'self' : 'partner', name: index === 0 ? '我' : member ? '伙伴' : '等待另一位伙伴',
    avatar: index === 0 ? '我' : member ? '伴' : '＋', empty: !member,
    roleLabel: member ? member.role === 'host' ? '房主' : '加入者' : '分享房间码邀请加入',
    ready: !!(member && member.ready), stateLabel: member ? member.ready ? '✓ 已准备' : room.members.length === 1 ? '已加入' : '未准备' : '空位'
  }));
  return { stage, title: titles[stage], slots, capacityText: room.members.length + ' / 2 人',
    ownReady: own.ready, isHost: own.role === 'host', allReady, summary: configSummary(room.config),
    canPrepare: room.status === 'waiting' && room.members.length === 2,
    canStart: (demo || !!(room.capabilities && room.capabilities.start)) && own.role === 'host' && allReady && room.status === 'waiting',
    canCancelStart: (demo || !!(room.capabilities && room.capabilities.cancelStart)) && room.status === 'countdown',
    active: ['waiting', 'countdown', 'playing'].includes(room.status) };
}

function roomError(error) {
  const code = error && error.code || 'CLOUD_CALL_FAILED';
  if (['ROOM_FULL'].includes(code)) return { stage: 'full', message: '这个房间已经满了，请检查房间码或创建新房间。' };
  if (['ROOM_NOT_FOUND', 'ROOM_EXPIRED', 'ROOM_CLOSED'].includes(code)) return { stage: 'expired', forgetRoom: true, message: '房间不存在、已关闭或已过期，请重新加入或创建。' };
  if (code === 'NOT_MEMBER') return { stage: 'entry', forgetRoom: true, message: '你已不在这个房间，请重新输入有效房间码加入。' };
  if (['CLOUD_CALL_FAILED', 'INVALID_RESPONSE', 'SERVICE_UNAVAILABLE'].includes(code)) {
    return { stage: 'offline', message: '暂时无法确认房间状态。成员和准备不会因断线清空，请重试连接。' };
  }
  const messages = {
    VERSION_CONFLICT: '房间状态已更新，请刷新后再次确认操作。',
    PENDING_REQUEST: '有操作尚未确认，请先重试原操作。',
    LOCAL_STORAGE_FAILED: '无法保存本机请求状态，暂不能继续操作，请检查存储空间。',
    AUTH_REQUIRED: '请使用已获开发或体验权限的微信账号打开本小程序。',
    CLOUD_UNSUPPORTED: '当前微信环境不支持连接房间，请更新微信或检查开发者工具。',
    ENV_NOT_CONFIGURED: '房间服务尚未配置，请联系组长。',
    FEATURE_NOT_READY: '当前服务暂未开放此功能，请刷新房间或联系组长。',
    STALE_RESPONSE: '已忽略旧操作的迟到响应，请按当前房间继续。'
  };
  return { message: messages[code] || error && error.message || '操作失败，请重试。' };
}

module.exports = { roomConfig, configSummary, viewRoom, roomError };
