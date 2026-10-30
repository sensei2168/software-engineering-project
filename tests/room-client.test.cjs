const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomClient } = require('../miniapp/utils/room-client');
const { fixture } = require('./helpers/room-fixture.cjs');
const envId = 'room-test-env';
function setup() {
  const f = fixture(), values = new Map(), calls = [], state = { drop: false, response: null, badStorage: '' };
  const wxApi = {
    getStorageSync: key => structuredClone(values.get(key)),
    setStorageSync(key, value) { if (key.includes(state.badStorage) && state.badStorage) throw new Error('storage full'); values.set(key, structuredClone(value)); },
    removeStorageSync: key => values.delete(key),
    cloud: { init() {}, async callFunction(options) {
      calls.push(structuredClone(options));
      const result = state.response || await f.service(options.data, f.context('a'));
      if (state.drop) { state.drop = false; throw new Error('lost response'); }
      return { result };
    } }
  };
  return { f, values, calls, state, wxApi, client: () => createRoomClient({ wxApi, envId, makeRequestId: f.id }) };
}

test('environment ID is required; AppID and unsupported cloud runtime fail before calling', () => {
  const s = setup();
  for (const env of ['', 'wxeeac1150bc72adb2', ' env ', null]) assert.throws(() => createRoomClient({ wxApi: s.wxApi, envId: env }), { code: 'ENV_NOT_CONFIGURED' });
  assert.throws(() => createRoomClient({ wxApi: {}, envId }), { code: 'CLOUD_UNSUPPORTED' });
  assert.equal(s.calls.length, 0);
});

test('lost create response survives page recreation; retry confirms the same room without duplicating it', async () => {
  const s = setup(), client = s.client(); s.state.drop = true;
  await assert.rejects(client.call('create', { config: s.f.config }), { code: 'CLOUD_CALL_FAILED' });
  assert.equal(s.f.count(), 1); const pending = client.pending();
  await assert.rejects(client.call('create', { config: s.f.config }), { code: 'PENDING_REQUEST' });
  assert.equal((await client.call('whoami')).ok, true);
  const recreated = s.client(), response = await recreated.retryPending();
  assert.equal(response.data.operation.replayed, true); assert.equal(s.f.count(), 1);
  assert.equal(s.calls.at(-1).data.requestId, pending.requestId); assert.equal(recreated.pending(), null);
  assert.equal(s.values.get('room-p2.last-room.' + envId), response.data.room.roomId);
  assert.equal(s.calls[0].name, 'roomService'); assert.equal(s.calls[0].config.env, envId);
});

test('definite rejection clears pending; unavailable or malformed responses retain it', async () => {
  const s = setup(), client = s.client();
  await assert.rejects(client.call('join', { code: '999999' }), { code: 'ROOM_NOT_FOUND' });
  assert.equal(client.pending(), null);
  s.state.response = { apiVersion: 1, ok: false, serverNow: s.f.time(), error: { code: 'SERVICE_UNAVAILABLE', message: 'retry' } };
  await assert.rejects(client.call('create', { config: s.f.config }), { code: 'SERVICE_UNAVAILABLE' });
  const request = client.pending(); assert.ok(request);
  s.state.response = { ok: true, data: {} };
  await assert.rejects(client.retryPending(), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(client.pending(), request);
  s.state.response = null; assert.equal((await client.retryPending()).ok, true);
});

test('failure to persist the request prevents a network mutation', async () => {
  const s = setup(), client = s.client(); s.state.badStorage = 'pending';
  await assert.rejects(client.call('create', { config: s.f.config }), { code: 'LOCAL_STORAGE_FAILED' });
  assert.equal(s.calls.length, 0); assert.equal(s.f.count(), 0);
});

test('failure saving recovery ID after cloud success retains the original request for safe recovery', async () => {
  const s = setup(), client = s.client(); s.state.badStorage = 'last-room';
  await assert.rejects(client.call('create', { config: s.f.config }), { code: 'LOCAL_STORAGE_FAILED' });
  assert.equal(s.f.count(), 1); assert.ok(client.pending());
  s.state.badStorage = '';
  assert.equal((await client.retryPending()).data.operation.replayed, true);
  assert.equal(client.pending(), null); assert.equal(s.f.count(), 1);
});

test('pending operations are isolated by environment, and empty retry is explicit', async () => {
  const s = setup(), client = s.client(); s.state.drop = true;
  await assert.rejects(client.call('create', { config: s.f.config }));
  const other = createRoomClient({ wxApi: s.wxApi, envId: 'other-env', makeRequestId: s.f.id });
  assert.equal(other.pending(), null); assert.ok(client.pending());
  await assert.rejects(other.retryPending(), { code: 'NO_PENDING_REQUEST' });
});

test('confirmed leave clears the stored recovery room', async () => {
  const s = setup(), client = s.client();
  const room = (await client.call('create', { config: s.f.config })).data.room;
  await client.call('leave', { roomId: room.roomId, expectedVersion: room.version });
  assert.equal(s.values.has('room-p2.last-room.' + envId), false); assert.equal(client.pending(), null);
});
