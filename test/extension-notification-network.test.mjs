import test from 'node:test';
import assert from 'node:assert/strict';
import {sendExtensionNotification,checkTelegramConnection} from '../extension-notification-network.mjs';
const env={TELEGRAM_BOT_TOKEN:'123456:private-token-fixture',TABPILOT_TELEGRAM_CHAT_ID:'12345'};
const input={subject:'Test',message:'Controlled test',channels:['telegram']};
const permissions={contains:async({origins})=>{assert.deepEqual(origins,['https://api.telegram.org/*']);return true;}};

test('background notification service checks fixed host permissions before sending and cannot proxy arbitrary URLs',async()=>{
 let calls=0;
 const denied=await sendExtensionNotification({env,input},{permissions:{contains:async()=>false},fetch:async()=>{calls++;assert.fail('No permission');}});
 assert.equal(denied.accepted,false);assert.equal(denied.results[0].errorCode,'HOST_PERMISSION');assert.equal(calls,0);
 await assert.rejects(sendExtensionNotification({env:{...env,OPENAI_API_KEY:'not-allowed'},input}));
 await assert.rejects(sendExtensionNotification({env,input,url:'https://attacker.example/'}));
 const result=await sendExtensionNotification({env,input},{permissions,fetch:async(url,options)=>{calls++;assert.equal(url,'https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage');assert.equal(JSON.parse(options.body).chat_id,env.TABPILOT_TELEGRAM_CHAT_ID);return Response.json({ok:true,result:{message_id:10}});}});
 assert.equal(result.accepted,true);assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes(env.TELEGRAM_BOT_TOKEN));
});

test('Telegram connection check only reads bot/chat data and never invokes sendMessage',async()=>{
 const methods=[];
 const result=await checkTelegramConnection({env},{permissions,fetch:async(url,options)=>{
  methods.push(url.split('/').at(-1));assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
  return Response.json(url.endsWith('/getMe')?{ok:true,result:{is_bot:true,id:1,first_name:'private'}}:{ok:true,result:{id:12345,title:'private chat'}});
 }});
 assert.equal(result.ok,true);assert.deepEqual(methods,['getMe','getChat']);
 assert.ok(!JSON.stringify(result).includes('private'));assert.match(result.message,/No alert was sent/);
});

for(const phase of ['permission','auth','chat','network','timeout'])test('connection check reports safe '+phase+' failure without a message',async()=>{
 let calls=0;
 const result=await checkTelegramConnection({env},{permissions:{contains:async()=>phase!=='permission'},fetch:async url=>{
  calls++;assert.ok(!url.endsWith('/sendMessage'));
  if(phase==='network')throw new TypeError(url);
  if(phase==='timeout')throw new DOMException(url,'TimeoutError');
  if(phase==='auth'||url.endsWith('/getChat'))return new Response('secret provider body '+env.TELEGRAM_BOT_TOKEN,{status:403});
  return Response.json({ok:true,result:{is_bot:true}});
 }});
 assert.equal(result.ok,false);
 assert.equal(result.errorCode,{permission:'HOST_PERMISSION',auth:'BOT_AUTH',chat:'CHAT_ACCESS',network:'NETWORK_ERROR',timeout:'TIMEOUT'}[phase]);
 assert.equal(calls,phase==='permission'?0:phase==='chat'?2:1);
 assert.ok(!JSON.stringify(result).includes(env.TELEGRAM_BOT_TOKEN));assert.match(result.error,/No alert was sent/);
});

test('notification sends distinguish timeout/network/unreadable responses and never retry',async()=>{
 for(const [code,error] of [['TIMEOUT',new DOMException('private','TimeoutError')],['NETWORK_ERROR',new TypeError('private '+env.TELEGRAM_BOT_TOKEN)],['INVALID_RESPONSE',null]]) {
  let sends=0;
  const result=await sendExtensionNotification({env,input},{permissions,fetch:async()=>{sends++;if(error)throw error;return new Response('not JSON');}});
  assert.equal(sends,1);assert.equal(result.results[0].errorCode,code);assert.ok(!JSON.stringify(result).includes(env.TELEGRAM_BOT_TOKEN));
 }
});
