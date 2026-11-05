import test from 'node:test';
import assert from 'node:assert/strict';
import { Usage } from '@openai/agents';
import { createExtensionBrowserTools } from '../extension-browser-tools.mjs';
import { runBrowserAgent } from '../agent-runner.mjs';
import { createConfiguredModel } from '../agent-models.mjs';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=';
const final = text => ({ usage: new Usage({requests:1}), output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]}] });
const call = (name,args,index) => ({usage:new Usage({requests:1}),output:[{type:'function_call',callId:'direct-'+index,name,arguments:JSON.stringify(args)}]});

test('extension tools validate before worker dispatch and exclude local-server-only operations',async()=>{
 const calls=[];
 const server=createExtensionBrowserTools({request:async(...args)=>{calls.push(args);return {ok:true};}});
 const tools=await server.listTools();
 assert.ok(tools.some(t=>t.name==='browser_download'));
 assert.ok(!tools.some(t=>t.name.startsWith('browser_download_local')||t.name.startsWith('notifications_')));
 assert.equal((await server.callToolResult('browser_click',{tabId:12,ref:'x',unexpected:'value'})).isError,true);
 assert.equal((await server.callToolResult('browser_navigate',{tabId:-1,url:'https://example.com'})).isError,true);
 assert.equal((await server.callToolResult('browser_download_local',{tabId:12,url:'https://example.com/file'})).isError,true);
 assert.equal(calls.length,0);
 await server.callToolResult('browser_fill',{tabId:12,ref:'x',text:'hello'});
 assert.deepEqual(calls[0].slice(0,3),['fill',12,{ref:'x',text:'hello'}]);
});

test('portable SDK runner executes direct extension tools, receives screenshots and limits tab scope',async()=>{
 const calls=[];let turn=0;
 const server=createExtensionBrowserTools({request:async(method,tabId)=>{
  calls.push({method,tabId});
  if(method==='tabs')return [{id:12,title:'Test page',url:'https://example.com'},{id:34,title:'Other tab',url:'https://other.example'}];
  if(method==='snapshot')return {title:'Test page',url:'https://example.com',text:'Observed test page',truncated:false};
  if(method==='screenshot')return {screenshotId:'direct-shot',data:image,mimeType:'image/png',width:1,height:1};
 }});
 const model={async getResponse(request){
  turn++;
  assert.ok(!request.tools.some(t=>t.name==='browser_download_local'));
  if(turn===1)return call('browser_tabs',{},turn);
  if(turn===2){assert.ok(!JSON.stringify(request.input).includes('Other tab'));return call('browser_snapshot',{tabId:34},turn);}
  if(turn===3){assert.match(JSON.stringify(request.input),/restricted to the user-selected tab/);return call('browser_snapshot',{tabId:12},turn);}
  if(turn===4){assert.match(JSON.stringify(request.input),/Observed test page/);return call('browser_screenshot',{tabId:12},turn);}
  assert.match(JSON.stringify(request.input),/data:image\/png;base64,/);return final('Read the test page and screenshot.');
 },async *getStreamedResponse(){throw new Error('Not streaming');}};
 const result=await runBrowserAgent('Read the test page',{server,model,targetTabId:12,maxTurns:6});
 assert.equal(result.answer,'Read the test page and screenshot.');
 assert.ok(!calls.some(c=>c.tabId===34));
 assert.deepEqual(calls.map(c=>c.method),['tabs','tabs','snapshot','screenshot']);
});

for(const provider of ['openai','meta'])test(`${provider} browser configuration sends authenticated Responses requests through its own client`,async()=>{
 const env={AGENT_PROVIDER:provider,AGENT_MODEL:'test-model',[provider==='meta'?'META_API_KEY':'OPENAI_API_KEY']:'test-secret'};
 let requests=0;
 const configured=await createConfiguredModel(env,{browser:true,fetch:async(url,options)=>{
  requests++;
  assert.equal(new URL(url).hostname,provider==='meta'?'api.meta.ai':'api.openai.com');
  assert.equal(new Headers(options.headers).get('authorization'),'Bearer test-secret');
  const body=JSON.parse(options.body);assert.equal(body.model,'test-model');assert.equal(body.store,false);
  return Response.json({id:'resp_test',object:'response',created_at:0,status:'completed',model:'test-model',output:[{id:'msg_test',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Browser model works.',annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
 }});
 try{
  const server=createExtensionBrowserTools({request:async()=>[{id:12,title:'Test',url:'https://example.com'}]});
  const result=await runBrowserAgent('Reply briefly',{server,model:configured.model,modelSettings:configured.modelSettings,targetTabId:12});
  assert.equal(result.answer,'Browser model works.');assert.equal(requests,1);
 }finally{await configured.close();}
});
for(const [provider,key] of [['gemini','GOOGLE_GENERATIVE_AI_API_KEY'],['claude','ANTHROPIC_API_KEY'],['openai-compatible','COMPATIBLE_API_KEY']])test(`${provider} extension mode uses provider-specific credentials and browser request options`,async()=>{
 let requests=0;
 const configured=await createConfiguredModel({AGENT_PROVIDER:provider,AGENT_MODEL:'test-model',[key]:'test-secret',COMPATIBLE_BASE_URL:'https://models.example/v1'},{browser:true,fetch:async(url,options)=>{
  requests++;const headers=new Headers(options.headers);
  assert.equal(headers.get(provider==='gemini'?'x-goog-api-key':provider==='claude'?'x-api-key':'authorization'),provider==='openai-compatible'?'Bearer test-secret':'test-secret');
  if(provider==='claude')assert.equal(headers.get('anthropic-dangerous-direct-browser-access'),'true');
  const text='Provider extension request works.';
  return Response.json(provider==='gemini'?{candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP',index:0}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2},modelVersion:'test-model'}
   :provider==='claude'?{id:'msg_test',type:'message',role:'assistant',model:'test-model',content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}
   :{id:'chat_test',object:'chat.completion',created:0,model:'test-model',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
 }});
 try{
  const result=await runBrowserAgent('Reply briefly',{server:createExtensionBrowserTools({request:async()=>[{id:12,title:'Test',url:'https://example.com'}]}),model:configured.model,modelSettings:configured.modelSettings,targetTabId:12});
  assert.equal(result.answer,'Provider extension request works.');assert.equal(requests,1);
 }finally{await configured.close();}
});
