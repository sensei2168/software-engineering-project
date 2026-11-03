const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {createRequire}=require('node:module');
const {selectedItems,gradeCorrection}=require('../miniapp/utils/correction');
const store=require('../miniapp/utils/record-store');
const record={practiceId:'original',kind:'match',match:{outcome:'win',scores:[],selfRole:'host'},ruleVersion:'old-rule',items:[
  {expression:'1.2 + 0.5 = ?',question:{answerKind:'decimal',answerTenths:17},correctAnswer:'1.7',userAnswer:'1.74',status:'wrong'},
  {expression:'1/4 + 1/4 = ?',question:{answerKind:'fraction',answerNumerator:2,answerDenominator:4},correctAnswer:'2/4',userAnswer:'',status:'unanswered'},
  {expression:'0 + 0 = ?',question:{answerKind:'integer',answer:0},correctAnswer:'0',userAnswer:'0',status:'correct'}]};
test('correction selects only mistakes and missing answers, grades exact equivalents and keeps blank separate',()=>{
  assert.equal(selectedItems(record).length,2);
  assert.equal(gradeCorrection(record.items[0],'1.74').status,'wrong');assert.equal(gradeCorrection(record.items[0],'1.700').status,'correct');
  assert.equal(gradeCorrection(record.items[1],'1/2').status,'correct');assert.equal(gradeCorrection(record.items[1],'1/0').ok,false);
  assert.equal(gradeCorrection(record.items[2],'0').status,'correct');assert.equal(gradeCorrection(record.items[2],'').status,'unanswered');
  assert.equal(gradeCorrection({correctAnswer:'0.5'},'2/4').status,'correct');assert.throws(()=>selectedItems({...record,isDevData:true}));
});
test('correction saves a separate immutable record, retries a storage failure and opens the result',t=>{
  const values=new Map();let fail=false,route;
  global.wx={getStorageSync:k=>structuredClone(values.get(k)),setStorageSync:(k,v)=>{if(fail)throw Error('full');values.set(k,structuredClone(v));},redirectTo:o=>{route=o.url;}};
  t.after(()=>delete global.wx);assert.equal(store.saveRecord(record).ok,true);const original=store.getRecord('original').record;
  const file=path.resolve('miniapp/pages/correction/correction.js');let def;
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:createRequire(file),Page:p=>{def=p;},wx:global.wx,Date,Math});
  const p={...def,data:structuredClone(def.data),setData(patch){Object.assign(this.data,patch);}};p.onLoad({id:'original'});
  p.inputAnswer({currentTarget:{dataset:{index:0}},detail:{value:'1.7'}});p.inputAnswer({currentTarget:{dataset:{index:1}},detail:{value:'1/2'}});
  fail=true;p.submit();assert.equal(p.data.submitted,true);assert.equal(p.data.saved,false);assert.ok(p.data.error);
  fail=false;p.save();p.save();assert.equal(store.loadRecords().records.length,2);
  const correction=store.getRecord(p.data.resultId).record;assert.equal(correction.kind,'correction');assert.equal(correction.sourceRecordId,'original');assert.equal(correction.summary.correct,2);assert.equal(correction.ruleVersion,'old-rule');
  assert.deepEqual(store.getRecord('original').record,original);p.showResult();assert.match(route,/pages\/result\/result\?id=/);
});
