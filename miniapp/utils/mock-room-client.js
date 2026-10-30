// 独立演示服务：只写本机 room-demo.v1，不调用云函数，不占用真实房间。
const { roomConfig } = require('./room-view');
const DEMO_KEY = 'room-demo.v1';
const COUNTDOWN_MS = 3000; // docs/07 CR09
const copy = value => JSON.parse(JSON.stringify(value));
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

function createMockRoomClient({ wxApi, now = Date.now }) {
  function load() {
    try { return wxApi.getStorageSync(DEMO_KEY) || { room: null, role: 'host', serial: 0, pending: null }; }
    catch (_) { fail('LOCAL_STORAGE_FAILED', '无法读取模拟房间'); }
  }
  let state = copy(load()), offline = false;
  function save(next) {
    try { wxApi.setStorageSync(DEMO_KEY, copy(next)); }
    catch (_) { fail('LOCAL_STORAGE_FAILED', '无法保存模拟房间'); }
    state = next;
  }
  function snapshot(source = state.room) {
    if (!source) fail('ROOM_NOT_FOUND', '模拟房间不存在');
    const room = copy(source);
    if (room.status === 'countdown' && now() >= room.startAt) room.status = 'playing';
    if (room.status === 'playing' && now() >= room.endAt) room.status = 'finished';
    if (room.status === 'waiting' && now() >= room.expiresAt) room.status = 'expired';
    room.selfRole = state.role;
    room.members = room.members.map(member => ({ ...member, isSelf: member.role === state.role }));
    return room;
  }
  function makeRoom(config, guest = false, code = '482731') {
    return { roomId: 'r_' + 'd'.repeat(40), code, status: 'waiting', version: 1,
      config, createdAt: now(), expiresAt: now() + 600000, attemptId: null, startAt: null, endAt: null,
      members: [{ role: 'host', ready: false }].concat(guest ? [{ role: 'guest', ready: false }] : []) };
  }
  function mutable(payload) {
    const room = snapshot();
    if (payload.roomId !== room.roomId) fail('ROOM_NOT_FOUND', '模拟房间不存在');
    if (room.status === 'expired') fail('ROOM_EXPIRED', '模拟房间已过期');
    if (room.status === 'cancelled') fail('ROOM_CLOSED', '模拟房间已关闭');
    if (payload.expectedVersion !== room.version) fail('VERSION_CONFLICT', '模拟房间状态已变化');
    return room;
  }
  function response(data) { return { ok: true, apiVersion: 1, serverNow: now(), data }; }
  async function invoke(request) {
    if (offline) fail('CLOUD_CALL_FAILED', '模拟网络中断，请重试原操作');
    const { action, payload } = request;
    let room, data, next = copy(state);
    try {
      if (action === 'get') {
        room = snapshot();
        if (payload.roomId !== room.roomId) fail('ROOM_NOT_FOUND', '模拟房间不存在');
        return response({ room });
      }
      if (action === 'create') {
        const config = roomConfig(payload.config);
        if (!config.ok) fail('INVALID_CONFIG', config.message);
        next.role = 'host'; next.room = makeRoom(config.value);
      } else if (action === 'join') {
        if (!/^\d{6}$/.test(payload.code)) fail('INVALID_ARGUMENT', '请输入6位数字房间码');
        if (payload.code === '111111') fail('ROOM_FULL', '模拟房间已满');
        if (payload.code === '222222') fail('ROOM_EXPIRED', '模拟房间已失效');
        if (!['482731', '012345', '333333'].includes(payload.code)) fail('ROOM_NOT_FOUND', '未找到这个模拟房间');
        if (payload.code === '333333' && !state.failedJoinOnce) {
          save({ ...state, failedJoinOnce: true }); offline = true;
          fail('CLOUD_CALL_FAILED', '模拟首次加入连接失败');
        }
        next.role = 'guest';
        next.room = makeRoom(roomConfig({ grade: 2, ruleId: 'g2_multiply_table', operation: 'multiply', limit: 81, count: 20 }).value, true, payload.code);
      } else {
        room = mutable(payload);
        const own = room.members.find(member => member.role === state.role);
        if (action === 'setReady') {
          if (room.status !== 'waiting') fail('INVALID_STATE', '当前不能修改准备');
          if (room.members.length !== 2) fail('NEED_TWO_MEMBERS', '请等待另一位伙伴');
          if (typeof payload.ready !== 'boolean') fail('INVALID_ARGUMENT', '准备状态无效');
          own.ready = payload.ready;
        } else if (action === 'start') {
          if (state.role !== 'host') fail('NOT_HOST', '只有房主可以开始');
          if (room.status !== 'waiting' || room.members.length !== 2 || !room.members.every(m => m.ready)) fail('NOT_READY', '需要双方准备');
          room.status = 'countdown'; room.attemptId = 'demo-attempt-' + (state.serial + 1);
          room.startAt = now() + COUNTDOWN_MS; room.endAt = room.startAt + room.config.durationSeconds * 1000;
        } else if (action === 'cancelStart') {
          if (room.status !== 'countdown') fail('INVALID_STATE', '已经开赛或取消，不能取消开始');
          room.status = 'waiting'; room.attemptId = null; room.startAt = null; room.endAt = null;
          room.members.forEach(m => { m.ready = false; });
        } else if (action === 'leave') {
          if (!['waiting', 'countdown'].includes(room.status)) fail('INVALID_STATE', '已开赛，退出规则需后续比赛接口接入');
          data = { roomId: room.roomId, left: true, closed: state.role === 'host' || room.status === 'countdown' };
          next.room = null;
        } else fail('UNKNOWN_ACTION', '模拟服务不支持该操作');
        if (!data) { room.version++; next.room = room; }
      }
      next.serial++; next.pending = null;
      save(next);
      return response(data || { room: snapshot(), operation: { requestId: request.requestId, replayed: false, appliedVersion: state.room.version } });
    } catch (error) {
      if (error.code !== 'CLOUD_CALL_FAILED') save({ ...state, pending: null });
      throw error;
    }
  }
  return {
    pending: () => copy(state.pending),
    lastRoomId: () => state.room && state.room.roomId,
    async call(action, payload = {}) {
      if (action === 'get') return invoke({ action, payload });
      if (state.pending) fail('PENDING_REQUEST', '模拟操作尚未确认，请先重试');
      const request = { action, payload: copy(payload), requestId: 'demo-' + now() + '-' + state.serial };
      save({ ...state, pending: request }); return invoke(request);
    },
    async retryPending() {
      if (!state.pending) fail('NO_PENDING_REQUEST', '没有尚未确认的模拟操作');
      return invoke(copy(state.pending));
    },
    reconnect() { offline = false; },
    async simulate(event) {
      if (event === 'disconnect') { offline = true; fail('CLOUD_CALL_FAILED', '模拟连接中断，原房间不变'); }
      const room = snapshot(), next = copy(state);
      if (event === 'switchRole') {
        if (room.members.length !== 2) fail('NEED_TWO_MEMBERS', '先模拟伙伴加入');
        next.role = state.role === 'host' ? 'guest' : 'host'; save(next);
        return response({ room: snapshot(), event: '已切换演示身份，未改变成员及各自准备状态。' });
      }
      let message;
      if (event === 'cancelStart') {
        if (room.status !== 'countdown') fail('INVALID_STATE', '模拟服务端拒绝取消：已开赛或不在倒计时');
        room.status = 'waiting'; room.attemptId = null; room.startAt = null; room.endAt = null;
        room.members.forEach(m => { m.ready = false; }); message = '参与者取消开始，保留两人并清除准备。';
      } else if (event === 'closeRoom') {
        if (!['waiting', 'countdown'].includes(room.status)) fail('INVALID_STATE', '模拟服务端拒绝关闭：已经开赛或结束');
        room.status = 'cancelled'; room.attemptId = null; room.startAt = null; room.endAt = null;
        room.members.forEach(m => { m.ready = false; }); message = '房主关闭原房间，旧批次作废。';
      } else if (event === 'hostStart') {
        if (room.status !== 'waiting' || room.members.length !== 2 || !room.members.every(m => m.ready)) fail('NOT_READY', '先让双方准备');
        room.status = 'countdown'; room.attemptId = 'demo-attempt-' + (state.serial + 1);
        room.startAt = now() + COUNTDOWN_MS; room.endAt = room.startAt + room.config.durationSeconds * 1000;
        message = '房主已开始，按同一开赛时间倒计时。';
      } else {
        if (room.status !== 'waiting') fail('INVALID_STATE', '当前不是准备阶段');
        if (event === 'partnerJoin') {
          if (room.members.length === 2) fail('ROOM_FULL', '模拟房间已有两名成员');
          room.members.forEach(m => { m.ready = false; }); room.members.push({ role: 'guest', ready: false });
          message = '伙伴已加入原房间。';
        } else if (event === 'partnerReady') {
          const partner = room.members.find(m => m.role !== state.role);
          if (!partner) fail('NEED_TWO_MEMBERS', '伙伴尚未加入');
          partner.ready = !partner.ready; message = '伙伴' + (partner.ready ? '已准备。' : '取消准备。');
        } else fail('UNKNOWN_ACTION', '未知模拟事件');
      }
      room.version++; room.lastEvent = '模拟服务端事件：' + message;
      next.room = room; next.serial++; save(next);
      return response({ room: snapshot(), event: room.lastEvent, disconnected: offline });
    }
  };
}
module.exports = { createMockRoomClient, DEMO_KEY, COUNTDOWN_MS };
