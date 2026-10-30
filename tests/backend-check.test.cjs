const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { fixture } = require('./helpers/room-fixture.cjs');
const filename = path.resolve(__dirname, '../miniapp/pages/backend-check/backend-check.js');
function load(envVersion = 'develop') {
  const f = fixture(), values = new Map(); let definition, count = 0, drop = false;
  const wxApi = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
    getStorageSync: key => values.get(key), setStorageSync: (key, value) => values.set(key, structuredClone(value)),
    removeStorageSync: key => values.delete(key),
    cloud: { init() {}, async callFunction({ data }) {
      count++; const result = await f.service(data, f.context('a'));
      if (drop) { drop = false; throw new Error('lost'); } return { result };
    } }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: createRequire(filename), Page: value => { definition = value; }, wx: wxApi });
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  page.onLoad(); page.inputEnv({ detail: { value: 'room-test-env' } });
  return { page, f, values, count: () => count, loseNextResponse() { drop = true; } };
}

test('release page cannot call the diagnostic service', async () => {
  const { page, count } = load('release');
  await page.identify(); await page.createTestRoom();
  assert.equal(count(), 0); assert.equal(page.data.allowed, false);
});

test('diagnostic page identifies caller and shows actual room state', async () => {
  const { page, f } = load();
  await page.identify(); assert.match(page.data.identity.userId, /^[a-f0-9]{64}$/);
  await page.createTestRoom(); assert.equal(page.data.room.members.length, 1);
  const room = page.data.room;
  await f.call('b', 'join', { code: room.code });
  await page.refreshRoom(); assert.equal(page.data.room.members.length, 2);
  await page.toggleReady(); assert.equal(page.data.selfReady, true);
  assert.equal(page.data.error, ''); assert.equal(page.data.busy, false);
});

test('diagnostic page shows a recoverable failure and uses the original pending operation', async () => {
  const { page, f, loseNextResponse } = load(); loseNextResponse();
  await page.createTestRoom(); assert.equal(page.data.room, null);
  assert.match(page.data.error, /CLOUD_CALL_FAILED/); assert.equal(page.data.pendingAction, 'create');
  await page.retryOperation(); assert.equal(f.count(), 1);
  assert.ok(page.data.room); assert.equal(page.data.pendingAction, ''); assert.equal(page.data.error, '');
});

test('template condition expressions are bound, and page is registered outside the public home navigation', () => {
  const template = fs.readFileSync(filename.replace(/\.js$/, '.wxml'), 'utf8');
  for (const match of template.matchAll(/wx:if="([^"]+)"/g)) assert.match(match[1], /^{{.+}}$/);
  const app = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../miniapp/app.json'), 'utf8'));
  assert.ok(app.pages.includes('pages/backend-check/backend-check'));
  const home = fs.readFileSync(path.resolve(__dirname, '../miniapp/pages/home/home.wxml'), 'utf8');
  assert.equal(home.includes('backend-check'), false);
});
