// 独立复核PR5的页面生命周期；不修改被检目录，不访问云端，不代改提交者代码。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const root=path.resolve(process.argv[2]||'.'),file=path.join(root,'miniapp/pages/practice/practice.js');
const findings=[];
const response={ok:true,source:'local',data:{quizId:'review-quiz',ruleVersion:'review-rule',questions:Array.from({length:10},(_,i)=>({id:'q'+i,text:'1 + 1 = ?',ruleId:'g1_add_20',answerKind:'integer'}))}};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
function harness(service){
  let def,time=100000,id=0;const timers=new Map();
  class Clock extends Date{static now(){return time;}}
  const real=createRequire(file);
  const wxApi={showModal(){},showToast(){},navigateTo(){}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{Page:p=>{def=p;},require:n=>n.includes('services/question-service')?service:real(n),wx:wxApi,Date:Clock,console:{log(){},error(){}},
    setInterval:fn=>{timers.set(++id,fn);return id;},clearInterval:id=>timers.delete(id),setTimeout:()=>0},{filename:file});
  const p={...def,data:structuredClone(def.data),setData(patch){for(const[k,v]of Object.entries(patch)){const parts=k.replace(/\[(\d+)\]/g,'.$1').split('.');let dest=this.data;for(const part of parts.slice(0,-1))dest=dest[part];dest[parts.at(-1)]=structuredClone(v);}}};
  p.onLoad({grade:'1',ruleId:'g1_add_20',count:'10',mode:'timed',durationSeconds:'60'});
  return{p,timers,advance(ms){time+=ms;for(const run of [...timers.values()])run();}};
}
(async()=>{
  const first=harness({createQuestionSet:async()=>response,submitAnswers:async()=>({ok:false,message:'temporary failure'})});await settle();await first.p.submit('manual');
  const timerFailure={timers:first.timers.size,submitted:first.p.submitted,finished:first.p.data.finished};
  if(!first.p.submitted&&!first.p.data.finished&&first.timers.size===0)findings.push('submission-failure-stops-timer');first.p.onUnload();
  let resolveLoad;const load=new Promise(r=>resolveLoad=r);const second=harness({createQuestionSet:()=>load});second.p.onHide();resolveLoad(response);await settle();second.p.onShow();await settle();
  const backgroundLoad={loading:second.p.data.loading,questions:second.p.questions.length};
  if(second.p.data.loading&&second.p.questions.length===0)findings.push('background-load-response-discarded');second.p.onUnload();
  let resolveSubmit;const submitted=new Promise(r=>resolveSubmit=r);const third=harness({createQuestionSet:async()=>response,submitAnswers:()=>submitted});await settle();const pending=third.p.submit('manual');third.p.onHide();
  resolveSubmit({ok:true,source:'local',data:{result:{quizId:'review-quiz',total:10,correct:0,wrong:0,blank:10,accuracyPercent:0,questions:response.data.questions.map(q=>({...q,verdict:'blank',correctText:'1 + 1 = 2'}))}}});await pending;third.p.onShow();await settle();
  const backgroundSubmit={submitting:third.p.data.submitting,submitted:third.p.submitted,hasResult:!!third.p.result};
  if(third.p.submitted&&third.p.data.submitting&&!third.p.result)findings.push('background-submit-response-discarded');third.p.onUnload();
  console.log(JSON.stringify({scope:'local-controlled-lifecycle-probes',timerFailure,backgroundLoad,backgroundSubmit,findings},null,2));if(findings.length)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
