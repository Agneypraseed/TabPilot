import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Usage, RunContext } from '@openai/agents';
import { createExtensionRuntime } from '../extension-runtime.mjs';

function fixture() {
 const data={local:{},session:{}}; const operations=[];
 const rpc=async(operation,payload)=>{
  operations.push({operation,payload:structuredClone(payload)});
  if(operation==='browser') {
   assert.ok(!JSON.stringify(payload).includes('localhost'));
   if(payload.method==='tabs')return [{id:12,title:'Test page',url:'https://example.com/'}];
   if(payload.method==='snapshot')return {title:'Example Domain',url:'https://example.com/',text:'Example Domain',truncated:false,elements:[]};
   throw new Error('Unexpected browser action');
  }
  const area=data[payload.area];
  if(operation==='storage-set'){Object.assign(area,structuredClone(payload.items));return;}
  if(operation==='storage-remove'){for(const key of Array.isArray(payload.key)?payload.key:[payload.key])delete area[key];return;}
  if(operation==='storage-get')return structuredClone(payload.key===null?area:Object.fromEntries((Array.isArray(payload.key)?payload.key:[payload.key]).filter(k=>k in area).map(k=>[k,area[k]])));
  throw new Error('Unknown operation');
 };
 return {rpc,data,operations,scope:randomUUID(),profileId:randomUUID()};
}
const secret='test-provider-key-not-for-display';
const settings={provider:'openai',model:'test-model',maxTurns:8,timeoutMs:60000,approvalMode:'important',soundAlerts:false,downloadDirectory:'/browser/downloads'};
async function until(check){for(let n=0;n<500;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Task did not settle');}

test('extension starts without a server, keeps keys session-only by default, never returns credentials',async t=>{
 const f=fixture();const runtime=await createExtensionRuntime(f);t.after(()=>runtime.close());
 assert.equal(runtime.snapshot().executionMode,'extension');
 assert.equal(runtime.snapshot().runtime.rememberCredentials,false);
 const response=await runtime.command('runtime-configure',{credentials:{OPENAI_API_KEY:secret}});
 assert.ok(!JSON.stringify(response).includes(secret));
 assert.equal(f.data.session.extensionSessionCredentials.OPENAI_API_KEY,secret);
 assert.equal(f.data.local.extensionCredentials,undefined);
 await runtime.command('settings',settings);
 const persisted=await runtime.command('runtime-configure',{rememberCredentials:true});
 assert.equal(persisted.runtime.rememberCredentials,true);
 assert.equal(f.data.local.extensionCredentials.OPENAI_API_KEY,secret);
 assert.equal(f.data.session.extensionSessionCredentials,undefined);
 await runtime.command('runtime-configure',{rememberCredentials:false});
 assert.equal(f.data.local.extensionCredentials,undefined);
 await runtime.command('runtime-configure',{clearCredentials:['OPENAI_API_KEY']});
 assert.ok(!runtime.snapshot().runtime.configuredFields.includes('OPENAI_API_KEY'));
 await assert.rejects(runtime.command('runtime-configure',{credentials:{unexpected:'value'}}));
 await assert.rejects(runtime.command('runtime-configure',{credentials:{COMPATIBLE_BASE_URL:'https://user:pass@example.com/api'}}));
});

test('real SDK runs selected-tab tools directly, pauses for actual input, completes with scoped persistent history',async t=>{
 const f=fixture();const states=[];let turn=0;
 const call=(name,args)=>({usage:new Usage({requests:1}),output:[{type:'function_call',callId:'call-'+turn,name,arguments:JSON.stringify(args)}]});
 const model={async getResponse(request){
  ++turn;
  assert.ok(request.tools.some(tool=>tool.name==='browser_snapshot'));
  assert.ok(!request.tools.some(tool=>tool.name==='browser_download_local'));
  if(turn===1)return call('browser_snapshot',{tabId:12});
  if(turn===2){assert.match(JSON.stringify(request.input),/Example Domain/);return call('request_user_help',{kind:'information',question:'Which title should I report?',detail:'Test question'});}
  if(turn===3){assert.match(JSON.stringify(request.input),/Use the observed title/);return call('complete_task',{summary:'Example Domain',evidence:'Observed Example Domain in selected-tab snapshot'});}
  return {usage:new Usage({requests:1}),output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Example Domain'}]}]};
 },async *getStreamedResponse(){throw new Error('Not requested');}};
 const runtime=await createExtensionRuntime({...f,onState:state=>states.push(state),configure:async(env,options)=>{assert.equal(env.OPENAI_API_KEY,secret);assert.equal(options.browser,true);return {model,modelSettings:{store:false},close:async()=>{}};}});t.after(()=>runtime.close());
 await runtime.command('runtime-configure',{credentials:{OPENAI_API_KEY:secret}});
 await runtime.command('settings',settings);
 await runtime.command('task-create',{prompt:'Read the title and ask which title to report.',tabId:12,mode:'browser',maxStages:1,allowResearch:false});
 await until(()=>runtime.snapshot().requests.length===1);
 const pending=runtime.snapshot().requests[0];assert.equal(turn,2);
 await assert.rejects(runtime.command('runtime-configure',{rememberCredentials:true}),/Stop active/);
 await assert.rejects(runtime.command('human-response',{id:pending.id,runId:pending.runId,scope:randomUUID(),decision:'answer',text:'Wrong scope'}),/no longer pending|Reconnect the browser|different browser session/);
 await runtime.command('human-response',{id:pending.id,runId:pending.runId,scope:f.scope,decision:'answer',text:'Use the observed title'});
 await until(()=>!runtime.manager.active);
 assert.equal(runtime.snapshot().jobs[0].status,'completed');assert.equal(runtime.snapshot().jobs[0].evidence,'Observed Example Domain in selected-tab snapshot');
 assert.ok(states.some(state=>state.status==='needs-input'));
 const list=await runtime.command('history-list',{tabId:12});
 assert.equal(list.history.runs.length,1);
 const history=await runtime.command('history-events',{tabId:12,runId:list.history.runs[0].runId});
 assert.match(JSON.stringify(history),/Example Domain/);
 assert.ok(!JSON.stringify(states).includes(secret));
 assert.ok(f.operations.filter(op=>op.operation==='browser').every(op=>op.payload.tabId===undefined||op.payload.tabId===12));
});

test('persisted extension tasks recover interrupted runs and suspend/activate without a bridge',async t=>{
 const f=fixture();let entered=false;
 const runtime=await createExtensionRuntime({...f,run:async(_prompt,options)=>{entered=true;await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));},configure:async()=>({model:{},modelSettings:{},close:async()=>{}})});
 await runtime.command('runtime-configure',{credentials:{OPENAI_API_KEY:secret}});
 await runtime.command('task-create',{prompt:'Wait',tabId:12,mode:'browser',maxStages:1});
 await until(()=>entered);
 await runtime.command('suspend');
 assert.equal(runtime.manager.connection,null);
 assert.equal(runtime.snapshot().jobs.length,0);
 const next=await createExtensionRuntime({...f,enabled:false});t.after(()=>next.close());
 await next.command('activate');
 assert.equal(next.snapshot().jobs[0].status,'interrupted');
 assert.equal(next.manager.active,false);
 await runtime.close();
});

test('history storage failures preserve successful browser tool results and never cause action replay',async t=>{
 const f=fixture();let turn=0,actions=0;
 const rpc=async(op,payload)=>{
  if(op==='browser'&&payload.method==='fill'){actions++;return {filled:true,text:'verified'};}
  return f.rpc(op,payload);
 };
 const call=(name,args)=>({usage:new Usage({requests:1}),output:[{type:'function_call',callId:'quota-'+turn,name,arguments:JSON.stringify(args)}]});
 const model={async getResponse(request){
  ++turn;
  if(turn===1)return call('browser_fill',{tabId:12,ref:'search-field',text:'verified'});
  if(turn===2){assert.match(JSON.stringify(request.input),/filled.*true/);assert.ok(!JSON.stringify(request.input).includes('Quota reached'));return call('complete_task',{summary:'Filled once',evidence:'Browser confirmed filled true'});}
  return {usage:new Usage({requests:1}),output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Filled once'}]}]};
 },async *getStreamedResponse(){}};
 const runtime=await createExtensionRuntime({...f,rpc,configure:async()=>({model,modelSettings:{store:false},close:async()=>{}})});t.after(()=>runtime.close());
 await runtime.command('runtime-configure',{credentials:{OPENAI_API_KEY:secret}});
 runtime.manager.traceStore.append=async()=>{throw new Error('Quota reached');};
 await runtime.command('task-create',{prompt:'Fill the search field',tabId:12,mode:'browser',maxStages:1,allowResearch:false});
 await until(()=>!runtime.manager.active);
 assert.equal(actions,1);assert.equal(runtime.snapshot().jobs[0].status,'completed');
 assert.match(runtime.snapshot().historyWarning,/Quota reached/);
});

test('credential writes finish before concurrent task creation can observe a partially changed configuration',async t=>{
 const f=fixture();let release,writing=false,started=false;
 const barrier=new Promise(resolve=>release=resolve);
 const rpc=async(op,payload)=>{
  if(op==='storage-set'&&payload.items.extensionSessionCredentials){writing=true;await barrier;}
  return f.rpc(op,payload);
 };
 const runtime=await createExtensionRuntime({...f,rpc,configure:async env=>{assert.equal(env.OPENAI_API_KEY,secret);return {model:{},modelSettings:{},close:async()=>{}};},run:async()=>{started=true;return {answer:'No browser action needed',history:[]};}});t.after(()=>runtime.close());
 const saving=runtime.command('runtime-configure',{credentials:{OPENAI_API_KEY:secret}});
 await until(()=>writing);
 const starting=runtime.command('task-create',{prompt:'Test configuration ordering',tabId:12,mode:'browser',maxStages:1,allowResearch:false});
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(started,false);
 release();await saving;await starting;await until(()=>!runtime.manager.active);assert.equal(started,true);
});


test('global settings and notification destinations survive a task, new chat, tab switch and runtime reopen',async t=>{
 const f=fixture();
 const runtime=await createExtensionRuntime({...f,configure:async()=>({model:{},modelSettings:{},close:async()=>{}}),run:async(_prompt,options)=>{
  await options.extraTools.find(tool=>tool.name==='complete_task').invoke(new RunContext(),JSON.stringify({summary:'Done',evidence:'Controlled fixture task completed'}));return {answer:'Done',history:[]};
 }});
 await runtime.command('runtime-configure',{credentials:{OPENAI_API_KEY:secret,TABPILOT_TELEGRAM_CHAT_ID:'12345',TABPILOT_EMAIL_TO:'alerts@example.com'}});
 await runtime.command('settings',settings);
 await runtime.command('task-create',{prompt:'Fixture task',tabId:12,mode:'browser',maxStages:1,allowResearch:false});
 await until(()=>!runtime.manager.active);
 await runtime.command('settings',{...settings,model:'next-model'});
 assert.equal(runtime.snapshot().settings.model,'next-model','An old task cannot override current global settings');
 await runtime.command('clear');
 await runtime.command('select-tab',{tabId:34});
 assert.equal(runtime.snapshot().runtime.savedValues.TABPILOT_TELEGRAM_CHAT_ID,'12345');
 assert.equal(runtime.snapshot().runtime.savedValues.TABPILOT_EMAIL_TO,'alerts@example.com');
 assert.ok(!JSON.stringify(runtime.snapshot()).includes(secret));
 await runtime.close();
 const reopened=await createExtensionRuntime(f);t.after(()=>reopened.close());
 assert.equal(reopened.snapshot().settings.model,'next-model');
 assert.ok(reopened.snapshot().runtime.configuredFields.includes('OPENAI_API_KEY'));
 assert.equal(reopened.snapshot().runtime.savedValues.TABPILOT_TELEGRAM_CHAT_ID,'12345');
 await reopened.command('runtime-configure',{clearCredentials:['OPENAI_API_KEY']});
 assert.equal(reopened.snapshot().providers.find(provider=>provider.id==='openai').configured,false);
});
