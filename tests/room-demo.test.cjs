const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockRoomClient, DEMO_KEY } = require('../miniapp/utils/mock-room-client');
const { roomConfig, viewRoom, roomError } = require('../miniapp/utils/room-view');
const { RULES } = require('../miniapp/utils/practice-rules');
function setup() {
  let now = 1800000000000; const values = new Map();
  const wxApi = { getStorageSync: key => values.get(key), setStorageSync: (key, value) => values.set(key, structuredClone(value)) };
  const client = () => createMockRoomClient({ wxApi, now: () => now });
  return { values, client, advance(ms) { now += ms; } };
}
async function create(client, input) { return (await client.call('create', { config: roomConfig(input).value })).data.room; }
async function get(client) { return (await client.call('get', { roomId: client.lastRoomId() })).data.room; }
async function ready(client) {
  const room = await get(client);
  return (await client.call('setReady', { roomId: room.roomId, expectedVersion: room.version, ready: true })).data.room;
}
async function start(client) {
  const room = await get(client);
  return (await client.call('start', { roomId: room.roomId, expectedVersion: room.version })).data.room;
}
async function both(client) { await create(client); await client.simulate('partnerJoin'); await ready(client); await client.simulate('partnerReady'); }

test('all thirteen normalized backend configs are accepted and table multiplication is capped at 45', () => {
  for (const rule of RULES) {
    const result = roomConfig({ grade: rule.grade, ruleId: rule.id, count: 20, durationSeconds: 60 });
    assert.equal(result.ok, true, rule.id); assert.equal(result.value.mode, 'timed');
  }
  assert.equal(roomConfig({ grade: 2, ruleId: 'g2_multiply_table', count: 50 }).ok, false);
  assert.equal(roomConfig({ count: 9 }).ok, false);
});
test('demo data is isolated from real room recovery keys and survives recreation', async () => {
  const s = setup(), c = s.client(); await create(c);
  assert.deepEqual([...s.values.keys()], [DEMO_KEY]);
  const recovered = await get(s.client()); assert.equal(recovered.members.length, 1);
  assert.equal(viewRoom(recovered, true).stage, 'waiting');
});
test('joining as guest, including a leading zero, uses API fields and different permissions', async () => {
  const c = setup().client(); const room = (await c.call('join', { code: '012345' })).data.room;
  assert.equal(room.code, '012345'); assert.equal(room.selfRole, 'guest');
  assert.equal(room.members[1].isSelf, true); assert.equal(viewRoom(room, true).isHost, false);
});
test('room full, expiry and bad code remain explicit business failures', async () => {
  const c = setup().client();
  await assert.rejects(c.call('join', { code: '111111' }), { code: 'ROOM_FULL' });
  await assert.rejects(c.call('join', { code: '222222' }), { code: 'ROOM_EXPIRED' });
  await assert.rejects(c.call('join', { code: '12345' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(c.pending(), null); assert.equal(c.lastRoomId(), null);
});
test('ready state and both members survive offline recovery without reinitializing', async () => {
  const s = setup(), c = s.client(); await create(c); await c.simulate('partnerJoin'); await ready(c);
  await assert.rejects(c.simulate('disconnect'), { code: 'CLOUD_CALL_FAILED' });
  c.reconnect(); const room = await get(c);
  assert.equal(room.members.length, 2); assert.equal(room.members[0].ready, true); assert.equal(room.members[1].ready, false);
  assert.equal(viewRoom(await get(s.client()), true).ownReady, true);
});
test('start requires two ready members and the host; readiness alone does not start', async () => {
  const c = setup().client(); await create(c);
  await assert.rejects(start(c), { code: 'NOT_READY' });
  await c.simulate('partnerJoin'); await ready(c); await c.simulate('partnerReady');
  assert.equal((await get(c)).status, 'waiting');
  await c.simulate('switchRole'); await assert.rejects(start(c), { code: 'NOT_HOST' });
  await c.simulate('switchRole'); assert.equal(viewRoom(await get(c), true).canStart, true);
});
test('countdown is exactly three seconds and reconnect retains startAt and the current stage', async () => {
  const s = setup(), c = s.client(); await both(c); const room = await start(c);
  assert.equal(room.startAt - room.createdAt, 3000);
  await assert.rejects(c.simulate('disconnect')); s.advance(1000); c.reconnect();
  assert.equal((await get(c)).startAt, room.startAt);
  s.advance(2000); assert.equal((await get(s.client())).status, 'playing');
  s.advance(120000); assert.equal((await get(c)).status, 'finished');
});
test('explicit cancel preserves members, invalidates old time, and requires a new batch', async () => {
  const s = setup(), c = s.client(); await both(c); const original = await start(c);
  await assert.rejects(c.simulate('disconnect')); const event = await c.simulate('cancelStart');
  assert.match(event.data.event, /模拟服务端事件/); c.reconnect(); s.advance(4000);
  let room = await get(c); assert.equal(room.status, 'waiting'); assert.equal(room.startAt, null);
  assert.equal(room.members.length, 2); assert.equal(room.members.some(m => m.ready), false);
  await ready(c); await c.simulate('partnerReady'); room = await start(c);
  assert.notEqual(room.attemptId, original.attemptId); assert.ok(room.startAt > original.startAt);
});
test('events while offline have explicit causes; closed room cannot resume old countdown', async () => {
  const s = setup(), c = s.client(); await both(c); await start(c); await assert.rejects(c.simulate('disconnect'));
  const event = await c.simulate('closeRoom'); assert.match(event.data.event, /房主关闭/);
  c.reconnect(); s.advance(4000); const room = await get(c);
  assert.equal(room.status, 'cancelled'); assert.equal(room.members.length, 2);
});
test('late cancel is rejected and never extends the waiting expiry', async () => {
  const s = setup(), c = s.client(); await both(c); const original = await start(c); s.advance(3000);
  await assert.rejects(c.simulate('cancelStart'), { code: 'INVALID_STATE' });
  assert.equal((await get(c)).status, 'playing'); assert.equal((await get(c)).expiresAt, original.expiresAt);
});
test('failed join preserves the exact request and can be retried after page recreation', async () => {
  const s = setup(), c = s.client(); await assert.rejects(c.call('join', { code: '333333' }), { code: 'CLOUD_CALL_FAILED' });
  const pending = c.pending(); assert.equal(pending.payload.code, '333333');
  const second = s.client(); await assert.rejects(second.call('create', { config: roomConfig().value }), { code: 'PENDING_REQUEST' });
  const response = await second.retryPending(); assert.equal(response.data.operation.requestId, pending.requestId);
  assert.equal(response.data.room.members.length, 2); assert.equal(second.pending(), null);
});
test('version conflicts preserve the latest room, and exit clears demo recovery', async () => {
  const c = setup().client(); const old = await create(c); await c.simulate('partnerJoin');
  await assert.rejects(c.call('setReady', { roomId: old.roomId, expectedVersion: old.version, ready: true }), { code: 'VERSION_CONFLICT' });
  const room = await get(c); assert.equal(room.members.every(m => !m.ready), true);
  const result = await c.call('leave', { roomId: room.roomId, expectedVersion: room.version });
  assert.equal(result.data.closed, true); assert.equal(c.lastRoomId(), null);
});
test('views reject malformed states and distinguish snapshot expiry from connection failure', async () => {
  const s = setup(), c = s.client(); await create(c); s.advance(600000);
  assert.equal(viewRoom(await get(c), true).stage, 'expired');
  assert.throws(() => viewRoom({}), { code: 'INVALID_RESPONSE' });
  assert.equal(roomError({ code: 'ROOM_FULL' }).stage, 'full');
  assert.equal(roomError({ code: 'CLOUD_CALL_FAILED' }).stage, 'offline');
  assert.equal(roomError({ code: 'NOT_MEMBER' }).forgetRoom, true);
});
