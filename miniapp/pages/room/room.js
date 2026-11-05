const { createRoomClient } = require('../../utils/room-client');
const { createMockRoomClient } = require('../../utils/mock-room-client');
const { roomConfig, configSummary, viewRoom, roomError } = require('../../utils/room-view');
const { GRADES, getRule, getRulesForGrade, getGradeLabel } = require('../../utils/practice-rules');
const { DURATIONS } = require('../../utils/practice-config');
const { envId } = require('../../config/cloud');
const { parseAnswer } = require('../../utils/exact-answer');
const { saveRecord } = require('../../utils/record-store');
const { toRows } = require('../../utils/result-stats');
const { openPage } = require('../../utils/navigation');
const LAST_ROOM = 'room-p2.last-room.' + envId;
const SAVED_ROOM = 'room-p2.saved-room.' + envId;
const INITIAL_CONFIG = roomConfig().value;
const ACTIVE = ['waiting', 'countdown', 'playing'];
const POLL_MS = 1000;
const RESULT_POLL_MS = 3000;

function choicesFor(grade, ids) {
  return getRulesForGrade(grade).map(rule => ({ ...rule, selected: ids.includes(rule.id) }));
}

Page({
  data: {
    source: 'live', allowDemo: false, stage: 'create', title: '', room: null, slots: [],
    capacityText: '', summary: '', ownReady: false, isHost: true, canPrepare: false, canStart: false, canCancelStart: false,
    allReady: false, busy: false, error: '', notice: '', pendingAction: '', inputCode: '',
    inputError: '', config: INITIAL_CONFIG, configSummary: configSummary(INITIAL_CONFIG),
    editConfig: false, countText: '30', configError: '', grades: GRADES, durations: DURATIONS,
    ruleChoices: choicesFor(1, [INITIAL_CONFIG.ruleId]), countdown: 3, waitingSeconds: 600,
    phaseSeconds: 0, entry: 'create', savedRoomId: '', questionIndex: 0, currentQuestion: null,
    answerInput: '', answerLocked: false, answerError: '', submittedCount: 0, partnerCount: 0,
    selfFinished: false, partnerFinished: false, matchResult: null, resultRows: [], resultSaveText: '', resultSaved: false,
    canReturnMatch: false, outcomeText: '', questionChoices: []
  },
  onLoad(options = {}) {
    this._alive = true; this._visible = false; this._epoch = 0; this._clock = null; this._offset = 0;
    this._client = null; this._roomId = ''; this._busy = false; this._confirming = false;
    this._visibilityEpoch = 0; this._lastServerNow = 0; this._nextPollAt = 0;
    this._readEpoch = 0; this._polling = null;
    let allowDemo = false;
    try { allowDemo = options.mode === 'demo' && wx.getAccountInfoSync().miniProgram.envVersion === 'develop'; } catch (_) {}
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
    this._readEpoch++; this._polling = null;
    this.setData({ source, room: null, slots: [], summary: '', busy: false, pendingAction: '',
      error: '', notice: '', countdown: 3, stage: this.data.entry, editConfig: false });
    try {
      const client = this.getClient();
      this.updatePending();
      this._roomId = source === 'demo' ? client.lastRoomId() || '' : wx.getStorageSync(LAST_ROOM) || '';
      this.setData({ savedRoomId: source === 'live' ? wx.getStorageSync(SAVED_ROOM) || '' : '' });
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
    this.syncMatch(room);
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
  async perform(operation, successNotice = '') {
    if (!this._alive || this._busy) return;
    // 用户操作优先；正在返回的后台查询不再更新本次操作后的页面。
    this._readEpoch++;
    const epoch = this._epoch; this._busy = true;
    const visibilityEpoch = this._visibilityEpoch;
    this.setData({ busy: true, error: '', notice: '' });
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
      } else this.setData({ notice: data.event || (data.operation && data.operation.replayed
        ? '已确认原操作，未重复写入；显示的是当前房间状态。' : successNotice) });
    } catch (error) {
      if (!this._alive || epoch !== this._epoch) return;
      if (visibilityEpoch !== this._visibilityEpoch) { this._refreshOnIdle = true; return; }
      if (error.code === 'STALE_RESPONSE') {
        try { this._roomId = ''; this.updatePending(); this.restoreRoomId(); } catch (storageError) { this.applyError(storageError); return; }
      }
      if (['VERSION_CONFLICT', 'ATTEMPT_MISMATCH', 'MATCH_ALREADY_STARTED', 'INVALID_STATE', 'STALE_RESPONSE', 'MATCH_ENDED', 'ALREADY_FINISHED', 'ANSWER_LOCKED'].includes(error.code) && this._roomId) {
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
    if (quiet === true) return this.pollRoom();
    if (this._roomId) return this.perform(client => client.call('get', { roomId: this._roomId }), '已刷新房间状态。');
  },
  async pollRoom() {
    if (!this._alive || !this._visible || !this._roomId || this._busy || this._polling || this._confirming || this.data.pendingAction) return;
    const token = { epoch: this._epoch, visibility: this._visibilityEpoch, read: this._readEpoch, roomId: this._roomId };
    this._polling = token;
    const current = () => this._alive && this._visible && !this._busy && token.epoch === this._epoch &&
      token.visibility === this._visibilityEpoch && token.read === this._readEpoch && token.roomId === this._roomId;
    try {
      const response = await this.getClient().call('get', { roomId: token.roomId });
      if (current()) this.setRoom(response.data.room, response.serverNow);
    } catch (error) {
      if (current()) this.applyError(error);
    } finally {
      if (this._polling === token) this._polling = null;
    }
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
  syncMatch(room) {
    const questions = room.questions || [], progress = room.progress, self = progress && progress.self;
    const answers = self ? self.answers : [], partner = progress && progress.players.find(p => p.role !== room.selfRole);
    const changed = this._answerAttempt !== room.attemptId;
    if (changed || !this._draftAnswers) this._draftAnswers = {};
    this._answerAttempt = room.attemptId;
    const index = changed ? 0 : Math.min(this.data.questionIndex, Math.max(0, questions.length - 1));
    const current = questions[index] || null, submitted = current && answers.find(a => a.questionId === current.id);
    const result = room.result;
    this.setData({ questionIndex: index, currentQuestion: current, answerLocked: !!submitted,
      answerInput: submitted ? submitted.answer : current ? this._draftAnswers[current.id] || '' : '',
      questionChoices: questions.map(q => ({ id: q.id, label: q.index + (answers.some(a => a.questionId === q.id) ? ' · 已提交' : ' · 未提交') })),
      submittedCount: answers.length, partnerCount: partner ? partner.submitted : 0,
      selfFinished: !!(self && self.finished), partnerFinished: !!(partner && partner.finished),
      matchResult: result || null, resultRows: result ? toRows(result.items) : [],
      canReturnMatch: ['finished', 'awaiting_result'].includes(room.status) || !!(self && self.finished),
      outcomeText: result ? ({ win: '你赢了，继续加油！', lose: '这次伙伴领先，再练一练！', draw: '本场平局，都很努力！' })[result.outcome] : '' });
    if (result) this.saveMatchResult();
  },
  chooseQuestion(event) {
    const index = Number(event.detail.value), room = this.data.room;
    if (!room || !Number.isInteger(index) || !room.questions[index] || this._busy || this.data.pendingAction) return;
    const question = room.questions[index], accepted = room.progress.self.answers.find(a => a.questionId === question.id);
    this.setData({ questionIndex: index, currentQuestion: question, answerInput: accepted ? accepted.answer : this._draftAnswers[question.id] || '', answerLocked: !!accepted, answerError: '' });
  },
  nextQuestion() {
    const questions = this.data.room && this.data.room.questions || [];
    if (questions.length) this.chooseQuestion({ detail: { value: (this.data.questionIndex + 1) % questions.length } });
  },
  inputAnswer(event) {
    if (!this._busy && !this.data.answerLocked && this.data.currentQuestion) {
      const text = String(event.detail.value); this._draftAnswers[this.data.currentQuestion.id] = text;
      this.setData({ answerInput: text, answerError: '' });
    }
  },
  submitAnswer() {
    const room = this.data.room, question = this.data.currentQuestion;
    if (this._busy || this._confirming || this.data.pendingAction || !question || !room.capabilities.submitAnswer || this.data.answerLocked || this.data.selfFinished || room.status !== 'playing') return;
    const checked = parseAnswer(this.data.answerInput, question.answerKind);
    if (!checked.ok) { this.setData({ answerError: checked.message }); return; }
    this.setData({ answerError: '' });
    return this.perform(client => client.call('submitAnswer', { roomId: room.roomId, attemptId: room.attemptId, questionId: question.id, answer: checked.text }), '本题已提交并锁定，统一结算后查看对错。');
  },
  finishMatch() {
    const room = this.data.room;
    if (this._busy || this._confirming || this.data.pendingAction || !room || room.status !== 'playing' || this.data.selfFinished || !room.capabilities.finish) return;
    this._confirming = true; const epoch = this._epoch;
    wx.showModal({ title: '确认交卷？', content: '仅已确认提交的' + this.data.submittedCount + '道题计入作答。未提交输入不计分；交卷后不能继续答题，双方交卷或时间到后公布成绩。', confirmText: '确认交卷',
      success: result => {
        this._confirming = false;
        if (this._alive && epoch === this._epoch && result.confirm) this.perform(client => client.call('finish', { roomId: room.roomId, attemptId: room.attemptId }), '已交卷，等待伙伴或截止时间。');
      }, fail: () => { this._confirming = false; } });
  },
  saveMatchResult() {
    const room = this.data.room, result = room && room.result;
    if (!result || this._savedResultId === result.recordId) return;
    const saved = saveRecord({ practiceId: result.recordId, createdAt: result.finishedAt, ruleId: room.config.ruleId,
      ruleVersion: room.config.ruleVersion, config: room.config, configText: configSummary(room.config) + ' · 双人比赛',
      kind: 'match', match: { roomId: room.roomId, attemptId: room.attemptId, outcome: result.outcome, scores: result.scores, selfRole: result.selfRole, resultVersion: result.version }, items: result.items });
    if (saved.ok) this._savedResultId = result.recordId;
    this.setData({ resultSaved: saved.ok, resultSaveText: saved.ok ? '本人成绩已保存到本机记录。' : '本机保存失败，可重试：' + saved.error });
  },
  openMatchRecord() {
    if (!this.data.matchResult) return;
    this.saveMatchResult();
    if (this.data.resultSaved) openPage('/pages/result/result?id=' + encodeURIComponent(this.data.matchResult.recordId));
  },
  goHome() { wx.reLaunch({ url: '/pages/home/home' }); },
  backToMatchSettings() {
    if (this._busy || this._confirming || this.data.pendingAction || this.data.source !== 'live' || !this.data.canReturnMatch) return;
    const room = this.data.room;
    try { wx.setStorageSync(SAVED_ROOM, room.roomId); }
    catch (_) { this.applyError({ code: 'LOCAL_STORAGE_FAILED' }); return; }
    if (!this.showEntry('create', true)) return;
    const config = roomConfig(room.config).value, ruleChoices = choicesFor(config.grade, config.ruleIds || [config.ruleId]);
    this.setData({ savedRoomId: room.roomId, config, ruleChoices,
      countText: String(config.count),
      configSummary: configSummary(config), editConfig: true,
      notice: '已返回比赛设置。上一场比赛可通过下方入口重新查看。' });
  },
  resumeSavedRoom() {
    if (this._busy || this._confirming || this.data.pendingAction || this.hasActiveRoom() || this.data.source !== 'live' || !this.data.savedRoomId) return;
    const roomId = this.data.savedRoomId;
    return this.perform(async client => {
      const response = await client.call('get', { roomId });
      try { wx.setStorageSync(LAST_ROOM, roomId); }
      catch (_) { const error = new Error('无法保存恢复入口，请检查本机存储'); error.code = 'LOCAL_STORAGE_FAILED'; throw error; }
      return response;
    }, '已读取上一场比赛的当前状态。');
  },
  showEntry(stage, returnedMatch = false) {
    if (this._busy || this._confirming) return;
    if (this.data.pendingAction || this.hasActiveRoom() && !(returnedMatch && this.data.canReturnMatch)) {
      this.setData({ notice: '请先重试未确认操作，或恢复连接后退出原房间。' }); return;
    }
    if (this.data.source === 'live') {
      try { wx.removeStorageSync(LAST_ROOM); } catch (error) { this.applyError({ code: 'LOCAL_STORAGE_FAILED' }); return; }
    }
    this._roomId = ''; this.stopClock(); this._readEpoch++;
    this._lastServerNow = 0;
    this.setData({ stage, entry: stage, room: null, slots: [], summary: '', error: '', notice: '', inputError: '' });
    this.scrollToTop();
    return true;
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
    const labels = this.data.ruleChoices.filter(rule => rule.selected).map(rule => rule.label).join('、');
    this.setData({ configSummary: [getGradeLabel(this.data.config.grade), labels,
      countLabel, this.data.config.durationSeconds + ' 秒'].join(' · ') });
  },
  chooseGrade(event) {
    const grade = Number(event.currentTarget.dataset.value), rules = getRulesForGrade(grade);
    if (!rules.length || grade === this.data.config.grade) return;
    const previous = getRule(this.data.config.ruleId), rule = rules.find(item => item.operation === previous.operation) || rules[0];
    this.setData({ config: { ...this.data.config, grade, ruleId: rule.id, ruleIds: [rule.id] },
      ruleChoices: choicesFor(grade, [rule.id]), configError: '' });
    this.updateConfigPreview();
  },
  chooseRule(event) {
    const config = this.data.config, id = event.currentTarget.dataset.value;
    if (!this.data.ruleChoices.some(rule => rule.id === id)) return;
    const ids = (config.ruleIds || [config.ruleId]).slice();
    if (ids.includes(id) && ids.length === 1) {
      this.setData({ configError: '至少保留一个题型。' }); return;
    }
    const next = ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id];
    const ruleChoices = choicesFor(config.grade, next);
    const ruleIds = ruleChoices.filter(rule => rule.selected).map(rule => rule.id);
    this.setData({ config: { ...config, ruleId: ruleIds[0], ruleIds }, ruleChoices, configError: '' });
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
