const test=require('node:test'),assert=require('node:assert/strict');
const {roomPageFixture}=require('./helpers/room-page-fixture.cjs');
const {COLLECTIONS}=require('../miniapp/cloudfunctions/roomService/service');
const {answerText}=require('../miniapp/utils/exact-answer');
const {loadRecords}=require('../miniapp/utils/record-store');
async function playing(t) {
  const s=roomPageFixture(),p=s.load();global.wx=s.wxApi;t.after(()=>{p.onUnload();delete global.wx;});
  await s.show(p);await p.createRoom();await s.backend.call('b','join',{code:p.data.room.code});await p.refreshRoom();
  await p.toggleReady();await s.backend.call('b','setReady',{roomId:p.data.room.roomId,expectedVersion:p.data.room.version,ready:true});
  await p.refreshRoom();await p.startMatch();await s.advance(3000);return{s,p};
}
test('typing survives automatic refresh and question selection; confirmed answers lock without revealing grade',async t=>{
  const{s,p}=await playing(t);p.inputAnswer({detail:{value:'12'}});await s.advance(1000);
  assert.equal(p.data.answerInput,'12');p.nextQuestion();p.inputAnswer({detail:{value:'2'}});
  p.chooseQuestion({detail:{value:0}});assert.equal(p.data.answerInput,'12');await p.submitAnswer();
  assert.equal(p.data.answerLocked,true);assert.equal(p.data.submittedCount,1);assert.equal(p.data.matchResult,null);
  const before=s.requests.length;await p.submitAnswer();assert.equal(s.requests.length,before);
});
test('invalid input stays editable, while losing a submitted response requires original request retry',async t=>{
  const{s,p}=await playing(t);p.inputAnswer({detail:{value:'1+1'}});const before=s.requests.length;await p.submitAnswer();
  assert.equal(s.requests.length,before);assert.ok(p.data.answerError);
  const q=s.backend.store.records(COLLECTIONS.rooms)[0].attempt.questions[0];p.inputAnswer({detail:{value:answerText(q)}});
  s.state.loseResponse=true;await p.submitAnswer();assert.equal(p.data.pendingAction,'submitAnswer');const id=s.requests.at(-1).requestId;
  await s.advance(120000);await p.retryConnection();assert.equal(s.requests.at(-1).requestId,id);
  assert.equal(p.data.stage,'finished');assert.equal(p.data.matchResult.scores[0].score,10);assert.equal(p.data.resultSaved,true);
});
test('early finish can be cancelled, then waits without answers and restores before deadline',async t=>{
  const{s,p}=await playing(t);p.finishMatch();await s.confirm(false);assert.equal(p.data.selfFinished,false);
  p.finishMatch();await s.confirm(true);assert.equal(p.data.selfFinished,true);assert.equal(p.data.matchResult,null);
  p.backToMatchSettings();assert.equal(p.data.stage,'create');await p.resumeSavedRoom();
  assert.equal(p.data.stage,'playing');assert.equal(p.data.selfFinished,true);assert.equal(p.data.matchResult,null);
  await s.backend.call('b','finish',{roomId:p.data.room.roomId,attemptId:p.data.room.attemptId});await s.advance(1000);
  assert.equal(p.data.stage,'finished');assert.equal(p.data.matchResult.outcome,'draw');assert.equal(s.timers(),0);
  assert.equal(loadRecords().records.length,1);await p.refreshRoom();assert.equal(loadRecords().records.length,1);
  p.openMatchRecord();assert.ok(s.routes.at(-1).startsWith('/pages/result/result?id='));
});
test('storage failure shows scores without claiming saved; explicit retry writes once',async t=>{
  const{s,p}=await playing(t);s.state.storageFailure=true;await s.advance(120000);
  assert.equal(p.data.stage,'finished');assert.equal(p.data.resultSaved,false);assert.match(p.data.resultSaveText,/失败/);
  s.state.storageFailure=false;p.saveMatchResult();p.saveMatchResult();assert.equal(p.data.resultSaved,true);assert.equal(loadRecords().records.length,1);
});
