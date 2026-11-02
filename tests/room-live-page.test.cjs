const test = require('node:test');
const assert = require('node:assert/strict');
const { roomPageFixture } = require('./helpers/room-page-fixture.cjs');
const { viewRoom } = require('../miniapp/utils/room-view');
const { envId } = require('../miniapp/config/cloud');
async function pair() {
  const s = roomPageFixture(), p = s.load(); await s.show(p); await p.createRoom();
  await s.backend.call('b', 'join', { code: p.data.room.code });
  await p.refreshRoom(); return { s, p };
}
async function ready(s, p) {
  await p.toggleReady();
  await s.backend.call('b', 'setReady', { roomId: p.data.room.roomId, expectedVersion: p.data.room.version, ready: true });
  await p.refreshRoom();
}
function holdOneResponse(s) {
  let release, reached;
  const gate = new Promise(r => { release = r; }), arrived = new Promise(r => { reached = r; });
  s.state.afterResponse = async () => { s.state.afterResponse = null; reached(); await gate; };
  return { release, arrived };
}

test('live capabilities gate host start and member cancellation; absent capability stays disabled', async () => {
  const {s,p} = await pair(); await ready(s,p);
  assert.equal(p.data.canStart,true);
  const room = structuredClone(p.data.room); delete room.capabilities;
  assert.equal(viewRoom(room).canStart,false);
  const guest = roomPageFixture({backend:s.backend,actor:'b'}), g=guest.load(); await guest.show(g);
  g.inputRoomCode({detail:{value:p.data.room.code}}); await g.joinRoom();
  assert.equal(g.data.canStart,false); await g.startMatch(); assert.equal(guest.requests.some(x=>x.action==='start'),false);
  await p.startMatch(); const first=p.data.room.attemptId;
  await guest.advance(1000); assert.equal(g.data.stage,'countdown'); assert.equal(g.data.canCancelStart,true);
  await g.cancelStart(); assert.equal(g.data.stage,'ready');
  assert.equal(guest.requests.find(x=>x.action==='cancelStart').payload.attemptId,first);
  await s.advance(1000); assert.equal(p.data.stage,'ready'); assert.ok(p.data.slots.every(x=>!x.ready));
  await ready(s,p); await p.startMatch(); assert.notEqual(p.data.room.attemptId,first);
  p.onUnload();g.onUnload();
});

test('live countdown leave carries its batch and closes the actual room', async () => {
  const {s,p}=await pair(); await ready(s,p); await p.startMatch(); const room=p.data.room;
  p.leaveRoom(); await s.confirm(true);
  assert.equal(s.requests.find(x=>x.action==='leave').payload.attemptId,room.attemptId);
  assert.equal(p.data.room,null);
  assert.equal((await s.backend.call('b','get',{roomId:room.roomId})).data.room.status,'cancelled');
  assert.equal(s.timers(),0);
});

test('cancel arriving at start boundary refreshes playing instead of keeping an obsolete countdown', async () => {
  const {s,p}=await pair(); await ready(s,p); await p.startMatch();
  s.backend.advance(3000); await p.cancelStart();
  assert.equal(p.data.stage,'playing');assert.equal(p.data.canCancelStart,false);assert.equal(p.data.error,'');
  p.onUnload();
});

test('same-version time transitions expose actual questions and awaiting_result without fake scores', async () => {
  const {s,p}=await pair(); await ready(s,p); await p.startMatch(); const version=p.data.room.version;
  const old=structuredClone(p.data.room), oldTime=s.backend.time();
  await s.advance(3000);assert.equal(p.data.stage,'playing');assert.equal(p.data.room.version,version);
  assert.equal(p.data.room.questions.length,30);
  assert.ok(p.data.room.questions.every(x=>!Object.hasOwn(x,'answer')));
  await s.advance(120000); assert.equal(p.data.stage,'awaiting_result');assert.equal(p.data.error,'');
  p.setRoom(old,oldTime);assert.equal(p.data.stage,'awaiting_result');
  const before=s.requests.length;await s.advance(1000);assert.equal(s.requests.length,before);
  await s.advance(2000);assert.equal(s.requests.length,before+1);assert.equal(p.data.stage,'awaiting_result');
  assert.equal(Object.hasOwn(p.data,'score'),false);
  p.onUnload();const reopened=s.load();await s.show(reopened);assert.equal(reopened.data.stage,'awaiting_result');reopened.onUnload();
});

test('foreground polling discovers join and readiness, uses one timer, and does not poll in background', async () => {
  const s=roomPageFixture(),p=s.load();await s.show(p);await p.createRoom();
  const before=s.requests.length;
  await s.backend.call('b','join',{code:p.data.room.code});
  await s.advance(999);assert.equal(s.requests.length,before);await s.advance(1);assert.equal(p.data.capacityText,'2 / 2 人');
  assert.equal(s.timers(),1);
  p.onHide();const hidden=s.requests.length;await s.advance(5000);assert.equal(s.requests.length,hidden);assert.equal(s.timers(),0);
  await s.show(p);assert.equal(s.requests.length,hidden+1);assert.equal(s.timers(),1);
  p.onUnload();assert.equal(s.timers(),0);
});

test('network failure stops polling; explicit reconnect restores server membership and timeline', async () => {
  const {s,p}=await pair();await ready(s,p);await p.startMatch();const startAt=p.data.room.startAt;
  s.state.rejectCloud=true;await s.advance(1000);assert.equal(p.data.stage,'offline');assert.equal(s.timers(),0);
  const before=s.requests.length;await s.advance(6000);assert.equal(s.requests.length,before);
  s.state.rejectCloud=false;await p.retryConnection();assert.equal(p.data.stage,'playing');assert.equal(p.data.room.startAt,startAt);
  assert.equal(p.data.capacityText,'2 / 2 人');p.onUnload();
});

test('unconfirmed start is not automatically resubmitted and survives page recreation', async () => {
  const {s,p}=await pair();await ready(s,p);s.state.loseResponse=true;await p.startMatch();
  assert.equal(p.data.pendingAction,'start');const request=s.requests.at(-1);
  await s.advance(1000);assert.equal(s.requests.at(-1).requestId,request.requestId);p.onUnload();
  const next=s.load();await s.show(next);await next.retryConnection();
  assert.equal(s.requests.at(-1).requestId,request.requestId);assert.equal(next.data.pendingAction,'');
  assert.equal(next.data.stage,'countdown');assert.equal(s.backend.count(),1);next.onUnload();
});

test('a query response from before backgrounding cannot overwrite the returning page', async () => {
  const {s,p}=await pair();const held=holdOneResponse(s);const request=p.refreshRoom();await held.arrived;
  p.onHide();await s.backend.call('b','setReady',{roomId:p.data.room.roomId,expectedVersion:p.data.room.version,ready:true});
  await s.show(p);held.release();await request;await s.settle();
  assert.equal(p.data.slots[1].ready,true);assert.equal(s.timers(),1);p.onUnload();
});

test('creation completed while hidden is restored from persisted room without a duplicate creation', async () => {
  const s=roomPageFixture(),p=s.load();await s.show(p);const held=holdOneResponse(s);
  const request=p.createRoom();await held.arrived;p.onHide();held.release();await request;
  assert.equal(p.data.room,null);await s.show(p);assert.equal(p.data.stage,'waiting');assert.equal(s.backend.count(),1);p.onUnload();
});

test('expired storage access stops polling and clears unusable recovery instead of looping', async () => {
  const {s,p}=await pair();s.backend.advance(25*60*60*1000);await p.refreshRoom();
  assert.equal(p.data.stage,'expired');assert.equal(p.data.room,null);assert.equal(s.timers(),0);
  assert.equal(s.values.has('room-p2.last-room.'+envId),false);p.onUnload();
});
