const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloudStore } = require('../miniapp/cloudfunctions/roomService/store');

test('wx-server-sdk adapter uses transaction get/set shapes and removes reserved _id', async () => {
  const writes = [], document = { async get() { return { data: { _id: 'abc', version: 3 } }; }, async set(data) { writes.push(data); } };
  const db = { async runTransaction(callback, retries) {
    assert.equal(retries, 3);
    return callback({ collection(name) { assert.equal(name, 'rooms'); return { doc(id) { assert.equal(id, 'abc'); return document; } }; } });
  } };
  const value = await createCloudStore(db).transaction(async tx => {
    const room = await tx.get('rooms', 'abc'); await tx.set('rooms', 'abc', room); return room;
  });
  assert.deepEqual(value, { version: 3 }); assert.deepEqual(writes, [{ data: { version: 3 } }]);
});

test('missing document is null; malformed or failed database reads are not treated as missing', async () => {
  const document = { async get() { return { data: null }; } };
  const store = createCloudStore({ runTransaction: callback => callback({ collection: () => ({ doc: () => document }) }) });
  const read = () => store.transaction(tx => tx.get('rooms', 'abc'));
  assert.equal(await read(), null);
  document.get = async () => ({}); await assert.rejects(read(), /Invalid database response/);
  document.get = async () => { throw new Error('connection failed'); }; await assert.rejects(read(), /connection failed/);
});
