const { createRoomClient } = require('../../utils/room-client');
const ENV_KEY = 'room-p2.environment';
const LAST_ROOM = 'room-p2.last-room.';

// 这是开发联调入口，不连接模拟后端，也不放到家长／学生首页。
Page({
  data: { allowed: false, envId: '', code: '', lookupRoomId: '', identity: null, room: null,
    busy: false, error: '', message: '', pendingAction: '', serverTime: '', selfReady: false },
  onLoad() {
    const info = wx.getAccountInfoSync();
    const allowed = ['develop', 'trial'].includes(info.miniProgram && info.miniProgram.envVersion);
    this.setData({ allowed });
    if (!allowed) return;
    try { this.setData({ envId: wx.getStorageSync(ENV_KEY) || '' }); }
    catch (_) { this.setData({ error: '无法读取本机设置，请检查存储空间' }); }
  },
  inputEnv(event) { this.setData({ envId: event.detail.value.trim(), identity: null, room: null, pendingAction: '' }); this.client = null; },
  inputCode(event) { this.setData({ code: event.detail.value.trim() }); },
  inputRoomId(event) { this.setData({ lookupRoomId: event.detail.value.trim() }); },
  getClient() {
    if (!this.client) {
      this.client = createRoomClient({ wxApi: wx, envId: this.data.envId });
      wx.setStorageSync(ENV_KEY, this.data.envId);
    }
    return this.client;
  },
  async perform(operation) {
    if (!this.data.allowed || this.data.busy) return;
    this.setData({ busy: true, error: '', message: '' });
    try {
      const client = this.getClient();
      const response = await operation(client);
      const data = response.data;
      const patch = { serverTime: new Date(response.serverNow).toISOString(), message: '已收到云函数确认' };
      if (data.userId) {
        patch.identity = data;
        patch.lookupRoomId = wx.getStorageSync(LAST_ROOM + this.data.envId) || this.data.lookupRoomId;
      }
      if (data.room) {
        patch.room = data.room; patch.lookupRoomId = data.room.roomId;
        const own = data.room.members.find(item => item.isSelf); patch.selfReady = !!(own && own.ready);
        if (data.operation && data.operation.replayed) patch.message = '已确认原操作，未重复创建或写入；下方为当前房间状态';
      }
      if (data.left) {
        patch.room = null; patch.lookupRoomId = ''; patch.selfReady = false;
        patch.message = data.closed ? '已退出并关闭房间' : '已退出房间';
      }
      this.setData(patch);
    } catch (error) {
      this.setData({ error: (error.code ? error.code + '：' : '') + (error.message || '操作失败，请重试') });
    } finally {
      let pendingAction = '';
      try { const pending = this.client && this.client.pending(); pendingAction = pending ? pending.action : ''; }
      catch (_) { this.setData({ error: '本机请求状态无法读取，请检查存储' }); }
      this.setData({ busy: false, pendingAction });
    }
  },
  identify() { return this.perform(client => client.call('whoami')); },
  createTestRoom() {
    return this.perform(client => client.call('create', { config: { grade: 1, ruleId: 'g1_add_20', count: 10, durationSeconds: 60 } }));
  },
  joinRoom() { return this.perform(client => client.call('join', { code: this.data.code })); },
  refreshRoom() { return this.perform(client => client.call('get', { roomId: this.data.lookupRoomId })); },
  toggleReady() {
    if (!this.data.room) return;
    return this.perform(client => client.call('setReady', { roomId: this.data.room.roomId,
      expectedVersion: this.data.room.version, ready: !this.data.selfReady }));
  },
  retryOperation() { return this.perform(client => client.retryPending()); },
  leaveRoom() {
    if (!this.data.room || this.data.busy) return;
    const room = this.data.room;
    wx.showModal({ title: room.selfRole === 'host' ? '退出并关闭测试房间？' : '退出测试房间？',
      content: room.selfRole === 'host' ? '另一位成员也将无法继续准备。' : '退出后将释放你的席位。',
      success: result => { if (result.confirm) this.perform(client => client.call('leave', {
        roomId: room.roomId, expectedVersion: room.version })); }
    });
  }
});
