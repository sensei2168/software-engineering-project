const test = require('node:test');
const assert = require('node:assert/strict');
const { roomPageFixture, event, settle } = require('./helpers/room-page-fixture.cjs');
const { envId } = require('../miniapp/config/cloud');

async function demo() { const s = roomPageFixture(), p = s.load({ mode: 'demo' }); await s.show(p); return { s, p }; }
async function pair(s, p) { await p.createRoom(); await s.demo(p, 'partnerJoin'); }
async function both(s, p) { await pair(s, p); await p.toggleReady(); await s.demo(p, 'partnerReady'); }

test('public entry defaults to live; demo requires explicit development or trial opt-in', async () => {
  const s = roomPageFixture(), p = s.load(); await s.show(p);
  assert.equal(p.data.source, 'live'); assert.equal(p.data.stage, 'create'); assert.equal(s.requests.length, 0);
  const release = roomPageFixture({ envVersion: 'release' }), r = release.load({ mode: 'demo' });
  assert.equal(r.data.allowDemo, false); assert.equal(r.data.source, 'live'); r.switchSource(); assert.equal(r.data.source, 'live');
  assert.equal(roomPageFixture({ envVersion: 'trial' }).load({ mode: 'demo' }).data.source, 'demo');
});
test('configuration edits use the rule catalog, validate counts and preserve chosen settings in a room', async () => {
  const { s, p } = await demo(); p.chooseGrade(event(3)); p.chooseRule({ detail: { value: 6 } });
  p.chooseDuration(event(60)); p.inputCount({ detail: { value: '20' } }); await p.createRoom();
  assert.equal(p.data.room.config.ruleId, 'g3_fraction_same_den'); assert.equal(p.data.room.config.durationSeconds, 60);
  assert.equal(p.data.room.config.count, 20); assert.equal(s.requests.length, 0);
  const second = await demo();
  for (const count of ['', '9', '51', '20.5']) {
    second.p.inputCount({ detail: { value: count } }); await second.p.createRoom(); assert.ok(second.p.data.configError); assert.equal(second.p.data.room, null);
  }
});
test('creating and waiting uses an actual snapshot, and each role controls only itself', async () => {
  const { s, p } = await demo(); await pair(s, p); await p.toggleReady();
  assert.equal(p.data.stage, 'ready'); assert.equal(p.data.ownReady, true); assert.equal(p.data.canStart, false);
  await s.demo(p, 'switchRole'); assert.equal(p.data.isHost, false); assert.equal(p.data.ownReady, false);
  await p.toggleReady(); assert.equal(p.data.stage, 'both'); assert.equal(p.data.canStart, false);
  await p.startMatch(); assert.equal(p.data.stage, 'both');
  await s.demo(p, 'hostStart'); assert.equal(p.data.stage, 'countdown');
});
test('room-code validation preserves leading zero and explicit business errors', async () => {
  const { p } = await demo(); p.openJoin();
  for (const code of ['', '12345', '1234567', '12a456']) {
    p.inputRoomCode({ detail: { value: code } }); await p.joinRoom(); assert.ok(p.data.inputError);
  }
  p.inputRoomCode({ detail: { value: '111111' } }); await p.joinRoom(); assert.equal(p.data.stage, 'full');
  p.openJoin(); p.inputRoomCode({ detail: { value: '222222' } }); await p.joinRoom(); assert.equal(p.data.stage, 'expired');
  p.openJoin(); p.inputRoomCode({ detail: { value: '012345' } }); await p.joinRoom();
  assert.equal(p.data.room.code, '012345'); assert.equal(p.data.isHost, false);
});
test('R1 ready reconnect preserves both people and each readiness flag', async () => {
  const { s, p } = await demo(); await pair(s, p); await p.toggleReady();
  await s.demo(p, 'disconnect'); assert.equal(p.data.stage, 'offline');
  await p.retryConnection(); assert.equal(p.data.capacityText, '2 / 2 人');
  assert.equal(p.data.ownReady, true); assert.equal(p.data.slots[1].ready, false);
});
test('R1 countdown reconnect continues original startAt and does not restart three seconds', async () => {
  const { s, p } = await demo(); await both(s, p); await p.startMatch(); const startAt = p.data.room.startAt;
  await s.advance(1000); await s.demo(p, 'disconnect');
  await s.demo(p, 'switchRole'); assert.equal(p.data.stage, 'offline');
  await p.retryConnection();
  assert.equal(p.data.room.startAt, startAt); assert.equal(p.data.countdown, 2); assert.equal(p.data.capacityText, '2 / 2 人');
  await s.advance(2000); assert.equal(p.data.stage, 'playing');
});
test('offline time passes through playing and finished without fake scores or a new waiting room', async () => {
  const { s, p } = await demo(); await both(s, p); await p.startMatch(); await s.demo(p, 'disconnect');
  await s.advance(4000); await p.retryConnection(); assert.equal(p.data.stage, 'playing');
  await s.demo(p, 'disconnect'); await s.advance(120000); await p.retryConnection();
  assert.equal(p.data.stage, 'finished'); assert.equal(p.data.room.members.length, 2);
});
test('cancel while disconnected requires an explicit event and invalidates the old batch', async () => {
  const { s, p } = await demo(); await both(s, p); await p.startMatch(); const old = p.data.room.attemptId;
  await s.demo(p, 'disconnect'); await s.demo(p, 'cancelStart'); assert.equal(p.data.stage, 'offline'); assert.match(p.data.notice, /模拟服务端事件/);
  await s.advance(4000); await p.retryConnection(); assert.equal(p.data.stage, 'ready');
  assert.match(p.data.notice, /模拟服务端事件.*取消开始/);
  assert.equal(p.data.capacityText, '2 / 2 人'); assert.equal(p.data.slots.every(m => !m.ready), true);
  await p.toggleReady(); await s.demo(p, 'partnerReady'); await p.startMatch();
  assert.equal(p.data.countdown, 3); assert.notEqual(p.data.room.attemptId, old);
});
test('explicit server close cannot revive an old countdown; late cancellation is rejected', async () => {
  const { s, p } = await demo(); await both(s, p); await p.startMatch(); await s.demo(p, 'disconnect');
  await s.demo(p, 'closeRoom'); await p.retryConnection(); await s.advance(4000);
  assert.equal(p.data.stage, 'cancelled'); assert.equal(s.timers(), 0);
  const second = await demo(); await both(second.s, second.p); await second.p.startMatch(); await second.s.advance(3000);
  await second.s.demo(second.p, 'cancelStart'); assert.equal(second.p.data.stage, 'playing'); assert.match(second.p.data.error, /拒绝取消/);
});
test('hide and unload clean timers; returning or reopening uses original room and current phase', async () => {
  const { s, p } = await demo(); await both(s, p); await p.startMatch(); const startAt = p.data.room.startAt;
  p.onHide(); assert.equal(s.timers(), 0); await s.advance(4000); await s.show(p);
  assert.equal(p.data.stage, 'playing'); assert.equal(p.data.room.startAt, startAt);
  p.onUnload(); assert.equal(s.timers(), 0);
  const second = s.load({ mode: 'demo' }); await s.show(second);
  assert.equal(second.data.stage, 'playing'); assert.equal(second.data.room.startAt, startAt);
});
test('exit requires a confirmation, cancel keeps room, and demo never shares a fake invitation', async () => {
  const { s, p } = await demo(); await p.createRoom(); const room = p.data.room;
  p.leaveRoom(); assert.ok(s.modal()); assert.equal(p.data.room.roomId, room.roomId);
  await s.confirm(false); assert.equal(p.data.stage, 'waiting');
  assert.equal(p.onShareAppMessage().path, '/pages/home/home');
  p.copyCode(); assert.equal(s.clipboard(), room.code); assert.match(p.data.notice, /演示/);
  p.leaveRoom(); await s.confirm(true); assert.equal(p.data.room, null); assert.equal(p.data.stage, 'create');
});
test('real client connects create, join, prepare, refresh and confirmed leave; live start stays unavailable', async () => {
  const s = roomPageFixture(), p = s.load(); await s.show(p); await p.createRoom();
  const id = p.data.room.roomId, code = p.data.room.code;
  await s.backend.call('b', 'join', { code }); await p.refreshRoom(); await p.toggleReady();
  await s.backend.call('b', 'setReady', { roomId: id, expectedVersion: p.data.room.version, ready: true }); await p.refreshRoom();
  assert.equal(p.data.stage, 'both'); assert.equal(p.data.canStart, false); await p.startMatch();
  assert.equal(s.requests.some(r => r.action === 'start'), false); assert.equal(p.onShareAppMessage().path, '/pages/room/room?code=' + code);
  p.leaveRoom(); await s.confirm(true); assert.equal(p.data.room, null); assert.equal(p.data.notice, '已退出并关闭房间。');
});
test('real lost response is retried with the same request, even after page recreation', async () => {
  const s = roomPageFixture(), p = s.load(); await s.show(p); s.state.loseResponse = true; await p.createRoom();
  assert.equal(p.data.source, 'live'); assert.equal(p.data.stage, 'offline'); assert.equal(p.data.pendingAction, 'create'); assert.equal(s.backend.count(), 1);
  p.switchSource(); assert.equal(p.data.source, 'live'); p.onUnload();
  const second = s.load(); await s.show(second); await second.retryConnection();
  assert.equal(second.data.stage, 'waiting'); assert.equal(s.backend.count(), 1);
  assert.equal(s.requests.at(-1).requestId, s.requests[0].requestId); assert.equal(second.data.pendingAction, '');
});
test('version conflict refreshes current room and asks for reconfirmation instead of overwriting', async () => {
  const s = roomPageFixture(), p = s.load(); await s.show(p); await p.createRoom();
  await s.backend.call('b', 'join', { code: p.data.room.code }); await p.refreshRoom();
  await s.backend.call('b', 'setReady', { roomId: p.data.room.roomId, expectedVersion: p.data.room.version, ready: true });
  await p.toggleReady(); assert.match(p.data.notice, /再次确认/);
  assert.equal(p.data.ownReady, false); assert.equal(p.data.slots[1].ready, true);
  await p.toggleReady(); assert.equal(p.data.stage, 'both');
});
test('network errors never create demo members or clear original ready state', async () => {
  const s = roomPageFixture(), p = s.load(); await s.show(p); await p.createRoom();
  await s.backend.call('b', 'join', { code: p.data.room.code }); await p.refreshRoom(); await p.toggleReady();
  s.state.rejectCloud = true; await p.refreshRoom(); assert.equal(p.data.stage, 'offline'); assert.equal(p.data.ownReady, true);
  assert.equal(p.data.source, 'live'); assert.equal(p.data.room.members.length, 2);
  s.state.rejectCloud = false; await p.retryConnection(); assert.equal(p.data.stage, 'ready'); assert.equal(p.data.ownReady, true);
});
test('non-member denial clears protected view and recovery ID; expired snapshot allows a new entry', async () => {
  const s = roomPageFixture(), p = s.load(); await s.show(p); await p.createRoom();
  s.state.response = { ok: false, apiVersion: 1, serverNow: s.backend.time(), error: { code: 'NOT_MEMBER', message: 'not member' } };
  await p.refreshRoom(); assert.equal(p.data.room, null); assert.deepEqual(p.data.slots, []); assert.equal(s.values.has('room-p2.last-room.' + envId), false);
  s.state.response = null; await p.createRoom(); await s.advance(600000);
  assert.equal(p.data.stage, 'expired'); p.openCreate(); assert.equal(p.data.stage, 'create');
});
test('double tap, leaving during requests, and late responses after unload cannot duplicate or update a dead page', async () => {
  const s = roomPageFixture(), p = s.load(); await s.show(p); let release;
  s.state.gate = new Promise(resolve => { release = resolve; });
  const creating = p.createRoom(); await p.createRoom(); p.leaveRoom(); assert.equal(s.requests.length, 1); assert.equal(s.modal(), undefined);
  p.onUnload(); release(); await creating; await settle(); assert.equal(p.data.room, null); assert.equal(s.timers(), 0); assert.equal(s.backend.count(), 1);
});
test('storage failure prevents real writes and invitation links only prefill join input', async () => {
  const s = roomPageFixture(), p = s.load({ code: '012345' }); await s.show(p);
  assert.equal(p.data.stage, 'join'); assert.equal(p.data.inputCode, '012345'); assert.equal(s.requests.length, 0);
  s.state.storageFailure = true; await p.createRoom(); assert.match(p.data.error, /存储|保存/); assert.equal(s.requests.length, 0);
});
test('starting from a scrolled room and showing connection failure bring the new state into view', async () => {
  const { s, p } = await demo(); await both(s, p); s.scrolls.length = 0;
  await p.startMatch(); assert.deepEqual(s.scrolls, [0]);
  s.scrolls.length = 0; await s.demo(p, 'disconnect'); assert.deepEqual(s.scrolls, [0]);
});
test('configuration summary follows the visible draft instead of showing the previous grade and count', async () => {
  const { p } = await demo(); p.toggleConfig(); p.chooseGrade(event(3)); p.chooseRule({ detail: { value: 6 } });
  p.inputCount({ detail: { value: '20' } }); p.chooseDuration(event(60));
  assert.equal(p.data.configSummary, '三年级 · 分数加减 · 20 道 · 60 秒');
  p.inputCount({ detail: { value: '' } }); assert.match(p.data.configSummary, /题量待确认/);
});
test('ending an active demo is explicit, does not touch live recovery and permits a fresh run', async () => {
  const { s, p } = await demo(); s.values.set('room-p2.last-room.' + envId, 'untouched-live-room');
  await both(s, p); await p.startMatch(); await s.advance(3000); assert.equal(p.data.stage, 'playing');
  p.endDemo(); await s.confirm(false); assert.equal(p.data.stage, 'playing');
  p.endDemo(); await s.confirm(true); assert.equal(p.data.stage, 'create'); assert.equal(s.timers(), 0);
  assert.equal(s.values.get('room-p2.last-room.' + envId), 'untouched-live-room');
  await both(s, p); await p.startMatch(); assert.equal(p.data.countdown, 3); assert.equal(s.requests.length, 0);
});
test('RP12: preparation never consumes the selected 120 seconds; late reconnect reflects elapsed play time', async () => {
  const { s, p } = await demo(); await both(s, p); await p.startMatch();
  const start = p.data.room.startAt, end = p.data.room.endAt;
  assert.equal(end - start, 120000);
  await s.demo(p, 'disconnect'); await s.advance(1000); await p.retryConnection();
  assert.equal(p.data.stage, 'countdown'); assert.equal(p.data.countdown, 2);
  await s.advance(2000); assert.equal(p.data.stage, 'playing'); assert.equal(p.data.phaseSeconds, 120);
  await s.demo(p, 'disconnect'); await s.advance(7000); await p.retryConnection();
  assert.equal(p.data.phaseSeconds, 113); assert.equal(p.data.room.startAt, start); assert.equal(p.data.room.endAt, end);
});
test('RP14: background stops display callbacks, not the shared timeline or membership', async () => {
  const { s, p } = await demo(); await both(s, p); await p.startMatch();
  const start = p.data.room.startAt, end = p.data.room.endAt;
  p.onHide(); assert.equal(s.timers(), 0); await s.advance(1000); await s.show(p);
  assert.equal(p.data.countdown, 2); assert.equal(p.data.stage, 'countdown');
  p.onHide(); await s.advance(6000); await s.show(p);
  assert.equal(p.data.stage, 'playing'); assert.equal(p.data.phaseSeconds, 116);
  assert.equal(p.data.room.members.length, 2); assert.equal(p.data.room.startAt, start); assert.equal(p.data.room.endAt, end);
});
