import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { backgroundSource, mockDebugger } from './background-source.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const extensionPage = {id:'test',url:'chrome-extension://test/sidepanel.html',tab:{id:80}};
const offscreenPage = {id:'test',url:'chrome-extension://test/attention-audio.html'};
const token = 'a'.repeat(64);
const flush = () => new Promise(resolve=>setImmediate(resolve));
async function until(check) {for(let i=0;i<100;i++){if(check())return;await flush();}assert.fail('Background did not settle');}

function setup({localValues={},jobs=[],unsupported=false}={}) {
 let listener, alarmListener, documentExists=false, created=0;
 const local={...localValues},session={},messages=[],sockets=[],levels=[];
 const area = values => ({
  async get(keys) {const selected=keys===null?Object.keys(values):Array.isArray(keys)?keys:[keys];return Object.fromEntries(selected.filter(key=>key in values).map(key=>[key,structuredClone(values[key])]));},
  async set(items) {Object.assign(values,structuredClone(items));},
  async remove(keys) {for(const key of Array.isArray(keys)?keys:[keys])delete values[key];},
  async setAccessLevel(value) {levels.push(value.accessLevel);}
 });
 const state=()=>({sessionId:'extension-test',revision:1,status:'idle',jobs,requests:[],settings:{soundAlerts:false},runtime:{executionMode:'extension',configuredFields:[]}});
 class Socket {
  static OPEN=1;
  constructor(url){this.url=url;this.readyState=1;this.sent=[];sockets.push(this);queueMicrotask(()=>this.onopen?.());}
  send(raw){const message=JSON.parse(raw);this.sent.push(message);
   if(message.type==='authenticate')queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:'ready'})}));
   if(message.type==='agent-request')queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:'agent-response',id:message.id,ok:true,state:{sessionId:'bridge-test',revision:1,jobs:[],requests:[],settings:{soundAlerts:false}}})}));
  }
  close(){this.readyState=3;this.onclose?.();}
 }
 const chrome={
  runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,onMessage:{addListener:fn=>{listener=fn;}},onStartup:{addListener(){}},
   async getContexts(query){assert.deepEqual(clone(query.documentUrls),['chrome-extension://test/attention-audio.html']);return documentExists?[{documentUrl:query.documentUrls[0]}]:[];},
   async sendMessage(message){messages.push(clone(message));
    if(message.type==='tabpilot:runtime-ping')return {ok:true};
    if(message.type==='tabpilot:runtime-command')return {ok:true,state:state(),runtime:{executionMode:'extension',configuredFields:[]}};
   }
  },
  offscreen:{async createDocument(options){created++;assert.ok(options.reasons.includes('WORKERS'));documentExists=true;}},
  storage:{local:area(local),session:area(session)},
  tabs:{onRemoved:{addListener(){}},async query(){return [{id:12,url:'https://example.com',title:'Allowed'},{id:34,url:'https://other.example',title:'Revoked'},{id:50,url:'chrome://settings',title:'Protected'}];},async get(id){return {id,url:'https://example.com',windowId:1};}},
  alarms:{onAlarm:{addListener:fn=>{alarmListener=fn;}},async create(name,options){assert.equal(name,'tabpilot-scheduler');assert.equal(options.periodInMinutes,1);}}
 };
 if(unsupported){delete chrome.offscreen;delete chrome.runtime.getContexts;}
 mockDebugger(chrome,async()=>({title:'Example',text:'Current page',truncated:false}));
 vm.runInNewContext(backgroundSource,{chrome,URL,crypto:globalThis.crypto,setTimeout,clearTimeout,WebSocket:Socket});
 return {local,session,messages,sockets,levels,get created(){return created;},alarm:()=>alarmListener({name:'tabpilot-scheduler'}),
  request(message,sender=extensionPage){return new Promise(resolve=>listener(message,sender,resolve));}
 };
}

test('background defaults to extension runtime without a websocket and forwards task commands with browser context',async()=>{
 const worker=setup();
 const initial=await worker.request({type:'tabpilot:ui-state'});
 assert.equal(initial.connected,true);assert.equal(initial.executionMode,'extension');assert.equal(initial.agent.sessionId,'extension-test');
 assert.equal(worker.created,1);assert.equal(worker.sockets.length,0);assert.deepEqual(worker.levels,['TRUSTED_CONTEXTS','TRUSTED_CONTEXTS']);
 const payload={prompt:'Read this page',tabId:12,mode:'browser'};
 const reply=await worker.request({type:'tabpilot:agent',method:'task-create',payload});
 assert.equal(reply.ok,true);
 const forwarded=worker.messages.find(message=>message.method==='task-create');
 assert.deepEqual(forwarded.payload,payload);assert.equal(forwarded.context.enabled,true);
 assert.match(forwarded.context.scope,/^[a-f0-9-]{36}$/i);assert.match(forwarded.context.profileId,/^[a-f0-9-]{36}$/i);
 assert.equal(worker.created,1);assert.equal(worker.sockets.length,0);
 const pairing=await worker.request({type:'tabpilot:connect',token});assert.equal(pairing.ok,false);assert.match(pairing.error,/Developer settings/);
});

test('explicit developer mode suspends extension execution, pairs the optional bridge, and can return to extension mode',async()=>{
 const worker=setup();
 const changed=await worker.request({type:'tabpilot:agent',method:'runtime-configure',payload:{executionMode:'bridge'}});
 assert.equal(changed.ok,true,changed.error);assert.equal(worker.local.extensionExecutionMode,'bridge');
 assert.ok(worker.messages.some(message=>message.method==='suspend'));
 assert.equal((await worker.request({type:'tabpilot:connect',token})).ok,true);
 assert.equal(worker.sockets.length,1);assert.equal(worker.sockets[0].url,'ws://127.0.0.1:4311/extension');
 assert.equal(worker.sockets[0].sent[0].type,'authenticate');
 const result=await worker.request({type:'tabpilot:agent',method:'state'});
 assert.equal(result.state.sessionId,'bridge-test');
 assert.ok(worker.sockets[0].sent.some(message=>message.type==='agent-request'&&message.method==='state'));
 const ui=await worker.request({type:'tabpilot:ui-state'});assert.equal(ui.connected,true);assert.equal(ui.executionMode,'bridge');
 await worker.request({type:'tabpilot:agent',method:'runtime-configure',payload:{executionMode:'extension'}});
 assert.equal(worker.local.extensionExecutionMode,'extension');assert.equal(worker.sockets[0].readyState,3);
 assert.ok(worker.messages.some(message=>message.method==='activate'&&message.context.enabled));
 assert.equal((await worker.request({type:'tabpilot:ui-state'})).executionMode,'extension');
});

test('background rejects webpage and foreign senders before dispatching agent or runtime work',async()=>{
 const worker=setup();
 for(const sender of [{id:'test',url:'https://example.com',tab:{id:12}},{id:'foreign',url:offscreenPage.url}]) {
  for(const type of ['tabpilot:agent','tabpilot:ui-state','tabpilot:runtime-rpc']) {
   const response=await worker.request({type,method:'task-create',operation:'storage-get',payload:{area:'local',key:null}},sender);
   assert.equal(response.ok,false);
  }
 }
 assert.equal(worker.messages.length,0);assert.equal(worker.sockets.length,0);
 const denied=await worker.request({type:'tabpilot:runtime-rpc',operation:'storage-get',payload:{area:'local',key:null}},extensionPage);
 assert.equal(denied.ok,false);assert.match(denied.error,/Only the extension runtime/);
 const lookalike=await worker.request({type:'tabpilot:runtime-rpc',operation:'storage-get',payload:{area:'local',key:null}},{...offscreenPage,url:offscreenPage.url+'?spoof=1'});
 assert.equal(lookalike.ok,false);
});

test('offscreen runtime storage RPC is confined to the dedicated namespace and trusted Chrome storage',async()=>{
 const worker=setup({localValues:{unrelatedSecret:'keep-private',extensionAgentSettings:{provider:'openai'}}});
 const rpc=(operation,payload)=>worker.request({type:'tabpilot:runtime-rpc',operation,payload},offscreenPage);
 const all=await rpc('storage-get',{area:'local',key:null});
 assert.equal(all.ok,true);assert.deepEqual(clone(all.data),{extensionAgentSettings:{provider:'openai'}});
 assert.equal((await rpc('storage-get',{area:'sync',key:'extensionCredentials'})).ok,false);
 assert.equal((await rpc('storage-get',{area:'local',key:'unrelatedSecret'})).ok,false);
 assert.equal((await rpc('storage-set',{area:'local',items:{extensionAllowed:1,unrelatedSecret:'changed'}})).ok,false);
 assert.equal(worker.local.unrelatedSecret,'keep-private');assert.equal(worker.local.extensionAllowed,undefined);
 assert.equal((await rpc('storage-set',{area:'session',items:{extensionSessionCredentials:{OPENAI_API_KEY:'fixture-only'}}})).ok,true);
 assert.equal(worker.session.extensionSessionCredentials.OPENAI_API_KEY,'fixture-only');
 assert.equal((await rpc('storage-remove',{area:'session',key:'extensionSessionCredentials'})).ok,true);
 assert.equal(worker.session.extensionSessionCredentials,undefined);
});

test('offscreen browser RPC keeps tab revocations and developer-mode execution boundary',async()=>{
 const worker=setup();worker.session['tab:34']=false;
 const request={type:'tabpilot:runtime-rpc',operation:'browser',payload:{method:'tabs'}};
 const tabs=await worker.request(request,offscreenPage);
 assert.equal(tabs.ok,true);assert.deepEqual(clone(tabs.data).map(tab=>tab.id),[12]);
 const localDownload=await worker.request({...request,payload:{method:'download-local',tabId:12}},offscreenPage);
 assert.equal(localDownload.ok,false);assert.match(localDownload.error,/optional Developer bridge/);
 await worker.request({type:'tabpilot:agent',method:'runtime-configure',payload:{executionMode:'bridge'}});
 const denied=await worker.request(request,offscreenPage);assert.equal(denied.ok,false);assert.match(denied.error,/disabled in local server mode/);
});

test('mode changes cannot interrupt active tasks and scheduler alarms only dispatch in extension mode',async()=>{
 const active=setup({jobs:[{id:'job',status:'needs-input'}]});
 await active.request({type:'tabpilot:ui-state'});
 const blocked=await active.request({type:'tabpilot:agent',method:'runtime-configure',payload:{executionMode:'bridge'}});
 assert.equal(blocked.ok,false);assert.match(blocked.error,/Stop active tasks/);assert.equal(active.local.extensionExecutionMode,undefined);
 const worker=setup();worker.alarm();await until(()=>worker.messages.some(message=>message.method==='tick'));
 const count=worker.messages.filter(message=>message.method==='tick').length;
 await worker.request({type:'tabpilot:agent',method:'runtime-configure',payload:{executionMode:'bridge'}});
 worker.alarm();await flush();await flush();
 assert.equal(worker.messages.filter(message=>message.method==='tick').length,count);
});

 test('unsupported extension hosts can select the optional developer bridge without starting an offscreen document',async()=>{
 const worker=setup({unsupported:true});
 const initial=await worker.request({type:'tabpilot:ui-state'});assert.equal(initial.connected,false);assert.match(initial.error,/does not support/);
 const changed=await worker.request({type:'tabpilot:agent',method:'runtime-configure',payload:{executionMode:'bridge'}});assert.equal(changed.ok,true);
 assert.equal(worker.local.extensionExecutionMode,'bridge');
 assert.equal((await worker.request({type:'tabpilot:connect',token})).ok,true);
 assert.equal(worker.created,0);
});
