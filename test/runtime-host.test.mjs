import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../runtime-host.js',import.meta.url),'utf8');
function host(){
 let listener;const workers=[],timers=new Map();let next=0;
 class Worker{constructor(url,options){assert.equal(url,'vendor/extension-runtime.js');assert.equal(options.type,'module');workers.push(this);this.sent=[];}postMessage(msg){this.sent.push(msg);}terminate(){this.terminated=true;}}
 const context={Worker,crypto:globalThis.crypto,setTimeout:fn=>{const id=++next;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),chrome:{runtime:{id:'fixture',getURL:path=>'chrome-extension://fixture/'+path,onMessage:{addListener:fn=>listener=fn},sendMessage:async()=>({ok:true,data:{}})}}};
 vm.runInNewContext(source,context);
 return {workers,timers,request:(msg,sender={id:'fixture'})=>new Promise(resolve=>{if(listener({target:'offscreen-runtime',...msg},sender,resolve)===false)resolve({ignored:true});})};
}
test('offscreen host bounds hung commands and recreates failed workers without replaying old commands',async()=>{
 const h=host();await h.request({type:'tabpilot:runtime-ping'});assert.equal(h.workers.length,1);
 const command=h.request({type:'tabpilot:runtime-command',method:'task-create',payload:{prompt:'test'}});
 h.workers[0].onerror();assert.equal((await command).ok,false);assert.equal(h.workers[0].terminated,true);
 await h.request({type:'tabpilot:runtime-ping'});assert.equal(h.workers.length,2);assert.equal(h.workers[1].sent.length,0);
 const hung=h.request({type:'tabpilot:runtime-command',method:'state'});[...h.timers.values()][0]();
 assert.match((await hung).error,/interrupted/);assert.equal(h.workers[1].terminated,true);
});
test('offscreen host resolves commands and clears their timeout without ending the agent worker',async()=>{
 const h=host();const promise=h.request({type:'tabpilot:runtime-command',method:'state'});
 const worker=h.workers[0];await worker.onmessage({data:{id:worker.sent[0].id,result:{ok:true,state:{status:'idle'}}}});
 assert.equal((await promise).state.status,'idle');assert.equal(h.timers.size,0);assert.equal(worker.terminated,undefined);
});

test('offscreen host rejects content scripts, foreign senders and extension pages that bypass the background',async()=>{
 const h=host();
 for(const sender of [{id:'fixture',tab:{id:12},url:'https://example.com/'},{id:'foreign'},{id:'fixture',url:'chrome-extension://fixture/sidepanel.html'}]) {
  assert.equal((await h.request({type:'tabpilot:runtime-command',method:'runtime-configure',payload:{}},sender)).ignored,true);
 }
 assert.equal(h.workers.length,0);
});
