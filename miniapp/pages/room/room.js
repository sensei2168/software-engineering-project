const { createRoomClient } = require('../../utils/room-client');
const { createMockRoomClient } = require('../../utils/mock-room-client');
const { roomConfig, configSummary, viewRoom, roomError } = require('../../utils/room-view');
const { GRADES, getRule, getRulesForGrade, getGradeLabel } = require('../../utils/practice-rules');
const { DURATIONS } = require('../../utils/practice-config');
const { envId } = require('../../config/cloud');
const LAST_ROOM = 'room-p2.last-room.' + envId;
const INITIAL_CONFIG = roomConfig().value;
const ACTIVE = ['waiting', 'countdown', 'playing'];
const POLL_MS = 1000;
const RESULT_POLL_MS = 3000;

Page({
  data: {
    source: 'live', allowDemo: false, stage: 'create', title: '', room: null, slots: [],
    capacityText: '', summary: '', ownReady: false, isHost: true, canPrepare: false, canStart: false, canCancelStart: false,
    allReady: false, busy: false, error: '', notice: '', pendingAction: '', inputCode: '',
    inputError: '', config: INITIAL_CONFIG, configSummary: configSummary(INITIAL_CONFIG),
    editConfig: false, countText: '30', configError: '', grades: GRADES, durations: DURATIONS,
    ruleChoices: getRulesForGrade(1), ruleIndex: 0, countdown: 3, waitingSeconds: 600,
    phaseSeconds: 0, entry: 'create'
  },
  onLoad(options = {}) {
    this._alive = true; this._visible = false; this._epoch = 0; this._clock = null; this._offset = 0;
    this._client = null; this._roomId = ''; this._busy = false; this._confirming = false;
    this._visibilityEpoch = 0; this._lastServerNow = 0; this._nextPollAt = 0;
    let allowDemo = false;
    try { allowDemo = ['develop', 'trial'].includes(wx.getAccountInfoSync().miniProgram.envVersion); } catch (_) {}
    const source = options.mode === 'demo' && allowDemo ? 'demo' : 'live';
    const code = typeof options.code === 'string' ? options.code : '';
    this.setData({ allowDemo, source, inputCode: code, stage: code ? 'join' : 'create', entry: code ? 'join' : 'create' });
    this.activate(source);
  },
  onShow() {
    this._visible = true;
    if (this._busy) { this._refreshOnIdle = true; return; }
    try { this.updatePending(); this.restoreRoomId(); } catch (error) { this.applyError(error); return; }
    if (this._roomId && !this.data.pendingAction) return this.refreshRoom();
    this.startClock();
  },
  onHide() { this._visible = false; this._visibilityEpoch++; this.stopClock(); },
  onUnload() { this._alive = false; this._visible = false; this._epoch++; this.stopClock(); },
  getClient() {
    if (!this._client) this._client = this.data.source === 'demo'
      ? createMockRoomClient({ wxApi: wx, now: () => Date.now() })
      : createRoomClient({ wxApi: wx });
    return this._client;
  },
  activate(source) {
    this.stopClock(); this._epoch++; this._client = null; this._roomId = ''; this._offset = 0;
    this._lastServerNow = 0; this._nextPollAt = 0;
    this.setData({ source, room: null, slots: [], summary: '', busy: false, pendingAction: '',
      error: '', notice: '', countdown: 3, stage: this.data.entry, editConfig: false });
    try {
      const client = this.getClient();
      this.updatePending();
      this._roomId = source === 'demo' ? client.lastRoomId() || '' : wx.getStorageSync(LAST_ROOM) || '';
      if (this.data.pendingAction) this.setData({ notice: '上次操作尚未确认，请先重试原操作，避免重复创建。' });
      else if (this._roomId) this.setData({ notice: '已找到上次房间，正在恢复当前状态。' });
    } catch (error) { this.applyError(error); }
  },
  hasActiveRoom() { return this.data.room && ACTIVE.includes(this.data.room.status) && !['expired', 'cancelled', 'full'].includes(this.data.stage); },
  switchSource() {
    if (!this.data.allowDemo || this._busy || this._confirming) return;
    if (this.data.pendingAction || this.hasActiveRoom()) {
      this.setData({ notice: '请先确认待处理操作并退出当前房间，再切换模式。' }); return;
    }
    this.activate(this.data.source === 'demo' ? 'live' : 'demo');
    if (this._roomId && !this.data.pendingAction) return this.refreshRoom();
  },
  updatePending() {
    const pending = this._client && this._client.pending();
    this.setData({ pendingAction: pending ? pending.action : '' });
  },
  restoreRoomId() {
    if (!this._roomId && !this.data.pendingAction) {
      this._roomId = this.data.source === 'demo' ? this.getClient().lastRoomId() || '' : wx.getStorageSync(LAST_ROOM) || '';
    }
  },
  setRoom(room, serverNow) {
    const view = viewRoom(room, this.data.source === 'demo');
    if (this.data.room && this.data.room.roomId === room.roomId &&
        (this.data.room.version > room.version || this.data.room.version === room.version && serverNow < this._lastServerNow)) return;
    const sameMembersView = ['waiting', 'ready', 'both'].includes(this.data.stage) && ['waiting', 'ready', 'both'].includes(view.stage);
    const changedView = this.data.stage !== view.stage && !sameMembersView;
    this._roomId = room.roomId; this._offset = serverNow - Date.now();
    this._lastServerNow = serverNow;
    this._nextPollAt = Date.now() + (room.status === 'awaiting_result' ? RESULT_POLL_MS : POLL_MS);
    this.setData({ room, ...view, error: '', editConfig: false });
    if (changedView) this.scrollToTop();
    this.startClock();
  },
  applyError(error) {
    const display = roomError(error), patch = { error: display.message };
    if (display.stage === 'entry') patch.stage = this.data.entry;
    else if (display.stage) patch.stage = display.stage;
    if (display.forgetRoom) {
      this._roomId = ''; patch.room = null; patch.slots = []; patch.summary = '';
      if (this.data.source === 'live') { try { wx.removeStorageSync(LAST_ROOM); } catch (_) {} }
    }
    this.stopClock(); this.setData(patch);
    if (patch.stage) this.scrollToTop();
  },
  async perform(operation, successNotice = '', quiet = false) {
    if (!this._alive || this._busy) return;
    const epoch = this._epoch; this._busy = true;
    const visibilityEpoch = this._visibilityEpoch;
    this.setData(quiet ? { busy: true } : { busy: true, error: '', notice: '' });
    try {
      const response = await operation(this.getClient());
      if (!this._alive || epoch !== this._epoch) return;
      if (visibilityEpoch !== this._visibilityEpoch) { this._refreshOnIdle = true; return; }
      const data = response.data;
      if (data.room) this.setRoom(data.room, response.serverNow);
      if (data.left) {
        this._roomId = ''; this.stopClock();
        this.setData({ room: null, slots: [], summary: '', stage: 'create', entry: 'create',
          notice: data.closed ? '已退出并关闭房间。' : '已退出房间，席位已释放。' });
      } else if (!quiet) this.setData({ notice: data.event || (data.operation && data.operation.replayed
        ? '已确认原操作，未重复写入；显示的是当前房间状态。' : successNotice) });
    } catch (error) {
      if (!this._alive || epoch !== this._epoch) return;
      if (visibilityEpoch !== this._visibilityEpoch) { this._refreshOnIdle = true; return; }
      if (error.code === 'STALE_RESPONSE') {
        try { this._roomId = ''; this.updatePending(); this.restoreRoomId(); } catch (storageError) { this.applyError(storageError); return; }
      }
      if (['VERSION_CONFLICT', 'ATTEMPT_MISMATCH', 'MATCH_ALREADY_STARTED', 'INVALID_STATE', 'STALE_RESPONSE'].includes(error.code) && this._roomId) {
        try {
          const response = await this.getClient().call('get', { roomId: this._roomId });
          if (!this._alive || epoch !== this._epoch) return;
          if (visibilityEpoch !== this._visibilityEpoch) { this._refreshOnIdle = true; return; }
          this.setRoom(response.data.room, response.serverNow);
          this.setData({ notice: '房间状态已更新，请查看后再次确认操作。' });
        } catch (refreshError) {
          if (this._alive && epoch === this._epoch && visibilityEpoch === this._visibilityEpoch) this.applyError(refreshError);
          else this._refreshOnIdle = true;
        }
      } else this.applyError(error);
    } finally {
      this._busy = false;
      if (this._alive && epoch === this._epoch) {
        try { this.updatePending(); this.restoreRoomId(); } catch (error) { this.applyError(error); }
        this.setData({ busy: false }); this.startClock();
        if (this._refreshOnIdle) { this._refreshOnIdle = false; if (this._visible && this._roomId && !this.data.pendingAction) this.refreshRoom(); }
      }
    }
  },
  refreshRoom(quiet = false) {
    if (this._roomId) return this.perform(client => client.call('get', { roomId: this._roomId }), '已刷新房间状态。', quiet === true);
  },
  retryConnection() {
    try { if (this.data.source === 'demo') this.getClient().reconnect(); }
    catch (error) { this.applyError(error); return; }
    if (this.data.pendingAction) return this.perform(client => client.retryPending(), '已确认原操作并恢复房间。');
    if (this._roomId) return this.refreshRoom();
    this.setData({ stage: this.data.entry, error: '', notice: '请检查连接后重新创建或加入房间。' });
  },
  openJoin() { this.showEntry('join'); },
  openCreate() { this.showEntry('create'); },
  showEntry(stage) {
    if (this._busy || this._confirming) return;
    if (this.data.pendingAction || this.hasActiveRoom()) {
      this.setData({ notice: '请先重试未确认操作，或恢复连接后退出原房间。' }); return;
    }
    this._roomId = ''; this.stopClock();
    if (this.data.source === 'live') {
      try { wx.removeStorageSync(LAST_ROOM); } catch (error) { this.applyError({ code: 'LOCAL_STORAGE_FAILED' }); return; }
    }
    this._lastServerNow = 0;
    this.setData({ stage, entry: stage, room: null, slots: [], summary: '', error: '', notice: '', inputError: '' });
    this.scrollToTop();
  },
  inputRoomCode(event) { this.setData({ inputCode: String(event.detail.value), inputError: '' }); },
  joinRoom() {
    if (this.data.pendingAction || this._busy) return;
    const code = this.data.inputCode.trim();
    if (!/^\d{6}$/.test(code)) { this.setData({ inputError: '请输入完整的6位数字房间码。' }); return; }
    return this.perform(client => client.call('join', { code }), this.data.source === 'demo' ? '模拟服务端已接受加入。' : '已加入伙伴的房间。');
  },
  createRoom() {
    if (this.data.pendingAction || this._busy) return;
    const checked = this.readConfig();
    if (checked) return this.perform(client => client.call('create', { config: checked }), '房间已创建，邀请一位伙伴加入吧。');
  },
  toggleReady() {
    if (!this.data.canPrepare || this.data.pendingAction || !['ready', 'both'].includes(this.data.stage)) return;
    const room = this.data.room;
    return this.perform(client => client.call('setReady', { roomId: room.roomId, expectedVersion: room.version,
      ready: !this.data.ownReady }), this.data.ownReady ? '已取消准备。' : '已准备，等待伙伴。');
  },
  startMatch() {
    if (!this.data.canStart || this.data.pendingAction || this.data.stage !== 'both') return;
    const room = this.data.room;
    return this.perform(client => client.call('start', { roomId: room.roomId, expectedVersion: room.version }), '双方准备，按统一时间开始。');
  },
  cancelStart() {
    if (!this.data.canCancelStart || this.data.stage !== 'countdown' || this.data.pendingAction) return;
    const room = this.data.room;
    return this.perform(client => client.call('cancelStart', { roomId: room.roomId, expectedVersion: room.version,
      attemptId: room.attemptId }), '已取消开始，保留两人、双方重新准备。');
  },
  leaveRoom() {
    if (!this.data.room || this._busy || this._confirming || this.data.pendingAction) return;
    if (this.data.room.status === 'playing') { this.setData({ notice: '比赛已经开始，请等待本局结束。' }); return; }
    if (!ACTIVE.includes(this.data.room.status)) { this.showEntry('create'); return; }
    const room = this.data.room, epoch = this._epoch;
    this._confirming = true;
    wx.showModal({ title: room.selfRole === 'host' ? '退出并关闭房间？' : '退出当前房间？',
      content: room.status === 'countdown' ? '倒计时中退出将取消本局，需重新创建房间。' :
        room.selfRole === 'host' ? '退出后，伙伴也无法继续使用这个房间。' : '退出后将释放席位，并清除房间内的准备状态。',
      success: result => {
        if (!this._alive || epoch !== this._epoch) return;
        this._confirming = false;
        if (result.confirm) this.perform(client => client.call('leave', { roomId: room.roomId, expectedVersion: room.version,
          ...(room.attemptId ? { attemptId: room.attemptId } : {}) }));
      }, fail: () => { this._confirming = false; }
    });
  },
  toggleConfig() {
    if (!this._busy && !this.data.pendingAction && !this.data.room) this.setData({ editConfig: !this.data.editConfig, configError: '' });
  },
  updateConfigPreview() {
    const text = this.data.countText.trim(), count = Number(text);
    const countLabel = /^\d+$/.test(text) && count >= 10 && count <= 50 ? count + ' 道' : '题量待确认';
    this.setData({ configSummary: [getGradeLabel(this.data.config.grade), getRule(this.data.config.ruleId).label,
      countLabel, this.data.config.durationSeconds + ' 秒'].join(' · ') });
  },
  chooseGrade(event) {
    const grade = Number(event.currentTarget.dataset.value), rules = getRulesForGrade(grade);
    if (!rules.length) return;
    const previous = getRule(this.data.config.ruleId), rule = rules.find(item => item.operation === previous.operation) || rules[0];
    this.setData({ config: { ...this.data.config, grade, ruleId: rule.id }, ruleChoices: rules,
      ruleIndex: rules.findIndex(item => item.id === rule.id), configError: '' });
    this.updateConfigPreview();
  },
  chooseRule(event) {
    const ruleIndex = Number(event.detail.value), rule = this.data.ruleChoices[ruleIndex];
    if (rule) this.setData({ config: { ...this.data.config, ruleId: rule.id }, ruleIndex, configError: '' });
    this.updateConfigPreview();
  },
  chooseDuration(event) {
    const durationSeconds = Number(event.currentTarget.dataset.value);
    if (DURATIONS.includes(durationSeconds)) this.setData({ config: { ...this.data.config, durationSeconds }, configError: '' });
    this.updateConfigPreview();
  },
  inputCount(event) { this.setData({ countText: String(event.detail.value), configError: '' }); this.updateConfigPreview(); },
  readConfig() {
    const text = this.data.countText.trim(), checked = /^\d+$/.test(text) && roomConfig({ ...this.data.config, count: Number(text) });
    if (!checked || !checked.ok) {
      this.setData({ editConfig: true, configError: checked && checked.message || '题量请输入10到50之间的整数。' }); return null;
    }
    this.setData({ config: checked.value, countText: String(checked.value.count), configSummary: configSummary(checked.value), configError: '', editConfig: false });
    return checked.value;
  },
  confirmConfig() { this.readConfig(); },
  async demoEvent(event) {
    if (this.data.source !== 'demo' || !this.data.allowDemo || this._busy) return;
    const name = event.currentTarget.dataset.event, epoch = this._epoch;
    try {
      const response = await this.getClient().simulate(name);
      if (!this._alive || epoch !== this._epoch) return;
      if (!response.data.disconnected) this.setRoom(response.data.room, response.serverNow);
      this.setData({ notice: response.data.event || '' });
    } catch (error) {
      if (this._alive && epoch === this._epoch) {
        if (error.code === 'CLOUD_CALL_FAILED') this.applyError(error);
        else this.setData({ error: error.message || '模拟事件未生效。' });
      }
    }
  },
  copyCode() {
    if (!this.data.room || this._busy) return;
    wx.setClipboardData({ data: this.data.room.code,
      success: () => { if (this._alive) this.setData({ notice: this.data.source === 'demo' ? '已复制演示房间码，只能用于模拟演示。' : '房间码已复制，分享给伙伴吧。' }); },
      fail: () => { if (this._alive) this.setData({ error: '未能复制，请长按上方房间码复制。' }); }
    });
  },
  endDemo() {
    if (this.data.source !== 'demo' || !this.data.allowDemo || this._busy || this._confirming || this.data.pendingAction) return;
    const epoch = this._epoch; this._confirming = true;
    wx.showModal({ title: '结束本次模拟演示？', content: '只清除本机模拟房间，真实房间不受影响。',
      success: result => {
        if (!this._alive || epoch !== this._epoch) return;
        this._confirming = false;
        if (!result.confirm) return;
        try {
          this.getClient().reset(); this._roomId = ''; this.stopClock();
          this.setData({ room: null, slots: [], summary: '', stage: 'create', entry: 'create', error: '', notice: '模拟演示已结束，可以重新创建或加入。' });
          this.scrollToTop();
        } catch (error) { this.applyError(error); }
      }, fail: () => { this._confirming = false; }
    });
  },
  onShareAppMessage() {
    const room = this.data.room;
    return this.data.source === 'live' && room && room.status === 'waiting'
      ? { title: '口算小搭档：邀请你参加双人小比赛', path: '/pages/room/room?code=' + room.code }
      : { title: '口算小搭档', path: '/pages/home/home' };
  },
  scrollToTop() {
    if (this._visible && typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  stopClock() { if (this._clock !== null) clearInterval(this._clock); this._clock = null; },
  startClock() {
    this.stopClock();
    if (!this._alive || !this._visible || this.data.stage === 'offline' || !this.data.room) return;
    this.updateClock();
    if (ACTIVE.includes(this.data.room.status) || this.data.room.status === 'awaiting_result') this._clock = setInterval(() => this.updateClock(), 250);
  },
  updateClock() {
    if (!this._visible || !this._alive || !this.data.room || this.data.stage === 'offline') return;
    const room = this.data.room, now = Date.now() + this._offset;
    if (room.status === 'countdown') this.setData({ countdown: Math.max(0, Math.ceil((room.startAt - now) / 1000)) });
    if (room.status === 'waiting') this.setData({ waitingSeconds: Math.max(0, Math.ceil((room.expiresAt - now) / 1000)) });
    if (room.status === 'playing') this.setData({ phaseSeconds: Math.max(0, Math.ceil((room.endAt - now) / 1000)) });
    const reached = room.status === 'countdown' && now >= room.startAt || room.status === 'waiting' && now >= room.expiresAt || room.status === 'playing' && now >= room.endAt;
    // 到边界读取阶段；不在页面自行宣布真实比赛开赛成功。
    const poll = this.data.source === 'live' && (ACTIVE.includes(room.status) || room.status === 'awaiting_result') && Date.now() >= this._nextPollAt;
    // 统一调度显示与查询；后台、离线及未确认写入期间停止自动查询，不自动重发写操作。
    if ((reached || poll) && !this._busy && !this._confirming && !this.data.pendingAction) {
      this._nextPollAt = Date.now() + (room.status === 'awaiting_result' ? RESULT_POLL_MS : POLL_MS);
      this.refreshRoom(true);
    }
  }
});
