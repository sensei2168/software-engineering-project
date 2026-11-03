const test=require('node:test'),assert=require('node:assert/strict');
const {allowed,cleanExpired}=require('../miniapp/cloudfunctions/roomMaintenance/cleanup');
test('maintenance defaults off and refuses spoofed timers from known client identities',()=>{
  const event={Type:'Timer',TriggerName:'room-cleanup'};
  assert.equal(allowed(event,{},'1'),true);assert.equal(allowed(event,{},undefined),false);
  for(const identity of [{OPENID:'user'},{FROM_OPENID:'user'},{TCB_UUID:'user'},{SOURCE:'wx_client'},{SOURCE:'wx_devtools'}]) assert.equal(allowed(event,identity,'1'),false);
  assert.equal(allowed({Type:'Timer',TriggerName:'wrong'},{},'1'),false);
});
test('cleanup rechecks expiry transactionally, protects renewed codes, and does not accept client cutoff',async()=>{
  const removed=[];
  const store={async listExpired(collection,field,cutoff,limit){assert.equal(cutoff,100);assert.equal(limit,20);return[{id:'expired'},{id:'renewed'},{id:'missing'},{id:'malformed'}];},
    async transaction(run){return run({async get(collection,id){return id==='expired'?{purgeAt:99,expiresAt:100}:id==='renewed'?{purgeAt:101,expiresAt:101}:id==='malformed'?{purgeAt:'1',expiresAt:'1'}:null;},async remove(collection,id){removed.push(collection+'/'+id);}});}};
  const result=await cleanExpired({store,now:()=>100});assert.equal(removed.length,3);assert.ok(removed.every(id=>id.endsWith('/expired')));assert.equal(result.ok,true);
});
