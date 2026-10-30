const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/room-fixture.cjs');
const { APP_ID, WAIT_MS, RETAIN_MS, COLLECTIONS } = require('../miniapp/cloudfunctions/roomService/service');
const contract = require('../miniapp/cloudfunctions/roomService/rules.generated.json');
function error(result, code) { assert.equal(result.ok, false); assert.equal(result.error.code, code); }

test('identity comes from verified context; public IDs are stable, distinct and do not expose OPENID', async () => {
  const f = fixture();
  const a = await f.call('private-openid-a', 'whoami');
  assert.equal(a.apiVersion, 1); assert.equal(a.serverNow, f.time());
  assert.match(a.data.userId, /^[a-f0-9]{64}$/);
  assert.equal(a.data.userId, (await f.call('private-openid-a', 'whoami')).data.userId);
  assert.notEqual(a.data.userId, (await f.call('private-openid-b', 'whoami')).data.userId);
  assert.equal(JSON.stringify(a).includes('private-openid'), false);
  assert.equal(a.data.environmentId, 'test-environment');
  for (const ctx of [null, {}, { APPID: APP_ID, OPENID: '' }, { APPID: 'other-app', OPENID: 'a' }]) {
    error(await f.service({ action: 'whoami' }, ctx), 'AUTH_REQUIRED');
  }
  error(await f.service({ action: 'whoami', OPENID: 'victim' }, f.context('a')), 'INVALID_ARGUMENT');
});

test('all agreed rule presets validate without claiming questions are generated', async () => {
  const f = fixture();
  for (const rule of contract.rules) {
    const result = await f.create('a', { ...f.config, grade: rule.grade, ruleId: rule.id, operation: rule.operation, limit: rule.limit });
    assert.equal(result.ok, true, rule.id);
    assert.equal(result.data.room.config.ruleVersion, contract.ruleVersion);
    assert.equal(result.data.room.startAt, null); assert.equal(result.data.room.attemptId, null);
  }
});

test('Cloud event identity metadata is ignored; only trusted context determines identity and ownership', async () => {
  const f = fixture(), metadata = { userInfo: { appId: APP_ID, openId: 'a' },
    tcbContext: { OPENID: 'a', APPID: APP_ID, ENV: 'untrusted-environment' } };
  const who = await f.service({ action: 'whoami', ...metadata }, f.context('b'));
  assert.equal(who.ok, true);
  assert.equal(who.data.userId, (await f.call('b', 'whoami')).data.userId);
  assert.equal(who.data.environmentId, 'test-environment');
  error(await f.service({ action: 'whoami', ...metadata }, {}), 'AUTH_REQUIRED');
  const result = await f.service({ action: 'create', payload: { config: f.config }, requestId: f.id(), ...metadata }, f.context('b'));
  assert.equal(result.ok, true);
  error(await f.call('a', 'get', { roomId: result.data.room.roomId }), 'NOT_MEMBER');
  assert.equal((await f.call('b', 'get', { roomId: result.data.room.roomId })).ok, true);
});

test('invalid configurations, unknown fields, request IDs and six-digit room codes are rejected', async () => {
  const f = fixture();
  for (const patch of [{ grade: 3 }, { ruleId: 'made-up' }, { count: 9 }, { count: 51 }, { count: 10.1 }, { count: '10' },
    { durationSeconds: 30 }, { operation: 'multiply' }, { limit: 100 }, { mode: 'normal' }]) {
    error(await f.create('a', { ...f.config, ...patch }), 'INVALID_CONFIG');
  }
  error(await f.create('a', { ...f.config, score: 999 }), 'INVALID_ARGUMENT');
  error(await f.create('a', { ...f.config, grade: 2, ruleId: 'g2_multiply_table', count: 46 }), 'QUESTION_POOL_INSUFFICIENT');
  assert.equal((await f.create('a', { ...f.config, grade: 2, ruleId: 'g2_multiply_table', count: 45 })).ok, true);
  error(await f.create('a', f.config, 'too-short'), 'INVALID_ARGUMENT');
  for (const code of [123456, '12345', '1234567', ' 123456', 'ABCDEF']) error(await f.call('a', 'join', { code }), 'INVALID_ARGUMENT');
  error(await f.call('a', 'get', { roomId: 'invalid' }), 'INVALID_ARGUMENT');
  error(await f.call('a', 'whoami', { userId: 'victim' }), 'INVALID_ARGUMENT');
});

test('two members share one room; only their own role and ready status are exposed', async () => {
  const f = fixture(), room = await f.pair();
  assert.equal(room.members.length, 2); assert.equal(room.selfRole, 'guest'); assert.equal(room.version, 2);
  const host = (await f.call('a', 'get', { roomId: room.roomId })).data.room;
  assert.equal(host.selfRole, 'host'); assert.equal(host.code, room.code);
  assert.deepEqual(host.members, [{ role: 'host', ready: false, isSelf: true }, { role: 'guest', ready: false, isSelf: false }]);
  error(await f.call('c', 'get', { roomId: room.roomId }), 'NOT_MEMBER');
  error(await f.call('c', 'setReady', { roomId: room.roomId, expectedVersion: 2, ready: true }), 'NOT_MEMBER');
  error(await f.call('c', 'leave', { roomId: room.roomId, expectedVersion: 2 }), 'NOT_MEMBER');
});

test('competing joins in the atomic model produce exactly two seats', async () => {
  const f = fixture(), room = (await f.create()).data.room;
  const results = await Promise.all(['b', 'c', 'd'].map(actor => f.call(actor, 'join', { code: room.code })));
  assert.equal(results.filter(result => result.ok).length, 1);
  results.filter(result => !result.ok).forEach(result => error(result, 'ROOM_FULL'));
  assert.equal((await f.call('a', 'get', { roomId: room.roomId })).data.room.members.length, 2);
});

test('duplicate create or join applies once, and an existing member does not take another seat', async () => {
  const f = fixture(), requestId = f.id();
  const results = await Promise.all([f.create('a', f.config, requestId), f.create('a', f.config, requestId)]);
  assert.equal(f.count(), 1); assert.equal(results[1].data.operation.replayed, true);
  assert.equal(results[0].data.room.roomId, results[1].data.room.roomId);
  const room = results[0].data.room, joinId = f.id();
  assert.equal((await f.call('a', 'join', { code: room.code })).data.room.members.length, 1);
  await f.call('b', 'join', { code: room.code }, joinId);
  assert.equal((await f.call('b', 'join', { code: room.code }, joinId)).data.operation.replayed, true);
  assert.equal((await f.call('b', 'join', { code: room.code })).data.room.version, 2);
  error(await f.create('a', { ...f.config, count: 20 }, requestId), 'REQUEST_CONFLICT');
});

test('preparation requires two members, uses expected version, and retries never undo later changes', async () => {
  const f = fixture(), room = (await f.create()).data.room;
  error(await f.call('a', 'setReady', { roomId: room.roomId, expectedVersion: 1, ready: true }), 'NEED_TWO_MEMBERS');
  await f.call('b', 'join', { code: room.code });
  const payload = { roomId: room.roomId, expectedVersion: 2, ready: true }, requestId = f.id();
  assert.equal((await f.call('a', 'setReady', payload, requestId)).data.room.version, 3);
  error(await f.call('b', 'setReady', payload), 'VERSION_CONFLICT');
  await f.call('a', 'setReady', { ...payload, expectedVersion: 3, ready: false });
  const retried = await f.call('a', 'setReady', payload, requestId);
  assert.equal(retried.data.operation.appliedVersion, 3);
  assert.equal(retried.data.room.version, 4); assert.equal(retried.data.room.members[0].ready, false);
  assert.equal((await f.call('a', 'setReady', { ...payload, expectedVersion: 4, ready: false })).data.room.version, 4);
  error(await f.call('b', 'setReady', { ...payload, expectedVersion: 4, ready: 'true' }), 'INVALID_ARGUMENT');
  error(await f.call('b', 'setReady', { ...payload, expectedVersion: 4, role: 'host' }), 'INVALID_ARGUMENT');
});

test('guest leave releases seat and readiness; old join retry cannot silently rejoin', async () => {
  const f = fixture(), room = (await f.create()).data.room, joinId = f.id();
  await f.call('b', 'join', { code: room.code }, joinId);
  await f.call('a', 'setReady', { roomId: room.roomId, expectedVersion: 2, ready: true });
  const leaveId = f.id(), payload = { roomId: room.roomId, expectedVersion: 3 };
  assert.equal((await f.call('b', 'leave', payload, leaveId)).data.closed, false);
  assert.equal((await f.call('b', 'leave', payload, leaveId)).data.operation.replayed, true);
  error(await f.call('b', 'get', { roomId: room.roomId }), 'NOT_MEMBER');
  error(await f.call('b', 'join', { code: room.code }, joinId), 'NOT_MEMBER');
  const current = (await f.call('a', 'get', { roomId: room.roomId })).data.room;
  assert.equal(current.members.length, 1); assert.equal(current.members[0].ready, false);
  assert.equal((await f.call('c', 'join', { code: room.code })).data.room.members.length, 2);
});

test('host leave closes room, invalidates code, and keeps a readable final state for original members', async () => {
  const f = fixture(), room = await f.pair(), payload = { roomId: room.roomId, expectedVersion: room.version }, requestId = f.id();
  assert.equal((await f.call('a', 'leave', payload, requestId)).data.closed, true);
  assert.equal((await f.call('a', 'leave', payload, requestId)).data.operation.replayed, true);
  const current = (await f.call('b', 'get', { roomId: room.roomId })).data.room;
  assert.equal(current.status, 'cancelled');
  error(await f.call('c', 'join', { code: room.code }), 'ROOM_EXPIRED');
  error(await f.call('b', 'setReady', { roomId: room.roomId, expectedVersion: current.version, ready: true }), 'ROOM_CLOSED');
});

test('server controls exact ten-minute boundary; refresh never extends expiry; retention is access expiry', async () => {
  const f = fixture(), room = await f.pair();
  f.advance(WAIT_MS - 1);
  assert.equal((await f.call('a', 'get', { roomId: room.roomId })).data.room.status, 'waiting');
  f.advance(1);
  assert.equal((await f.call('a', 'get', { roomId: room.roomId })).data.room.status, 'expired');
  error(await f.call('a', 'setReady', { roomId: room.roomId, expectedVersion: 2, ready: true }), 'ROOM_EXPIRED');
  error(await f.call('c', 'join', { code: room.code }), 'ROOM_EXPIRED');
  f.advance(RETAIN_MS);
  error(await f.call('a', 'get', { roomId: room.roomId }), 'ROOM_NOT_FOUND');
  assert.equal(f.count(), 1, 'P2 does not yet physically delete expired documents');
});

test('code collision is bounded; reused code does not redirect retries to a new room', async () => {
  const f = fixture({ randomCode: () => '000001' }), requestId = f.id();
  const oldRoom = (await f.create('a', f.config, requestId)).data.room;
  error(await f.create('b'), 'ROOM_CODE_BUSY'); assert.equal(f.count(), 1);
  f.advance(WAIT_MS);
  const newRoom = (await f.create('b')).data.room;
  assert.notEqual(oldRoom.roomId, newRoom.roomId);
  const replay = await f.create('a', f.config, requestId);
  assert.equal(replay.data.room.roomId, oldRoom.roomId); assert.equal(replay.data.room.status, 'expired');
  f.advance(RETAIN_MS);
  error(await f.create('a', f.config, requestId), 'REQUEST_EXPIRED');
});

test('database failure is sanitized, rolls back, and permits safe retry with the original ID', async () => {
  const f = fixture(), requestId = f.id(); f.store.failWrite = true;
  const result = await f.create('a', f.config, requestId);
  error(result, 'SERVICE_UNAVAILABLE'); assert.equal(JSON.stringify(result).includes('credentials'), false);
  assert.equal(f.count(), 0); assert.equal(f.count(COLLECTIONS.requests), 0);
  assert.deepEqual(f.errors, ['room-service-storage-failure']);
  f.store.failWrite = false;
  assert.equal((await f.create('a', f.config, requestId)).ok, true); assert.equal(f.count(), 1);
});

test('unimplemented match operations and unknown actions fail explicitly', async () => {
  const f = fixture();
  for (const action of ['start', 'cancelStart', 'submitAnswer', 'finish']) error(await f.call('a', action), 'FEATURE_NOT_READY');
  error(await f.service({ action: 'invented' }, f.context('a')), 'UNKNOWN_ACTION');
});

test('receipt write failure rolls back the room and code together in the atomic model', async () => {
  const f = fixture(), requestId = f.id(); f.store.failAtWrite = 3;
  error(await f.create('a', f.config, requestId), 'SERVICE_UNAVAILABLE');
  for (const collection of Object.values(COLLECTIONS)) assert.equal(f.count(collection), 0);
  f.store.failAtWrite = 0;
  assert.equal((await f.create('a', f.config, requestId)).ok, true);
});
