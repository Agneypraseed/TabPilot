import test from 'node:test';
import assert from 'node:assert/strict';
import {taskRequestAlert} from '../task-alerts.mjs';
import {browserApprovalPolicy} from '../agent-interactions.mjs';

test('permission request uses observed action, recipient, subject and page without body/password/query data',async()=>{
 const requests=[];
 const policy=browserApprovalPolicy({requestHuman:async request=>{requests.push(request);return {decision:'approve'};}});
 policy.afterTool('browser_snapshot',{tabId:12},{structuredContent:{title:'Compose - Gmail',url:'https://mail.google.com/mail/?token=private-query',elements:[
  {ref:'send',role:'button',name:'Send'}, {ref:'to',role:'textbox',name:'To',value:'sam@example.com'},
  {ref:'subject',role:'textbox',name:'Subject',value:'Project update'},
  {ref:'body',role:'textbox',name:'Message',value:'Private full message body'},
  {ref:'password',role:'textbox',name:'To',type:'password',value:'private-password'},
 ]}});
 await policy.beforeTool('browser_click',{tabId:12,ref:'send'});
 assert.equal(requests[0].question,'Send the prepared message to sam@example.com?');
 assert.match(requests[0].detail,/Subject: Project update/);assert.match(requests[0].detail,/mail.google.com/);
 const alert=taskRequestAlert({id:'internal-task-id',tabId:12,tabTitle:'Old tab',prompt:'Private entire task prompt'},requests[0]);
 assert.ok(alert.message.startsWith(requests[0].question));
 assert.match(alert.message,/Project update/);assert.match(alert.message,/Open TabPilot/);
 for(const privateText of ['private-query','private-password','Private full message body','Private entire task prompt','internal-task-id','Old tab'])assert.ok(!alert.message.includes(privateText),privateText);
});

test('new snapshots clear old recipient context rather than inventing a destination',async()=>{
 const requests=[];const policy=browserApprovalPolicy({requestHuman:async request=>{requests.push(request);return {decision:'approve'};}});
 policy.afterTool('browser_snapshot',{tabId:12},{structuredContent:{title:'Compose',url:'https://mail.example/',elements:[{ref:'to',name:'To',value:'old@example.com'},{ref:'send',name:'Send'}]}});
 policy.afterTool('browser_snapshot',{tabId:12},{structuredContent:{title:'New form',url:'https://form.example/',elements:[{ref:'new-send',name:'Send'}]}});
 await policy.beforeTool('browser_click',{tabId:12,ref:'new-send'});
 assert.ok(!JSON.stringify(requests[0]).includes('old@example.com'));
 assert.match(requests[0].detail,/form.example/);
});

test('question alerts use human-readable context and omit internal IDs with bounded payloads',()=>{
 const record={id:'task-uuid',tabId:123,tabTitle:'Example page',prompt:'private prompt'};
 const alert=taskRequestAlert(record,{id:'request-uuid',kind:'information',question:'Which date?',detail:'Choose the date for the booking.'});
 assert.equal(alert.message.split('\n')[0],'Which date?');
 assert.ok(!alert.message.includes('request-uuid'));assert.ok(!alert.message.includes('task-uuid'));
 const large=taskRequestAlert(record,{kind:'approval',question:'a'.repeat(3000),detail:'b'.repeat(6000)});
 assert.ok(large.message.length<=3000);
});
