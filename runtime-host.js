// A dedicated Worker owns the agent while the workspace is closed. Commands
// return promptly; model execution continues through task state events.
let agentWorker;
const pendingAgentCommands = new Map();
function stopWorker() {
    agentWorker?.terminate(); agentWorker=null;
    for(const {respond,timer} of pendingAgentCommands.values()) {
        clearTimeout(timer);
        respond({ok:false,error:'The extension agent was interrupted. Review its task before resuming; uncertain actions have not been retried.'});
    }
    pendingAgentCommands.clear();
}
function startWorker() {
    if(agentWorker)return;
    const worker=agentWorker=new Worker('vendor/extension-runtime.js',{type:'module'});
    worker.onmessage=async({data})=>{
        if(data.rpcId) {
            try {
                const reply=await chrome.runtime.sendMessage({type:'tabpilot:runtime-rpc',operation:data.operation,payload:data.payload});
                if(agentWorker===worker)worker.postMessage({rpcId:data.rpcId,...(reply?.ok?{result:reply.data}:{error:reply?.error??'Extension request failed.'})});
            } catch {if(agentWorker===worker)worker.postMessage({rpcId:data.rpcId,error:'Extension request interrupted. Reopen TabPilot to review the task.'});}
            return;
        }
        if(data.event){void chrome.runtime.sendMessage({type:'tabpilot:runtime-event',...data}).catch(()=>{});return;}
        const pending=pendingAgentCommands.get(data.id);
        if(pending){pendingAgentCommands.delete(data.id);clearTimeout(pending.timer);pending.respond(data.error?{ok:false,error:data.error}:data.result);}
    };
    worker.onerror=()=>{if(agentWorker===worker)stopWorker();};
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(message.target!=='offscreen-runtime'||sender.id!==chrome.runtime.id||sender.tab||
        (sender.url && sender.url!==chrome.runtime.getURL('background.js')))return false;
    if(message.type==='tabpilot:runtime-ping'){startWorker();respond({ok:true});return false;}
    if(message.type!=='tabpilot:runtime-command')return false;
    startWorker();
    const id=crypto.randomUUID();
    const timer=setTimeout(()=>stopWorker(),30000);
    pendingAgentCommands.set(id,{respond,timer});
    agentWorker.postMessage({id,method:message.method,payload:message.payload,context:message.context});
    return true;
});
