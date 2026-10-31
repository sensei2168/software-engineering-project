const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { auditRoom } = require('../scripts/cloud-room-audit.cjs');
const { fixture } = require('./helpers/room-fixture.cjs');
async function run(f, transform = result => result) {
  const audit = vm.runInNewContext('(' + auditRoom.toString() + ')', { wx: { cloud: {
    init() {}, async callFunction({ data }) { return { result: transform(await f.service(data, f.context('audit-user')), data) }; }
  } } });
  return audit({ envId: 'test-environment', runId: 'audit-local-00000001' });
}
test('audit checks its invariants and closes only its own new room', async () => {
  const f = fixture(); const existing = (await f.create('existing-user')).data.room;
  const report = await run(f);
  assert.equal(report.passed, true); assert.equal(report.cases.length, 9);
  assert.equal(report.cleanup, 'closed'); assert.equal(f.count(), 2);
  assert.equal((await f.call('existing-user', 'get', { roomId: existing.roomId })).data.room.status, 'waiting');
  assert.equal(JSON.stringify(report).includes('userId'), false);
});
test('audit closes its room after assertion failure and does not report success', async () => {
  const f = fixture();
  const report = await run(f, (result, data) => data.action === 'join' ? { ...result, ok: false, error: { code: 'INJECTED' } } : result);
  assert.equal(report.passed, false); assert.equal(report.failure, 'ASSERTION_FAILED'); assert.equal(report.cleanup, 'closed');
});
test('wrong deployment is rejected before test-room creation', async () => {
  const f = fixture();
  const report = await run(f, result => ({ ...result, data: { ...result.data, stage: 'older-stage' } }));
  assert.equal(report.passed, false); assert.equal(f.count(), 0);
});
