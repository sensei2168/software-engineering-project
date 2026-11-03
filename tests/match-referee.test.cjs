const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture } = require('./helpers/room-fixture.cjs');
const { COLLECTIONS, RETAIN_MS } = require('../miniapp/cloudfunctions/roomService/service');
const { judgeQuestion, parseAnswer, answerText } = require('../miniapp/utils/exact-answer');
const contract = require('../miniapp/cloudfunctions/roomService/rules.generated.json');
const { createRoomClient } = require('../miniapp/utils/room-client');
const { envId } = require('../miniapp/config/cloud');
const error = (r,c) => { assert.equal(r.ok,false); assert.equal(r.error.code,c); };
const op = r => ({ roomId:r.roomId, expectedVersion:r.version });
const batch = r => ({roomId:r.roomId,attemptId:r.attemptId});
async function start(f, config=f.config) {
  let r=(await f.create('a',config)).data.room;
  r=(await f.call('b','join',{code:r.code})).data.room;
  r=(await f.call('a','setReady',{...op(r),ready:true})).data.room;
  r=(await f.call('b','setReady',{...op(r),ready:true})).data.room;
  return (await f.call('a','start',op(r))).data.room;
}
const privateQuestions = f => f.store.records(COLLECTIONS.rooms)[0].attempt.questions;
const answer = (r,q,text) => ({...batch(r),questionId:q.id,answer:text === undefined ? answerText(q) : text});

test('exact comparison rejects rounding, accepts equivalent fractions and distinguishes blank from zero', () => {
  assert.equal(judgeQuestion({answerKind:'decimal',answerTenths:17},'1.74').correct,false);
  assert.equal(judgeQuestion({answerKind:'decimal',answerTenths:17},'1.700').correct,true);
  const q={answerKind:'fraction',answerNumerator:1,answerDenominator:2};
  for (const text of ['2/4','0.5','50/100']) assert.equal(judgeQuestion(q,text).correct,true);
  assert.equal(judgeQuestion(q,'1/0').ok,false);
  assert.equal(judgeQuestion({answerKind:'integer',answer:0},'0').correct,true);
  for (const text of ['', '1+1','1e2','Infinity','NaN','<script>', '0x10', '1/2/3']) assert.equal(parseAnswer(text,'fraction').ok,false,text);
  assert.equal(judgeQuestion({answerKind:'integer',answer:1},'1.0').correct,true);
  assert.equal(judgeQuestion(q,'-0.5').correct,false);
  assert.equal(fs.readFileSync('miniapp/utils/exact-answer.js','utf8'),fs.readFileSync('miniapp/cloudfunctions/roomService/exact-answer.js','utf8'));
});
test('submission enforces member, batch, start boundary and field whitelist', async () => {
  const f=fixture(),r=await start(f),q=privateQuestions(f)[0],payload=answer(r,q);
  error(await f.call('a','submitAnswer',payload),'MATCH_NOT_STARTED');
  f.advance(3000);
  error(await f.call('c','submitAnswer',payload),'NOT_MEMBER');
  error(await f.call('a','submitAnswer',{...payload,attemptId:'a_'+'f'.repeat(40)}),'ATTEMPT_MISMATCH');
  for (const extra of [{score:100},{now:0},{userId:'b'},{expectedVersion:r.version},{correct:true}]) error(await f.call('a','submitAnswer',{...payload,...extra}),'INVALID_ARGUMENT');
  error(await f.call('a','submitAnswer',{...payload,questionId:'q_99'}),'QUESTION_NOT_FOUND');
  error(await f.call('a','submitAnswer',{...payload,answer:'1+1'}),'INVALID_ANSWER');
  assert.equal((await f.call('a','submitAnswer',payload)).ok,true);
});
test('only own accepted inputs and progress are public before settlement; no correctness oracle', async () => {
  const f=fixture(),r=await start(f),q=privateQuestions(f)[0];f.advance(3000);
  const a=(await f.call('a','submitAnswer',answer(r,q))).data.room;
  const b=(await f.call('b','get',{roomId:r.roomId})).data.room;
  assert.equal(a.result,null);assert.equal(b.result,null);
  assert.equal(a.progress.self.answers.length,1);assert.equal(b.progress.self.answers.length,0);
  assert.deepEqual(Object.keys(a.progress.self.answers[0]).sort(),['acceptedAt','answer','questionId']);
  for (const field of ['correct','answerTenths','answerNumerator','score','userId']) assert.equal(JSON.stringify(a).includes('"'+field+'"'),false,field);
  assert.equal(b.progress.players.find(p=>p.role==='host').submitted,1);
});
test('same request replay and concurrent different requests cannot change a locked answer', async () => {
  const f=fixture(),r=await start(f),q=privateQuestions(f)[0];f.advance(3000);
  const id=f.id(),payload=answer(r,q),results=await Promise.all([f.call('a','submitAnswer',payload,id),f.call('a','submitAnswer',payload,id)]);
  assert.ok(results.every(x=>x.ok));assert.equal(results.filter(x=>x.data.operation.replayed).length,1);
  error(await f.call('a','submitAnswer',answer(r,q,'999')), 'ANSWER_LOCKED');
  error(await f.call('a','submitAnswer',answer(r,q,'999'),id),'REQUEST_CONFLICT');
  f.advance(60000);
  const replay=await f.call('a','submitAnswer',payload,id);
  assert.equal(replay.ok,true);assert.equal(replay.data.room.result.scores.find(s=>s.role==='host').score,10);
});
test('different simultaneous submissions to one question lock exactly one answer', async () => {
  const f=fixture(),r=await start(f),q=privateQuestions(f)[0];f.advance(3000);
  const results=await Promise.all([f.call('a','submitAnswer',answer(r,q)),f.call('a','submitAnswer',answer(r,q,'999'))]);
  assert.equal(results.filter(x=>x.ok).length,1);error(results.find(x=>!x.ok),'ANSWER_LOCKED');
  assert.equal(Object.keys(f.store.records(COLLECTIONS.rooms)[0].attempt.players[0].answers).length,1);
});
test('deadline rejects new answers at the exact boundary and persists one final result', async () => {
  for (const elapsed of [59999,60000,60001]) {
    const f=fixture(),r=await start(f),q=privateQuestions(f)[0];f.advance(3000+elapsed);
    const submitted=await f.call('a','submitAnswer',answer(r,q));
    if(elapsed<60000) assert.equal(submitted.ok,true);else { error(submitted,'MATCH_ENDED');assert.equal(f.store.records(COLLECTIONS.rooms)[0].status,'finished'); }
    f.advance(2);const a=(await f.call('a','get',{roomId:r.roomId})).data.room,b=(await f.call('b','get',{roomId:r.roomId})).data.room;
    assert.deepEqual(a.result.scores,b.result.scores);assert.equal(a.result.version,1);assert.equal(a.result.finishedAt,r.endAt);
    assert.equal(a.result.scores[0].score,elapsed<60000?10:0);
  }
});
test('early finish hides results until both finish, locks remaining questions and uses score-only tie break', async () => {
  const f=fixture(),r=await start(f),qs=privateQuestions(f);f.advance(3000);
  await f.call('a','submitAnswer',answer(r,qs[0]));await f.call('b','submitAnswer',answer(r,qs[1]));
  const first=(await f.call('a','finish',batch(r))).data.room;
  assert.equal(first.status,'playing');assert.equal(first.result,null);assert.equal(first.progress.self.finished,true);
  error(await f.call('a','submitAnswer',answer(r,qs[2])),'ALREADY_FINISHED');
  f.advance(5000);const final=(await f.call('b','finish',batch(r))).data.room;
  assert.equal(final.status,'finished');assert.equal(final.result.outcome,'draw');assert.equal(final.result.reason,'both_finished');
  const persisted=f.store.records(COLLECTIONS.rooms)[0],version=persisted.version;
  await f.call('a','finish',batch(r));await f.call('b','get',{roomId:r.roomId});
  assert.equal(f.store.records(COLLECTIONS.rooms)[0].version,version);
});
test('final results include only the caller detail, correct counts and stable unique record IDs', async () => {
  const f=fixture(),r=await start(f),qs=privateQuestions(f);f.advance(3000);
  await f.call('a','submitAnswer',answer(r,qs[0]));await f.call('a','submitAnswer',answer(r,qs[1],'999'));
  f.advance(60000);
  const a=(await f.call('a','get',{roomId:r.roomId})).data.room.result,b=(await f.call('b','get',{roomId:r.roomId})).data.room.result;
  assert.equal(a.outcome,'win');assert.equal(b.outcome,'lose');assert.equal(a.items[0].status,'correct');assert.equal(a.items[1].status,'wrong');
  assert.ok(b.items.every(i=>i.status==='unanswered'&&i.userAnswer===''));assert.notEqual(a.recordId,b.recordId);
  assert.equal(a.scores[0].correct+a.scores[0].wrong+a.scores[0].unanswered,10);
  assert.equal(a.scores[0].accuracyText,'10.0%');
  f.advance(RETAIN_MS);error(await f.call('a','get',{roomId:r.roomId}),'ROOM_NOT_FOUND');
});
test('transaction failure rolls back submission and receipt; retry accepts exactly once', async () => {
  const f=fixture(),r=await start(f),q=privateQuestions(f)[0];f.advance(3000);
  const payload=answer(r,q),id=f.id();f.store.failAtWrite=2;
  error(await f.call('a','submitAnswer',payload,id),'SERVICE_UNAVAILABLE');
  assert.ok(!f.store.records(COLLECTIONS.rooms)[0].attempt.players);
  f.store.failAtWrite=0;assert.equal((await f.call('a','submitAnswer',payload,id)).ok,true);
});
test('lost cloud answer response survives client recreation and settles original accepted answer after deadline', async () => {
  const f=fixture(),r=await start(f),q=privateQuestions(f)[0];f.advance(3000);const values=new Map();let lose=true;
  const wxApi={getStorageSync:k=>values.get(k),setStorageSync:(k,v)=>values.set(k,v),removeStorageSync:k=>values.delete(k),cloud:{init(){},async callFunction({data}) { const result=await f.service(data,f.context('a'));if(lose){lose=false;throw Error('lost');}return{result}; }}};
  const first=createRoomClient({wxApi,envId});await assert.rejects(first.call('submitAnswer',answer(r,q)),{code:'CLOUD_CALL_FAILED'});
  const id=first.pending().requestId;f.advance(60000);
  const next=createRoomClient({wxApi,envId}),response=await next.retryPending();
  assert.equal(response.data.operation.requestId,id);assert.equal(response.data.room.result.scores[0].score,10);assert.equal(next.pending(),null);
});
for(const rule of contract.rules) test('all accepted correct answers score for '+rule.id,async()=>{
  const f=fixture(),r=await start(f,{...f.config,grade:rule.grade,ruleId:rule.id}),qs=privateQuestions(f);f.advance(3000);
  for(const q of qs) assert.equal((await f.call('a','submitAnswer',answer(r,q))).ok,true);
  await f.call('a','finish',batch(r));const end=(await f.call('b','finish',batch(r))).data.room;
  assert.equal(end.result.scores[0].score,100);assert.equal(end.result.scores[0].correct,10);
});
