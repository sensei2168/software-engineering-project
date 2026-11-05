const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const {createRequire}=require('node:module');
const service=require('../miniapp/services/question-service');
const draft=require('../miniapp/utils/practice-draft');
const records=require('../miniapp/utils/record-store');
const file=path.resolve(__dirname,'../miniapp/pages/practice/practice.js');
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
function setup(t){
  let time=100000,fail=false; const storage=new Map();
  global.wx={getStorageSync:k=>structuredClone(storage.get(k)),setStorageSync(k,v){if(fail)throw Error('full');storage.set(k,structuredClone(v));},showModal(){},showToast(){}};
  t.after(()=>{delete global.wx;service._clearLocalSessions();});
  class Clock extends Date{static now(){return time;}}
  function page(options){let def;vm.runInNewContext(fs.readFileSync(file,'utf8'),{Page:p=>def=p,require:createRequire(file),wx:global.wx,Date:Clock,console:{log(){},error(){}},setTimeout(){},setInterval(){return 1;},clearInterval(){}});
    const p={...def,data:structuredClone(def.data),setData(patch){for(const[k,v]of Object.entries(patch)){const parts=k.replace(/\[(\d+)\]/g,'.$1').split('.');let dst=this.data;for(const part of parts.slice(0,-1))dst=dst[part];dst[parts.at(-1)]=structuredClone(v);}}};p.onLoad(options);return p;}
  return {page,storage,advance(ms){time+=ms;},fail(value){fail=value;}};
}
const config={grade:'1',ruleId:'g1_add_20',count:'10',mode:'timed',durationSeconds:'60'};
test('restart restores exact questions, answers and deadline; expired restart auto-submits only once',async t=>{
  const h=setup(t),first=h.page(config);await flush();
  first.onAnswerInput({currentTarget:{dataset:{index:0}},detail:{value:'7'}});
  const id=first.data.quizId,questions=JSON.stringify(first.questions);first.onUnload();service._clearLocalSessions();
  h.advance(10000);const second=h.page({resume:'1'});await flush();
  assert.equal(second.data.quizId,id);assert.equal(JSON.stringify(second.questions),questions);assert.equal(second.answers[0],'7');
  assert.equal(second.startTime,100000);assert.equal(second.data.remainingSeconds,50);
  second.onUnload();service._clearLocalSessions();h.advance(60000);
  const third=h.page({resume:'1'});await flush();assert.equal(third.data.finished,true);assert.equal(third.result.finishedBy,'timeup');
  assert.equal(records.loadRecords().records.length,1);assert.equal(draft.read().draft,null);
  third.onShow();third.onUnload();assert.equal(draft.read().draft,null);
});
test('fraction partial input survives restart and ordinary mode has no artificial deadline',async t=>{
  const h=setup(t),first=h.page({grade:'3',ruleId:'g3_fraction_same_den',count:'10',mode:'normal',durationSeconds:'60'});await flush();
  first.onFractionInput({currentTarget:{dataset:{part:'numerator'}},detail:{value:'2'}});first.onUnload();service._clearLocalSessions();h.advance(1000000);
  const resumed=h.page({resume:'1'});await flush();assert.equal(resumed.data.finished,false);assert.equal(resumed.answers[0],'2/');assert.equal(resumed.data.fractionNumerator,'2');
  resumed.onUnload();
});
test('failed writes are visible and damaged drafts are preserved rather than replaced',async t=>{
  const h=setup(t),p=h.page(config);await flush();h.fail(true);
  p.onAnswerInput({currentTarget:{dataset:{index:0}},detail:{value:'9'}});assert.match(p.data.draftWarning,/保存失败/);assert.equal(p.answers[0],'9');
  h.fail(false);p.onHide();assert.equal(draft.read().draft.answers[0],'9');p.onUnload();
  h.storage.set(draft.KEY,{version:999});const bad=h.page({resume:'1'});assert.ok(bad.data.error);assert.equal(h.storage.get(draft.KEY).version,999);
});
test('interrupted manual submission is retried with the original quiz and answers after restart',async t=>{
  const h=setup(t),p=h.page(config);await flush();p.answers[0]='2';
  const original=service.submitAnswers;let resolve;
  service.submitAnswers=()=>new Promise(r=>resolve=r);
  t.after(()=>{service.submitAnswers=original;});
  const pending=p.submit('manual');assert.equal(draft.read().draft.pending,'manual');p.onUnload();
  service.submitAnswers=original;service._clearLocalSessions();
  const resumed=h.page({resume:'1'});await flush();assert.equal(resumed.data.finished,true);assert.equal(resumed.result.quizId,p.data.quizId);
  assert.equal(records.loadRecords().records.length,1);assert.equal(draft.read().draft,null);
  resolve({ok:false});await pending;assert.equal(draft.read().draft,null);resumed.onUnload();
});
for (const mode of ['normal', 'timed']) test('mixed '+mode+' paper survives restart, grading, history and correction', async t=>{
  const h=setup(t), ids=['g3_mixed_2step','g3_decimal_1place','g3_fraction_same_den'];
  const first=h.page({...config,grade:'3',ruleId:ids[0],ruleIds:ids.join(','),mode});
  await flush();
  const questions=JSON.stringify(first.questions);
  assert.equal(new Set(first.questions.map(q=>q.id)).size,10);
  assert.deepEqual(Array.from(first.questions,q=>q.ruleId),[...ids,...ids,...ids,ids[0]]);
  first.goTo(2); first.onFractionInput({currentTarget:{dataset:{part:'numerator'}},detail:{value:'2'}});
  first.onUnload();service._clearLocalSessions();h.advance(10000);
  const p=h.page({resume:'1'});await flush();
  assert.equal(JSON.stringify(p.questions),questions);assert.equal(p.answers[2],'2/');
  if(mode==='timed'){assert.equal(p.data.remainingSeconds,50);h.advance(51000);p.tick();await flush();}
  else await p.submit('manual');
  assert.equal(p.data.finished,true);
  const record=records.getRecord(p.savedRecordId).record;
  assert.deepEqual(Array.from(record.config.ruleIds),ids);assert.match(record.configText,/小数/);assert.match(record.configText,/分数/);
  const {gradeCorrection}=require('../miniapp/utils/correction');
  for(const item of record.items)assert.equal(gradeCorrection(item,item.correctAnswer).status,'correct');
  p.onUnload();
});
test('opening new settings cannot silently overwrite unfinished work',async t=>{
  const h=setup(t),first=h.page(config);await flush();const id=first.data.quizId;first.onUnload();
  const other=h.page({...config,count:'20'});await flush();assert.match(other.data.error,/已有未完成/);assert.equal(draft.read().draft.quizId,id);
});
