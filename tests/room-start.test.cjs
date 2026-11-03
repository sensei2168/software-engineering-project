const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/room-fixture.cjs');
const { COLLECTIONS, WAIT_MS, RETAIN_MS, COUNTDOWN_MS } = require('../miniapp/cloudfunctions/roomService/service');
const { createQuestions } = require('../miniapp/cloudfunctions/roomService/question-set');
const contract = require('../miniapp/cloudfunctions/roomService/rules.generated.json');
const error = (result, code) => { assert.equal(result.ok, false); assert.equal(result.error.code, code); };
const op = room => ({ roomId: room.roomId, expectedVersion: room.version });
async function ready(f, settings) {
  let room = settings ? (await f.create('a', settings)).data.room : await f.pair();
  if (settings) room = (await f.call('b', 'join', { code: room.code })).data.room;
  room = (await f.call('a', 'setReady', { ...op(room), ready: true })).data.room;
  return (await f.call('b', 'setReady', { ...op(room), ready: true })).data.room;
}
async function start(f, settings) { const room = await ready(f, settings); return (await f.call('a', 'start', op(room))).data.room; }

test('start checks caller, host, two ready members, version, and forbidden client fields', async () => {
  const f = fixture(); let room = (await f.create()).data.room;
  error(await f.call('a', 'start', op(room)), 'NEED_TWO_MEMBERS');
  room = (await f.call('b', 'join', { code: room.code })).data.room;
  error(await f.call('b', 'start', op(room)), 'HOST_ONLY');
  error(await f.call('c', 'start', op(room)), 'NOT_MEMBER');
  error(await f.call('a', 'start', op(room)), 'NOT_ALL_READY');
  for (const extra of [{ startAt: f.time() }, { seed: 'chosen' }, { questions: [] }, { score: 100 }, { attemptId: 'chosen' }]) {
    error(await f.call('a', 'start', { ...op(room), ...extra }), 'INVALID_ARGUMENT');
  }
  room = (await f.call('a', 'setReady', { ...op(room), ready: true })).data.room;
  error(await f.call('a', 'start', op(room)), 'NOT_ALL_READY');
  room = (await f.call('b', 'setReady', { ...op(room), ready: true })).data.room;
  error(await f.call('a', 'start', { ...op(room), expectedVersion: room.version - 1 }), 'VERSION_CONFLICT');
  assert.equal((await f.call('a', 'start', op(room))).ok, true);
});

test('server persists one private set before the three-second start and returns identical public questions at the boundary', async () => {
  const f = fixture(), room = await start(f);
  assert.match(room.attemptId, /^a_[a-f0-9]{40}$/);
  assert.equal(room.status, 'countdown'); assert.equal(room.startAt, f.time() + COUNTDOWN_MS);
  assert.equal(room.endAt, room.startAt + 60000); assert.deepEqual(room.questions, []);
  const privateSet = f.store.records(COLLECTIONS.rooms)[0].attempt;
  assert.equal(privateSet.questions.length, 10); assert.equal(typeof privateSet.questions[0].answer, 'number');
  f.advance(COUNTDOWN_MS - 1);
  assert.deepEqual((await f.call('b', 'get', { roomId: room.roomId })).data.room.questions, []);
  f.advance(1);
  const a = (await f.call('a', 'get', { roomId: room.roomId })).data.room;
  const b = (await f.call('b', 'get', { roomId: room.roomId })).data.room;
  assert.equal(a.status, 'playing'); assert.deepEqual(a.questions, b.questions);
  assert.equal(a.questions.length, 10); assert.equal(a.version, room.version);
  a.questions.forEach(q => assert.deepEqual(Object.keys(q).sort(), ['answerKind','id','index','ruleId','text']));
  assert.equal(a.capabilities.submitAnswer, false);
  error(await f.call('c', 'get', { roomId: room.roomId }), 'NOT_MEMBER');
  f.advance(60000);
  assert.equal((await f.call('a', 'get', { roomId: room.roomId })).data.room.status, 'awaiting_result');
  error(await f.call('a', 'finish', { roomId: room.roomId, attemptId: room.attemptId }), 'FEATURE_NOT_READY');
});

test('cancel keeps room and two members, clears readiness and removes private questions; restart uses a new batch', async () => {
  const f = fixture(), first = await start(f), expiresAt = first.expiresAt;
  const cancelled = await f.call('b', 'cancelStart', { ...op(first), attemptId: first.attemptId });
  let room = cancelled.data.room;
  assert.equal(room.status, 'waiting'); assert.equal(room.roomId, first.roomId); assert.equal(room.code, first.code);
  assert.equal(room.members.length, 2); assert.ok(room.members.every(m => !m.ready));
  assert.equal(room.expiresAt, expiresAt); assert.equal(room.attemptId, null); assert.deepEqual(room.questions, []);
  assert.equal(f.store.records(COLLECTIONS.rooms)[0].attempt, null);
  error(await f.call('a', 'start', op(room)), 'NOT_ALL_READY');
  room = (await f.call('a', 'setReady', { ...op(room), ready: true })).data.room;
  room = (await f.call('b', 'setReady', { ...op(room), ready: true })).data.room;
  const next = (await f.call('a', 'start', op(room))).data.room;
  assert.notEqual(next.attemptId, first.attemptId);
  error(await f.call('a', 'cancelStart', { ...op(next), attemptId: first.attemptId }), 'ATTEMPT_MISMATCH');
  assert.equal((await f.call('a', 'get', { roomId: next.roomId })).data.room.attemptId, next.attemptId);
});

test('duplicate start and cancelled-start replay never generate another batch or revive a cancelled one', async () => {
  let generated = 0;
  const f = fixture({ makeQuestions(...args) { generated++; return createQuestions(...args); } });
  const room = await ready(f), requestId = f.id(), payload = op(room);
  const first = await f.call('a', 'start', payload, requestId);
  const replay = await f.call('a', 'start', payload, requestId);
  assert.equal(replay.data.operation.replayed, true); assert.equal(generated, 1);
  assert.equal(replay.data.room.attemptId, first.data.room.attemptId);
  error(await f.call('a', 'start', { ...payload, expectedVersion: 999 }, requestId), 'REQUEST_CONFLICT');
  const active = first.data.room;
  await f.call('b', 'cancelStart', { ...op(active), attemptId: active.attemptId });
  const old = await f.call('a', 'start', payload, requestId);
  assert.equal(old.data.room.status, 'waiting'); assert.equal(old.data.room.attemptId, null);
  assert.equal(old.data.operation.attemptId, active.attemptId); assert.equal(generated, 1);
});

test('cancel replay after a new start returns current state and cannot cancel the new batch', async () => {
  const f = fixture(), first = await start(f), requestId = f.id();
  const payload = { ...op(first), attemptId: first.attemptId };
  let room = (await f.call('b', 'cancelStart', payload, requestId)).data.room;
  room = (await f.call('a', 'setReady', { ...op(room), ready: true })).data.room;
  room = (await f.call('b', 'setReady', { ...op(room), ready: true })).data.room;
  room = (await f.call('a', 'start', op(room))).data.room;
  const replay = await f.call('b', 'cancelStart', payload, requestId);
  assert.equal(replay.data.operation.replayed, true); assert.equal(replay.data.room.attemptId, room.attemptId);
  assert.equal(replay.data.room.status, 'countdown');
});

test('cancel is allowed before, but not at or after startAt; caller time cannot alter this', async () => {
  for (const delta of [2999, 3000, 3001]) {
    const f = fixture(), room = await start(f); f.advance(delta);
    const result = await f.call('b', 'cancelStart', { ...op(room), attemptId: room.attemptId });
    if (delta < 3000) assert.equal(result.ok, true); else error(result, 'MATCH_ALREADY_STARTED');
  }
  const f = fixture(), room = await start(f);
  error(await f.call('c', 'cancelStart', { ...op(room), attemptId: room.attemptId }), 'NOT_MEMBER');
  error(await f.call('a', 'cancelStart', { ...op(room), attemptId: room.attemptId, now: 0 }), 'INVALID_ARGUMENT');
});

test('a countdown leave from either role closes the batch; cancellation is a different operation', async () => {
  for (const actor of ['a','b']) {
    const f = fixture(), room = await start(f), requestId = f.id();
    error(await f.call(actor, 'leave', op(room)), 'ATTEMPT_MISMATCH');
    const payload = { ...op(room), attemptId: room.attemptId };
    const response = await f.call(actor, 'leave', payload, requestId);
    assert.equal(response.data.closed, true);
    assert.equal((await f.call(actor, 'leave', payload, requestId)).data.operation.replayed, true);
    const other = (await f.call(actor === 'a' ? 'b' : 'a', 'get', { roomId: room.roomId })).data.room;
    assert.equal(other.status, 'cancelled'); assert.deepEqual(other.questions, []); assert.equal(other.attemptId, null);
    error(await f.call('c', 'join', { code: room.code }), 'ROOM_EXPIRED');
  }
  const f = fixture(), room = await start(f); f.advance(3000);
  error(await f.call('b', 'leave', { ...op(room), attemptId: room.attemptId }), 'MATCH_ALREADY_STARTED');
});

test('waiting actions cannot mutate a countdown or a playing room', async () => {
  const f = fixture(), room = await start(f);
  error(await f.call('a', 'setReady', { ...op(room), ready: false }), 'INVALID_STATE');
  error(await f.call('a', 'start', op(room)), 'INVALID_STATE');
  error(await f.call('c', 'join', { code: room.code }), 'INVALID_STATE');
  f.advance(3000);
  error(await f.call('b', 'setReady', { ...op(room), ready: false }), 'INVALID_STATE');
});

test('expiry is not extended by cancel, while an accepted match keeps its original end and retention', async () => {
  const f = fixture(); let room = await ready(f); f.advance(WAIT_MS - 1000);
  room = (await f.call('a', 'start', op(room))).data.room;
  f.advance(1000);
  const cancelled = await f.call('a', 'cancelStart', { ...op(room), attemptId: room.attemptId });
  assert.equal(cancelled.data.room.status, 'expired'); assert.equal(cancelled.data.room.expiresAt, room.expiresAt);
  const g = fixture(); let playing = await ready(g); g.advance(WAIT_MS - 1);
  playing = (await g.call('a', 'start', op(playing))).data.room;
  g.advance(3000);
  assert.equal((await g.call('b', 'get', { roomId: playing.roomId })).data.room.status, 'playing');
  g.advance(60000 + RETAIN_MS);
  error(await g.call('b', 'get', { roomId: playing.roomId }), 'ROOM_NOT_FOUND');
});

test('transaction failures leave no active batch or receipt; same request can safely retry', async () => {
  const f = fixture(), room = await ready(f), requestId = f.id();
  const receipts = f.count(COLLECTIONS.requests); f.store.failAtWrite = 2;
  error(await f.call('a', 'start', op(room), requestId), 'SERVICE_UNAVAILABLE');
  assert.equal(f.store.records(COLLECTIONS.rooms)[0].status, 'waiting'); assert.equal(f.count(COLLECTIONS.requests), receipts);
  f.store.failAtWrite = 0;
  assert.equal((await f.call('a', 'start', op(room), requestId)).ok, true);
});

test('generator failure does not start an empty countdown or leak private exception text', async () => {
  const f = fixture({ makeQuestions() { throw new Error('secret answer'); } }), room = await ready(f);
  const response = await f.call('a', 'start', op(room)); error(response, 'SERVICE_UNAVAILABLE');
  assert.equal(JSON.stringify(response).includes('secret'), false);
  assert.equal(f.store.records(COLLECTIONS.rooms)[0].status, 'waiting');
});

test('the three-second countdown starts after generation, and expiry during generation aborts', async () => {
  let f;
  f = fixture({ makeQuestions(...args) { f.advance(500); return createQuestions(...args); } });
  let room = await ready(f), before = f.time();
  room = (await f.call('a', 'start', op(room))).data.room;
  assert.equal(room.startAt, before + 500 + COUNTDOWN_MS);
  let g;
  g = fixture({ makeQuestions(...args) { g.advance(500); return createQuestions(...args); } });
  const waiting = await ready(g); g.advance(WAIT_MS - 200);
  error(await g.call('a', 'start', op(waiting)), 'ROOM_EXPIRED');
  assert.equal(g.store.records(COLLECTIONS.rooms)[0].status, 'waiting');
});

test('competing starts and cancels are serialized in the local transaction model', async () => {
  const f = fixture(), room = await ready(f);
  const starts = await Promise.all([f.call('a', 'start', op(room)), f.call('a', 'start', op(room))]);
  assert.equal(starts.filter(r => r.ok).length, 1);
  const active = starts.find(r => r.ok).data.room, payload = { ...op(active), attemptId: active.attemptId };
  const cancels = await Promise.all([f.call('a', 'cancelStart', payload), f.call('b', 'cancelStart', payload)]);
  assert.equal(cancels.filter(r => r.ok).length, 1);
  assert.equal(f.store.records(COLLECTIONS.rooms)[0].status, 'waiting');
});

test('all thirteen presets persist private original structures and publish only question text after start', async () => {
  for (const rule of contract.rules) {
    const f = fixture(); const room = await start(f, { grade: rule.grade, ruleId: rule.id, count: 30, durationSeconds: 120 });
    const attempt = f.store.records(COLLECTIONS.rooms)[0].attempt;
    assert.equal(attempt.ruleVersion, contract.ruleVersion); assert.equal(attempt.questions.length, 30);
    if (rule.operation === 'mixed') assert.equal(attempt.questions[0].tokens.length, 5);
    if (rule.operation === 'fraction_add_sub') assert.ok(attempt.questions[0].denominator >= 2);
    f.advance(3000);
    const response = await f.call('a', 'get', { roomId: room.roomId });
    assert.equal(response.data.room.questions.length, 30);
    response.data.room.questions.forEach(q => assert.deepEqual(Object.keys(q).sort(), ['answerKind','id','index','ruleId','text']));
  }
});
