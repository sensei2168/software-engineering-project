// 从实际结果／订正页面数据和原生模板生成近似浏览器布局，不能代替微信真机。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),cp=require('node:child_process');
const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
const {parse,render,measure}=require('./room-layout.browser.cjs');
const store=require('../miniapp/utils/record-store');
const root=path.resolve('miniapp'),out=path.resolve('.artifacts/result-layout');fs.mkdirSync(out,{recursive:true});
const values=new Map();global.wx={getStorageSync:k=>values.get(k),setStorageSync:(k,v)=>values.set(k,v),getAccountInfoSync:()=>({miniProgram:{envVersion:'release'}}),showToast(){},showModal(){}};
function load(name,options) {
  const file=path.join(root,'pages',name,name+'.js');let def;
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{Page:p=>{def=p;},require:createRequire(file),wx:global.wx,Date,Math});
  const p={...def,data:structuredClone(def.data),setData(patch){Object.assign(this.data,patch);}};p.onLoad(options);return p;
}
const cases=[];
for (const [kind,item] of [
  ['integer',{expression:'18 + 6 × 3 = ?',question:{answerKind:'integer',answer:36},correctAnswer:'36',userAnswer:'72',status:'wrong'}],
  ['decimal',{expression:'1.2 + 0.5 = ?',question:{answerKind:'decimal',answerTenths:17},correctAnswer:'1.7',userAnswer:'1.74',status:'wrong'}],
  ['fraction',{expression:'1/4 + 1/4 = ?',question:{answerKind:'fraction',answerNumerator:2,answerDenominator:4},correctAnswer:'2/4',userAnswer:'',status:'unanswered'}]
]) {
  const saved=store.saveRecord({practiceId:'layout-'+kind,kind:'match',match:{outcome:'lose',selfRole:'host',scores:[{role:'host',score:0,accuracyText:'0.0%'},{role:'guest',score:10,accuracyText:'100.0%'}]},items:[item],configText:'三年级 · 扩展题型 · 双人比赛'});
  if(!saved.ok)throw Error(saved.error);
  const r=load('result',{id:saved.record.id});cases.push(['result',kind,r.data]);
  const c=load('correction',{id:saved.record.id});cases.push(['correction',kind,structuredClone(c.data)]);
  c.inputAnswer({currentTarget:{dataset:{index:0}},detail:{value:item.correctAnswer}});c.submit();cases.push(['correction',kind+'-submitted',c.data]);
}
cases.push(['result','empty',load('result',{}).data]);
const pages=[];
for(const width of [320,375,430])for(const [name,label,data] of cases){
  const styles=fs.readFileSync(path.join(root,'app.wxss'),'utf8')+'\n'+fs.readFileSync(path.join(root,'pages',name,name+'.wxss'),'utf8');
  const css=styles.replace(/(^|\n)page\s*\{/g,'$1body {').replace(/([\d.]+)rpx/g,(_,n)=>Number(n)*width/750+'px');
  const html='<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;width:'+width+'px}button,input{font-family:inherit;display:block;width:100%}#layout-result{display:none}'+css+'</style>'+render(parse(fs.readFileSync(path.join(root,'pages',name,name+'.wxml'),'utf8')),data)+'<script>('+measure.toString()+')();</script>';
  const id=width+'-'+name+'-'+label;fs.writeFileSync(path.join(out,id+'.html'),html);pages.push([id,html]);
}
async function check(pages){
  if(!document.body)await new Promise(r=>document.addEventListener('DOMContentLoaded',r,{once:true}));const results=[];
  for(const[name,html]of pages){const frame=document.createElement('iframe');frame.style.width=name.split('-')[0]+'px';const loaded=new Promise(r=>frame.onload=r);frame.srcdoc=html;document.body.append(frame);await loaded;results.push({name,issues:JSON.parse(frame.contentDocument.querySelector('#layout-result').textContent)});frame.remove();}
  const el=document.createElement('pre');el.id='results';el.textContent=JSON.stringify(results);document.body.append(el);
}
const file=path.join(out,'check.html');fs.writeFileSync(file,'<!doctype html><meta charset="utf-8"><script>'+('('+check.toString()+')('+JSON.stringify(pages)+');').replace(/<\/script/gi,'<\\/script')+'</script>');
const run=cp.spawnSync(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless','--disable-gpu','--no-first-run','--user-data-dir='+path.join(out,'profile'),'--virtual-time-budget=10000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:30000,maxBuffer:6*1024*1024});
const match=(run.stdout||'').match(/<pre id="results">([\s\S]*?)<\/pre>/);if(!match)throw Error('Missing layout result');
const results=JSON.parse(match[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')),failures=results.filter(x=>x.issues.length);
console.log(JSON.stringify({cases:results.length,passed:results.length-failures.length,failures}));if(failures.length)process.exitCode=1;
