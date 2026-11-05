import { z } from 'zod';
import { TaskManager } from './task-manager.mjs';
import { Notifications } from './notifications.mjs';
import { ExtensionTaskStore, ExtensionTraceHistory } from './extension-storage.mjs';
import { createConfiguredModel } from './agent-models.mjs';
import { runBrowserAgent } from './agent-runner.mjs';
import { createExtensionBrowserTools } from './extension-browser-tools.mjs';

export const credentialNames = ['OPENAI_API_KEY', 'META_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'COMPATIBLE_API_KEY', 'COMPATIBLE_BASE_URL', 'TELEGRAM_BOT_TOKEN', 'TABPILOT_TELEGRAM_CHAT_ID', 'RESEND_API_KEY', 'TABPILOT_EMAIL_FROM', 'TABPILOT_EMAIL_TO'];
const credentialSchema = z.object(Object.fromEntries(credentialNames.map(name => [name, z.string().trim().max(4000).optional()]))).strict();
const configSchema = z.object({executionMode: z.enum(['extension','bridge']).optional(), credentials: credentialSchema.optional(), clearCredentials: z.array(z.enum(credentialNames)).optional(), rememberCredentials:z.boolean().optional()}).strict();

// The worker only talks to our extension host. Chrome APIs remain in the
// service worker; no pairing token, Node process, or localhost is used here.
export async function createExtensionRuntime({ rpc, scope, profileId, onState = () => {}, onHistory = () => {}, enabled = true, configure = createConfiguredModel, run = runBrowserAgent }) {
    const storage = area => ({get:key => rpc('storage-get',{area,key}),set:items => rpc('storage-set',{area,items}),remove:key => rpc('storage-remove',{area,key})});
    const local = storage('local'), session = storage('session');
    const persistent = await local.get(['extensionCredentials','extensionRememberCredentials','extensionAgentSettings']);
    const temporary = await session.get('extensionSessionCredentials');
    let rememberCredentials = persistent.extensionRememberCredentials === true;
    let env = credentialSchema.parse({...persistent.extensionCredentials,...temporary.extensionSessionCredentials});
    const trace = new ExtensionTraceHistory(local,{env});
    const notifications = new Notifications({env,sanitize:value=>trace.clean(value)});
    const manager = new TaskManager({autoTick:false,
        store:new ExtensionTaskStore(local,{sanitize:record=>trace.clean(record)}),
        browser:(method,tabId,params)=>rpc('browser',{method,tabId,params}),
        notifications,
        serviceOptions:{env, allowUnconfiguredSettings:true, settings:persistent.extensionAgentSettings ?? {provider:'openai',model:'gpt-6-luna',maxTurns:30,timeoutMs:300000,approvalMode:'important',soundAlerts:true,downloadDirectory:'/browser/downloads'},
            traceStore:trace,
            configure:values=>configure(values,{browser:true}),
            saveSettings:settings=>local.set({extensionAgentSettings:settings}),
            run:(prompt,options)=>run(prompt,{...options,server:createExtensionBrowserTools({request:async(method,tabId,params)=>{
                let result;
                try {result=await rpc('browser',{method,tabId,params});}
                catch(error){if(options.traceContext)await trace.append(options.traceContext,{kind:'tool',tool:method,arguments:{tabId,...params},result:{error:error.message}}).catch(error=>manager.traceFailure(error));throw error;}
                if(options.traceContext) await trace.append(options.traceContext,{kind:'tool',tool:method,arguments:{tabId,...params},result}).catch(error=>manager.traceFailure(error));
                return result;
            }})})}
    });
    const metadata = () => ({executionMode:'extension',configuredFields:credentialNames.filter(key=>!!env[key]),compatibleBaseUrl:env.COMPATIBLE_BASE_URL??'',savedValues:Object.fromEntries(['TABPILOT_TELEGRAM_CHAT_ID','TABPILOT_EMAIL_FROM','TABPILOT_EMAIL_TO'].filter(name=>!!env[name]).map(name=>[name,env[name]])),rememberCredentials});
    const snapshot = () => ({...manager.snapshot(),executionMode:'extension',runtime:metadata()});
    manager.subscribe(()=>onState(snapshot()));
    manager.subscribeHistory(revision=>onHistory(revision));
    await manager.ready;
    if(enabled) {manager.timer=setInterval(()=>void manager.tick().catch(error=>{manager.schedulerWarning=error.message;manager.emit();}),1000);manager.timer.unref?.();await manager.connected({scope,profileId});}
    let commandQueue=Promise.resolve();
    async function updateConfig(payload) {
        const input=configSchema.parse(payload);
        if(manager.active) throw new Error('Stop active tasks before changing runtime settings.');
        const next={...env};
        for(const name of input.clearCredentials??[]) delete next[name];
        for(const [key,value] of Object.entries(input.credentials??{})) if(value) next[key]=value;
        if(next.COMPATIBLE_BASE_URL) {
            const url=new URL(next.COMPATIBLE_BASE_URL);
            if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash) throw new Error('Use an HTTPS compatible API URL without credentials, query, or fragment. Local endpoints are available in Developer bridge mode.');
        }
        const remember=input.rememberCredentials??rememberCredentials;
        // Persist the destination first: a storage failure never silently deletes
        // the currently saved credentials or changes the live runner.
        if(remember) {await local.set({extensionCredentials:next,extensionRememberCredentials:true});await session.remove('extensionSessionCredentials');}
        else {await session.set({extensionSessionCredentials:next});await local.remove('extensionCredentials');await local.set({extensionRememberCredentials:false});}
        env=next;rememberCredentials=remember;
        manager.preferences.env={...env};manager.serviceOptions.env={...env};
        notifications.env={...env};trace.env={...env};
        manager.emit();
        return {ok:true,state:snapshot(),runtime:metadata()};
    }
    async function command(method,payload={}) {
        if(method==='activate'){if(!manager.connection){clearInterval(manager.timer);manager.timer=setInterval(()=>void manager.tick().catch(error=>{manager.schedulerWarning=error.message;manager.emit();}),1000);manager.timer.unref?.();await manager.connected({scope,profileId});}return {ok:true,state:snapshot(),runtime:metadata()};}
        if(method==='suspend'){await manager.close();return {ok:true,runtime:metadata()};}
        if(method==='runtime-settings')return {ok:true,state:snapshot(),runtime:metadata()};
        if(method==='runtime-configure') {
            return updateConfig(payload);
        }
        if(method==='tick'){await manager.tick();return {ok:true,state:snapshot()};}
        if(['start','task-create','task-resume','task-cancel','select-tab','human-response','history-list','history-events','history-image'].includes(method)) {
            if(payload.scope && payload.scope!==scope)throw new Error('This command belongs to a different browser session.');
            payload={...payload,scope};
        }
        const result=await manager.command(method,payload);
        return method.startsWith('history-')?{ok:true,...result}:{ok:true,state:snapshot()};
    }
    return {manager,snapshot,command(...args){const operation=commandQueue.then(()=>command(...args));commandQueue=operation.catch(()=>{});return operation;},close:()=>manager.close()};
}

// Exporting the factory keeps the lifecycle and credentials testable with
// simulated providers. Only a dedicated browser Worker installs this transport.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
    const pending=new Map(); let runtimePromise;
    const rpc=(operation,payload)=>new Promise((resolve,reject)=>{const rpcId=crypto.randomUUID();pending.set(rpcId,{resolve,reject});postMessage({rpcId,operation,payload});});
    onmessage=async({data})=>{
        if(data.rpcId){const request=pending.get(data.rpcId);if(request){pending.delete(data.rpcId);data.error?request.reject(new Error(data.error)):request.resolve(data.result);}return;}
        if(!data.id)return;
        try {
            runtimePromise??=createExtensionRuntime({rpc,...data.context,onState:state=>postMessage({event:'state',state}),onHistory:revision=>postMessage({event:'history',revision})}).catch(error=>{runtimePromise=null;throw error;});
            const runtime=await runtimePromise;
            const result=await runtime.command(data.method,data.payload);
            postMessage({id:data.id,result});
        }catch(error){postMessage({id:data.id,error:error instanceof z.ZodError?'Invalid extension settings or task input.':error.message});}
    };
}
