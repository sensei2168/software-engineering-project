const crypto = require('node:crypto');
const contract = require('./rules.generated.json');

const APP_ID = 'wxeeac1150bc72adb2';
const WAIT_MS = 10 * 60 * 1000;
const RETAIN_MS = 24 * 60 * 60 * 1000;
const COLLECTIONS = { rooms: 'room_p2_rooms', codes: 'room_p2_codes', requests: 'room_p2_requests' };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));

class RoomError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new RoomError(code, message); };
function fields(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', name + '必须是对象');
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) {
    // 只返回受限的字段名，绝不回显字段值、OPENID 或整个请求。
    const names = unexpected.slice(0, 5).map(key => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key) ? key : '[其他字段]');
    fail('INVALID_ARGUMENT', name + '包含不支持的字段：' + names.join('、'));
  }
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,96}$/.test(value)) fail('INVALID_ARGUMENT', '请求编号格式不正确');
  return value;
}
function roomId(value) {
  if (typeof value !== 'string' || !/^r_[a-f0-9]{40}$/.test(value)) fail('INVALID_ARGUMENT', '房间编号格式不正确');
  return value;
}
function roomCode(value) {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value)) fail('INVALID_ARGUMENT', '请输入 6 位数字房间码');
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_ARGUMENT', '缺少有效的房间版本，请刷新');
  return value;
}
function config(input) {
  fields(input, ['grade', 'ruleId', 'count', 'durationSeconds', 'mode', 'operation', 'limit'], '比赛配置');
  const rule = contract.rules.find(item => item.id === input.ruleId);
  if (!rule || rule.grade !== input.grade || (input.operation !== undefined && input.operation !== rule.operation) ||
      (input.limit !== undefined && input.limit !== rule.limit) || (input.mode !== undefined && input.mode !== 'timed') ||
      !Number.isInteger(input.count) || input.count < 10 || input.count > 50 || !contract.durations.includes(input.durationSeconds)) {
    fail('INVALID_CONFIG', '请检查年级、题型、10—50 道题量及 60／120／180 秒时长');
  }
  if (rule.id === 'g2_multiply_table' && input.count > 45) fail('QUESTION_POOL_INSUFFICIENT', '表内乘法去重后最多 45 题，请减少题量');
  return { grade: rule.grade, ruleId: rule.id, ruleVersion: contract.ruleVersion,
    count: input.count, mode: 'timed', durationSeconds: input.durationSeconds };
}
function parse(event) {
  // 平台可能附加 userInfo/tcbContext；只忽略它们，身份仍取 getWXContext。
  fields(event, ['action', 'payload', 'requestId', 'userInfo', 'tcbContext'], '请求');
  const action = event.action, payload = event.payload === undefined ? {} : event.payload;
  if (action === 'whoami') { fields(payload, [], '身份查询'); return { action, payload: {} }; }
  if (action === 'get') {
    fields(payload, ['roomId'], '查询参数'); return { action, payload: { roomId: roomId(payload.roomId) } };
  }
  if (action === 'start' || action === 'cancelStart' || action === 'submitAnswer' || action === 'finish') {
    fail('FEATURE_NOT_READY', '当前阶段只提供房间基础接口，开赛与裁判尚未接入');
  }
  if (!['create', 'join', 'setReady', 'leave'].includes(action)) fail('UNKNOWN_ACTION', '不支持的房间操作');
  const id = requestId(event.requestId);
  if (action === 'create') {
    fields(payload, ['config'], '创建参数'); return { action, requestId: id, payload: { config: config(payload.config) } };
  }
  if (action === 'join') {
    fields(payload, ['code'], '加入参数'); return { action, requestId: id, payload: { code: roomCode(payload.code) } };
  }
  if (action === 'setReady' || action === 'leave') {
    fields(payload, action === 'setReady' ? ['roomId', 'expectedVersion', 'ready'] : ['roomId', 'expectedVersion'], '房间操作');
    const value = { roomId: roomId(payload.roomId), expectedVersion: version(payload.expectedVersion) };
    if (action === 'setReady') {
      if (typeof payload.ready !== 'boolean') fail('INVALID_ARGUMENT', '准备状态必须是布尔值');
      value.ready = payload.ready;
    }
    return { action, requestId: id, payload: value };
  }
  fail('UNKNOWN_ACTION', '不支持的房间操作');
}

function createRoomService({ store, now = Date.now, randomCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0'), logError = () => {} }) {
  function identity(context) {
    if (!context || context.APPID !== APP_ID || typeof context.OPENID !== 'string' || !context.OPENID) {
      fail('AUTH_REQUIRED', '请从本小程序以真实微信身份调用');
    }
    return hash(context.APPID + ':' + context.OPENID);
  }
  function member(room, userId) {
    const item = room.members.find(entry => entry.userId === userId);
    if (!item) fail('NOT_MEMBER', '你不是该房间成员');
    return item;
  }
  function state(room, time) { return room.status === 'waiting' && time >= room.expiresAt ? 'expired' : room.status; }
  function available(room, time) {
    if (!room || time >= room.purgeAt) fail('ROOM_NOT_FOUND', '房间不存在或记录已过期');
    return room;
  }
  function snapshot(room, userId, time) {
    const own = member(room, userId);
    return { roomId: room.roomId, code: room.code, status: state(room, time), version: room.version,
      config: copy(room.config), createdAt: room.createdAt, expiresAt: room.expiresAt,
      attemptId: null, startAt: null, endAt: null, selfRole: own.role,
      members: room.members.map(item => ({ role: item.role, ready: item.ready, isSelf: item.userId === userId })) };
  }
  async function get(tx, id, userId) {
    const room = available(await tx.get(COLLECTIONS.rooms, id), now());
    member(room, userId); return room;
  }
  function mustWait(room) {
    if (state(room, now()) === 'expired') fail('ROOM_EXPIRED', '房间等待时间已结束，请重新创建');
    if (room.status !== 'waiting') fail('ROOM_CLOSED', '房间已关闭');
  }
  function checkVersion(room, expected) {
    if (room.version !== expected) fail('VERSION_CONFLICT', '房间已变化，请刷新后重新操作');
  }
  async function write(tx, room) { await tx.set(COLLECTIONS.rooms, room.roomId, room); }

  async function mutate(input, userId) {
    const key = hash(userId + ':' + input.requestId);
    const fingerprint = hash(JSON.stringify({ action: input.action, payload: input.payload }));
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = input.action === 'create' ? roomCode(randomCode()) : null;
      try {
        return await store.transaction(async tx => {
          const previous = await tx.get(COLLECTIONS.requests, key);
          if (previous) {
            if (previous.fingerprint !== fingerprint) fail('REQUEST_CONFLICT', '该请求编号已用于其他操作');
            if (now() >= previous.purgeAt) fail('REQUEST_EXPIRED', '该操作的重试期限已过，请刷新房间');
            if (previous.left) return { roomId: previous.roomId, left: true, closed: previous.closed,
              operation: { requestId: input.requestId, replayed: true, appliedVersion: previous.appliedVersion } };
            const room = await get(tx, previous.roomId, userId);
            return { room: snapshot(room, userId, now()), operation: {
              requestId: input.requestId, replayed: true, appliedVersion: previous.appliedVersion } };
          }
          let room, left = false, closed = false;
          if (input.action === 'create') {
            const occupied = await tx.get(COLLECTIONS.codes, candidate);
            if (occupied && now() < occupied.expiresAt) fail('CODE_COLLISION', '房间码冲突');
            const time = now(), id = 'r_' + key.slice(0, 40);
            room = { roomId: id, code: candidate, schemaVersion: 1, status: 'waiting', version: 1,
              config: input.payload.config, members: [{ userId, role: 'host', ready: false }],
              createdAt: time, expiresAt: time + WAIT_MS, purgeAt: time + WAIT_MS + RETAIN_MS };
            await write(tx, room);
            await tx.set(COLLECTIONS.codes, candidate, { roomId: id, expiresAt: room.expiresAt });
          } else if (input.action === 'join') {
            const mapping = await tx.get(COLLECTIONS.codes, input.payload.code);
            if (!mapping) fail('ROOM_NOT_FOUND', '房间码不存在');
            if (now() >= mapping.expiresAt) fail('ROOM_EXPIRED', '房间码已失效');
            room = available(await tx.get(COLLECTIONS.rooms, mapping.roomId), now());
            mustWait(room);
            if (!room.members.some(item => item.userId === userId)) {
              if (room.members.length >= 2) fail('ROOM_FULL', '房间已有两名成员');
              room.members.forEach(item => { item.ready = false; });
              room.members.push({ userId, role: 'guest', ready: false }); room.version++;
              await write(tx, room);
            }
          } else {
            room = await get(tx, input.payload.roomId, userId);
            mustWait(room); checkVersion(room, input.payload.expectedVersion);
            const own = member(room, userId);
            if (input.action === 'setReady') {
              if (room.members.length !== 2) fail('NEED_TWO_MEMBERS', '请等待另一位成员加入');
              if (own.ready !== input.payload.ready) { own.ready = input.payload.ready; room.version++; await write(tx, room); }
            } else {
              left = true; closed = own.role === 'host'; room.version++;
              if (closed) {
                room.status = 'cancelled'; room.closedAt = now(); room.purgeAt = room.closedAt + RETAIN_MS;
                room.members.forEach(item => { item.ready = false; });
                const mapping = await tx.get(COLLECTIONS.codes, room.code);
                if (mapping && mapping.roomId === room.roomId) await tx.set(COLLECTIONS.codes, room.code, { ...mapping, expiresAt: now() });
              } else {
                room.members = room.members.filter(item => item.userId !== userId).map(item => ({ ...item, ready: false }));
              }
              await write(tx, room);
            }
          }
          await tx.set(COLLECTIONS.requests, key, { fingerprint, roomId: room.roomId,
            appliedVersion: room.version, left, closed, purgeAt: room.purgeAt });
          const operation = { requestId: input.requestId, replayed: false, appliedVersion: room.version };
          return left ? { roomId: room.roomId, left, closed, operation } : { room: snapshot(room, userId, now()), operation };
        });
      } catch (error) {
        if (!(error instanceof RoomError) || error.code !== 'CODE_COLLISION') throw error;
      }
    }
    fail('ROOM_CODE_BUSY', '暂时无法分配房间码，请稍后重试');
  }

  return async function handle(event, context) {
    try {
      const userId = identity(context), input = parse(event);
      let data;
      if (input.action === 'whoami') {
        data = { userId, appId: APP_ID, environmentId: typeof context.ENV === 'string' ? context.ENV : '',
          stage: 'p2-room-foundation', ruleVersion: contract.ruleVersion };
      } else if (input.action === 'get') {
        data = await store.transaction(async tx => ({ room: snapshot(await get(tx, input.payload.roomId, userId), userId, now()) }));
      } else data = await mutate(input, userId);
      return { ok: true, apiVersion: 1, serverNow: now(), data };
    } catch (error) {
      if (error instanceof RoomError) return { ok: false, apiVersion: 1, serverNow: now(), error: { code: error.code, message: error.message } };
      // 不把请求正文、OPENID 或云数据库内部错误返回给客户端。
      logError('room-service-storage-failure');
      return { ok: false, apiVersion: 1, serverNow: now(), error: {
        code: 'SERVICE_UNAVAILABLE', message: '房间服务暂不可用，请检查部署或稍后重试；重试沿用原请求编号' } };
    }
  };
}

module.exports = { createRoomService, COLLECTIONS, APP_ID, WAIT_MS, RETAIN_MS };
