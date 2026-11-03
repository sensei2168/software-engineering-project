const test=require('node:test'),assert=require('node:assert/strict');
const {allowed,cleanExpired}=require('../miniapp/cloudfunctions/roomMaintenance/cleanup');
test('maintenance defaults off and refuses spoofed timers from known client identities',()=>{
  const event={Type:'Timer',TriggerName:'room-cleanup'};
  assert.equal(allowed(event,{},'1'),true);assert.equal(allowed(event,{},undefined),false);
  for(const identity of [{OPENID:'user'},{FROM_OPENID:'user'},{TCB_UUID:'user'},{SOURCE:'wx_client'},{SOURCE:'wx_devtools'}]) assert.equal(allowed(event,identity,'1'),false);
  assert.equal(allowed({Type:'Timer',TriggerName:'wrong'},{},'1'),false);
});
test('cleanup rechecks expiry transactionally and protects renewed codes',async()=>{
  const removed=[];
  const store={async listExpired(collection,field,cutoff,limit){assert.equal(cutoff,100);assert.equal(limit,5);return[{id:'expired'},{id:'renewed'},{id:'missing'},{id:'malformed'}];},
    async transaction(run){return run({async get(collection,id){return id==='expired'?{purgeAt:99,expiresAt:100}:id==='renewed'?{purgeAt:101,expiresAt:101}:id==='malformed'?{purgeAt:'1',expiresAt:'1'}:null;},async remove(collection,id){removed.push(collection+'/'+id);}});}};
  const result=await cleanExpired({store,now:()=>100,dryRun:false});assert.equal(removed.length,1);assert.ok(removed.every(id=>id.endsWith('/expired')));assert.equal(result.ok,true);
});
test('default preview only queries and cannot delete any document',async()=>{
  const result=await cleanExpired({store:{async listExpired(){return[{id:'old'}];},transaction(){throw Error('preview must not mutate');}},now:()=>100});
  assert.equal(result.mode,'preview');assert.equal(result.candidates,1);assert.equal(result.attempted,0);assert.equal(Object.values(result.removed)[0],0);
});
test('five-minute schedule rotates all three collections with one bounded query per invocation',async()=>{
  const collections=[];for(const time of [0,300000,600000])await cleanExpired({store:{async listExpired(c,f,t,n){collections.push(c);assert.equal(n,5);return[];}},now:()=>time});
  assert.equal(new Set(collections).size,3);
});
test('slow query consumes the budget and prevents any new transaction',async()=>{
  let time=0;const result=await cleanExpired({dryRun:false,now:()=>time,store:{async listExpired(){time=1300;return[{id:'old'}];},transaction(){throw Error('budget exceeded');}}});
  assert.equal(result.stoppedForBudget,true);assert.equal(result.attempted,0);assert.equal(result.mayHaveMore,true);
});
test('budget is rechecked after transaction read and prevents a late delete',async()=>{
  let time=0;const result=await cleanExpired({dryRun:false,now:()=>time,store:{async listExpired(){return[{id:'old'}];},async transaction(run){return run({async get(){time=1200;return{purgeAt:0};},remove(){throw Error('late delete');}});}}});
  assert.equal(result.stoppedForBudget,true);assert.equal(Object.values(result.removed)[0],0);
});
test('batch limit is enforced even if the data adapter returns more candidates',async()=>{
  let removed=0;const result=await cleanExpired({dryRun:false,now:()=>100,store:{async listExpired(){return Array.from({length:20},(_,id)=>({id:String(id)}));},async transaction(run){return run({async get(){return{purgeAt:0};},async remove(){removed++;}});}}});
  assert.equal(removed,5);assert.equal(result.mayHaveMore,true);assert.equal(result.candidates,5);
});

test('invalid batch configuration fails before accessing the database',async()=>{
  for(const batchLimit of [0,-1,6,1.5,'1',null])await assert.rejects(cleanExpired({batchLimit,store:{listExpired(){throw Error('must not query');}}}),/INVALID_BATCH_LIMIT/);
});

for(const mode of ['preview','delete'])test('entry obeys deployed '+mode+' limits, ignores caller overrides, and supports emergency off',async()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const source=fs.readFileSync(require.resolve('../miniapp/cloudfunctions/roomMaintenance/index.js'),'utf8');
  let queries=0,deleted=0;
  const settings=mode==='preview'?require('../miniapp/cloudfunctions/roomMaintenance/settings.json'):require('../deployment/roomMaintenance-delete-validation.settings.json');
  const db={command:{lte:v=>v},collection(){return{where(){return{limit(n){assert.equal(n,settings.batchLimit||5);return{async get(){queries++;return{data:[{_id:'expired'},{_id:'second'}]};}};}};}};},async runTransaction(run){
    assert.equal(mode,'delete');return run({collection(){return{doc(){return{async get(){return{data:{purgeAt:0,expiresAt:0}};},async remove(){deleted++;}};}};}});
  }};
  const env={}, exported={};
  vm.runInNewContext(source,{exports:exported,process:{env},console,require(name){
    if(name==='wx-server-sdk')return{init(){},database(){return db;},getWXContext(){return{};}};
    if(name==='./cleanup')return require('../miniapp/cloudfunctions/roomMaintenance/cleanup');
    if(name==='./settings.json')return settings;
    throw Error('unexpected dependency');
  }});
  const event={Type:'Timer',TriggerName:'room-cleanup',mode:mode==='preview'?'delete':'preview',dryRun:false,batchLimit:100};
  const result=await exported.main(event);
  assert.equal(result.mode,mode);assert.equal(queries,1);assert.equal(deleted,mode==='delete'?1:0);
  if(mode==='delete'){assert.equal(result.batchLimit,1);assert.equal(result.candidates,1);assert.equal(result.attempted,1);assert.equal(Object.values(result.removed)[0],1);}
  env.ROOM_MAINTENANCE_ENABLED='0';assert.equal((await exported.main(event)).error,'MAINTENANCE_DISABLED_OR_FORBIDDEN');assert.equal(queries,1);
});
