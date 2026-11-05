importScripts("page-runtime.js");
importScripts("tab-access.js");
importScripts("browser-controller.js");
importScripts("downloads-controller.js");
importScripts("attention-alerts.js");
importScripts("vendor/notification-network.js");

const browser = new TabPilotBrowser(chrome, tabPilotPage);
const downloads = new TabPilotDownloads(chrome, { permitted: tabId => browser.permitted(tabId) });
const attentionAlerts = new TabPilotAttentionAlerts(chrome);
void chrome.storage.local?.setAccessLevel?.({accessLevel:"TRUSTED_CONTEXTS"});
void chrome.storage.session?.setAccessLevel?.({accessLevel:"TRUSTED_CONTEXTS"});

let bridgeSocket = null;
let bridgeReady = false;
let agentState = null;
let executionMode;
let runtimeDocument;
let runtimeConfigurationQueue=Promise.resolve();
async function getExecutionMode() {
    if(!executionMode) executionMode=(await chrome.storage.local?.get('extensionExecutionMode'))?.extensionExecutionMode==='bridge'?'bridge':'extension';
    return executionMode;
}
function extensionRuntimeSupported() { return !!(chrome.offscreen?.createDocument && chrome.runtime.getContexts); }
async function ensureRuntimeDocument() {
    if(!chrome.offscreen?.createDocument||!chrome.runtime.getContexts) throw new Error('This browser does not support the extension agent runtime. Use desktop Chrome 118 or newer, or select the optional local server in Developer settings.');
    runtimeDocument ??= (async()=>{
        const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('attention-audio.html')]});
        if(!contexts.length) {
            try {await chrome.offscreen.createDocument({url:'attention-audio.html',reasons:['WORKERS','AUDIO_PLAYBACK'],justification:'Host the browser agent worker and play optional task attention sounds.'});}
            catch(error){const retry=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('attention-audio.html')]});if(!retry.length)throw error;}
        }
        for(let attempt=0;attempt<20;attempt++) {
            try {if((await chrome.runtime.sendMessage({type:'tabpilot:runtime-ping',target:'offscreen-runtime'}))?.ok)return;}
            catch {}
            await new Promise(resolve=>setTimeout(resolve,50));
        }
        throw new Error('The extension runtime did not start. Reload the extension and reopen TabPilot.');
    })().finally(()=>{runtimeDocument=null;});
    await runtimeDocument;
}
async function requestExtension(method,payload={}) {
    await ensureRuntimeDocument();
    const response=await chrome.runtime.sendMessage({type:'tabpilot:runtime-command',target:'offscreen-runtime',method,payload,
        context:{scope:await historyScope(),profileId:await browserProfileId(),enabled:(await getExecutionMode())==='extension'}});
    if(!response?.ok)throw new Error(response?.error??'The extension runtime did not respond.');
    if(response.state&&(await getExecutionMode())==='extension')publishAgentState(response.state);
    return response;
}
async function browserCommand(method,tabId,params={}) {
    if(method==='tabs')return listEnabledTabs();
    if(method==='snapshot')return readTabSnapshot(tabId);
    if(method==='screenshot')return browser.screenshot(tabId);
    if(method==='download')return downloads.start(tabId,params);
    if(method==='download-status')return downloads.status(tabId,params?.downloadId);
    if(method==='download-cancel')return downloads.cancel(tabId,params?.downloadId);
    if(method.startsWith('download-local'))throw new Error('Local file downloads require the optional Developer bridge. Use Chrome downloads in extension mode.');
    return browser.action(tabId,method,params);
}
async function runtimeAgent(method,payload={}) {
    if(method==="runtime-configure") {
        const operation=runtimeConfigurationQueue.then(()=>configureRuntime(payload));
        runtimeConfigurationQueue=operation.catch(()=>{});return operation;
    }
    await runtimeConfigurationQueue;
    const mode=await getExecutionMode();
    if(method==='runtime-settings') {
        if(!extensionRuntimeSupported()) return {ok:true,runtime:{executionMode:mode,configuredFields:[],rememberCredentials:false,compatibleBaseUrl:''}};
        const response=await requestExtension(method);
        response.runtime.executionMode=mode;
        return {...response,state:mode==='bridge'?agentState:response.state};
    }
    return mode==='extension'?requestExtension(method,payload):requestAgent(method,payload);
}
async function configureRuntime(payload) {
    const mode = await getExecutionMode();
    if (mode === 'bridge' && bridgeReady) await requestAgent('state');
    const nextMode = payload.executionMode ?? mode;
    if (!['extension', 'bridge'].includes(nextMode)) throw new Error('Choose extension or local server mode.');
    if (nextMode !== mode && (agentState?.jobs ?? []).some(job => ['running', 'needs-input', 'paused', 'waiting-for-worker', 'continuing'].includes(job.status))) {
        throw new Error('Stop active tasks before changing execution mode.');
    }
    if(!extensionRuntimeSupported()) {
        if(nextMode!=='bridge') throw new Error('This browser cannot host the extension agent. Use desktop Chrome 118 or newer, or select the local developer server.');
        if(Object.keys(payload).some(key=>key!=='executionMode')) throw new Error('Extension credentials are unavailable in this browser. Developer mode uses the server’s .env.local.');
        await chrome.storage.local.set({extensionExecutionMode:'bridge'});
        executionMode='bridge';agentState=null;
        return {ok:true,runtime:{executionMode:'bridge',configuredFields:[]}};
    }
    const response = await requestExtension('runtime-configure', payload);
    if (nextMode !== mode) {
        if (mode === 'extension') await requestExtension('suspend');
        await chrome.storage.local.set({ extensionExecutionMode: nextMode });
        executionMode = nextMode;
        bridgeSocket?.close();
        bridgeSocket = null;
        bridgeReady = false;
        agentState = null;
        if (nextMode === 'extension') await requestExtension('activate');
    }
    response.runtime.executionMode = nextMode;
    return { ...response, state: nextMode === 'extension' ? agentState : null };
}
chrome.alarms?.onAlarm.addListener(alarm=>{
    if(alarm.name==='tabpilot-scheduler')void getExecutionMode().then(mode=>mode==='extension'?requestExtension('tick'):null).catch(()=>{});
});
void chrome.alarms?.create('tabpilot-scheduler',{periodInMinutes:1});
const agentRequests = new Map();
let historyScopePromise;
let browserProfilePromise;
function browserProfileId() {
    return browserProfilePromise ??= (async () => {
        if (!chrome.storage.local) return crypto.randomUUID();
        const stored = await chrome.storage.local.get("browserProfileId");
        if (typeof stored.browserProfileId === "string" && /^[a-f0-9-]{36}$/i.test(stored.browserProfileId)) return stored.browserProfileId;
        const profileId = crypto.randomUUID();
        await chrome.storage.local.set({ browserProfileId: profileId });
        return profileId;
    })();
}
function historyScope() {
    return historyScopePromise ??= (async () => {
        if (!chrome.storage.local) return crypto.randomUUID();
        const stored = await chrome.storage.local.get("historyScope");
        if (typeof stored.historyScope === "string" && /^[a-f0-9-]{36}$/i.test(stored.historyScope)) return stored.historyScope;
        const scope = crypto.randomUUID();
        await chrome.storage.local.set({ historyScope: scope });
        return scope;
    })();
}
// Chrome may reuse numeric tab IDs in a new browser session. Give that session
// a new history namespace, while extension reloads retain the current one.
chrome.runtime.onStartup?.addListener(() => {
    const scope = crypto.randomUUID();
    historyScopePromise = chrome.storage.local.set({ historyScope: scope }).then(() => scope);
    void chrome.storage.local.remove?.("tabAccessRevocations");
});

// Some Chromium-based hosts expose sidePanel without implementing every method.
// Keep the worker usable there; opening the panel is an optional UI capability.
try {
    const setPanelBehavior = chrome.sidePanel?.setPanelBehavior;
    if (typeof setPanelBehavior === "function") {
        Promise.resolve(setPanelBehavior.call(chrome.sidePanel, { openPanelOnActionClick: false })).catch(() => {});
    }
} catch {}

chrome.tabs.onRemoved.addListener((tabId) => {
    void browser.clearAccess(tabId).catch(() => {});
    void browser.detach(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!["tabpilot:snapshot", "tabpilot:connect", "tabpilot:bridge-status", "tabpilot:access", "tabpilot:agent", "tabpilot:ui-state", "tabpilot:disconnect", "tabpilot:test-alert", "tabpilot:runtime-rpc", "tabpilot:runtime-event"].includes(message?.type)) return false;

    // Only our extension pages can request snapshots through this handler.
    const ownExtensionPage = typeof sender.url === "string" && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
    if (sender.id !== chrome.runtime.id || (sender.tab && !ownExtensionPage)) {
        sendResponse({ ok: false, error: "Snapshots must be requested by an extension page." });
        return false;
    }

    if (message.type === 'tabpilot:runtime-rpc' || message.type === 'tabpilot:runtime-event') {
        if(sender.url!==chrome.runtime.getURL('attention-audio.html')) {sendResponse({ok:false,error:'Only the extension runtime can use this channel.'});return false;}
        if(message.type==='tabpilot:runtime-event') {
            void getExecutionMode().then(mode=>{
                if(mode!=='extension')return;
                if(message.event==='state')publishAgentState(message.state);
                if(message.event==='history')void chrome.runtime.sendMessage({type:'tabpilot:history-event',revision:message.revision}).catch(()=>{});
            });
            sendResponse({ok:true});return false;
        }
        const {operation,payload={}}=message;
        const execute=async()=>{
            if(operation==='notification-send'||operation==='notification-check') {
                if((await getExecutionMode())!=='extension')throw new Error('Extension notifications are disabled in developer-server mode.');
                return operation==='notification-check'?globalThis.tabPilotCheckTelegram(payload):globalThis.tabPilotSendNotification(payload);
            }
            if(operation==='browser') {
                if((await getExecutionMode())!=='extension')throw new Error('The extension agent is disabled in local server mode.');
                return browserCommand(payload.method,payload.tabId,payload.params);
            }
            if(!['local','session'].includes(payload.area))throw new Error('Invalid storage area.');
            const storage=chrome.storage[payload.area];
            // Runtime messages may only use the dedicated extension data namespace.
            if(operation==='storage-get'&&payload.key===null) {
                const all=await storage.get(null);return Object.fromEntries(Object.entries(all).filter(([key])=>key.startsWith('extension')));
            }
            const keys=operation==='storage-set'?Object.keys(payload.items??{}):Array.isArray(payload.key)?payload.key:[payload.key];
            if(!keys.length||keys.some(key=>typeof key!=='string'||!key.startsWith('extension')))throw new Error('Invalid runtime storage key.');
            if(operation==='storage-get')return storage.get(payload.key);
            if(operation==='storage-set')return storage.set(payload.items);
            if(operation==='storage-remove')return storage.remove(payload.key);
            throw new Error('Unknown runtime request.');
        };
        execute().then(data=>sendResponse({ok:true,data}),error=>sendResponse({ok:false,error:operation==='browser'?error.message:operation.startsWith('notification-')?'The background notification service could not process the request. Check extension site access and reload TabPilot.':'Extension storage operation failed. Check available local storage space.'}));return true;
    }
    if (message.type === "tabpilot:bridge-status" || message.type === "tabpilot:ui-state") {
        getExecutionMode().then(async mode=>{
            if(mode==='extension') {
                try {const response=await requestExtension('state');sendResponse({connected:true,agent:response.state,executionMode:mode,runtime:response.state.runtime});}
                catch(error){sendResponse({connected:false,agent:null,executionMode:mode,error:error.message});}
            } else sendResponse({connected:bridgeReady,agent:agentState,executionMode:mode,runtime:{executionMode:mode}});
        });
        return true;
    }
    if (message.type === "tabpilot:disconnect") {
        bridgeSocket?.close();
        sendResponse({ ok: true });
        return false;
    }
    const operation = message.type === "tabpilot:test-alert"
        ? attentionAlerts.sound().then(played => ({ ok: true, played }))
        : message.type === "tabpilot:access"
        ? browser.setAccess(message.tabId, message.enabled).then(result => ({ ok: true, ...result }))
        : message.type === "tabpilot:agent"
        ? runtimeAgent(message.method, message.payload)
        : message.type === "tabpilot:connect"
        ? connectBridge(message.token).then(() => ({ ok: true }))
        : readTabSnapshot(message.tabId).then((snapshot) => ({ ok: true, snapshot }));
    operation.then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: error.message })
    );
    // Keep the response channel open while storage and script execution finish.
    return true;
});

function requestAgent(method, payload = {}) {
    if (!bridgeReady || bridgeSocket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Connect the local bridge in Settings first."));
    if (agentRequests.size >= 8) return Promise.reject(new Error("Wait for the previous agent command."));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { agentRequests.delete(id); reject(new Error("Agent command timed out. Restart the bridge if it is out of date.")); }, 10000);
        agentRequests.set(id, { resolve, reject, timer });
        bridgeSocket.send(JSON.stringify({ type: "agent-request", id, method, payload }));
    });
}

function publishAgentState(state) {
    if (agentState && state?.sessionId === agentState.sessionId && state?.revision < agentState.revision) return;
    agentState = state;
    void attentionAlerts.update(state).catch(() => {});
    // No panel may be open; losing a UI observer is not a runtime error.
    chrome.runtime.sendMessage?.({ type: "tabpilot:agent-event", state }).catch(() => {});
}

async function readTabSnapshot(tabId) {
    return browser.snapshot(tabId);
}

async function listEnabledTabs() {
    const tabs = await chrome.tabs.query({});
    const stored = await TabPilotTabAccess.read(chrome);
    return tabs.filter(tab => TabPilotTabAccess.supported(tab.url) && TabPilotTabAccess.enabled(stored, tab.id))
        .map(tab => ({ id: tab.id, title: tab.title ?? "", url: tab.url ?? "" }));
}

async function connectBridge(token) {
    if((await getExecutionMode())!=="bridge") throw new Error("Select local server mode in Developer settings before pairing.");
    if (bridgeSocket) return Promise.reject(new Error("Bridge is already connecting or connected."));
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
        return Promise.reject(new Error("Paste the token from npm run cli -- pair."));
    }
    return new Promise((resolve, reject) => {
        const socket = new WebSocket("ws://127.0.0.1:4311/extension");
        bridgeSocket = socket;
        let ready = false;
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error("Bridge connection timed out."));
        }, 5000);
        socket.onopen = async () => {
            try { socket.send(JSON.stringify({ type: "authenticate", token, historyScope: await historyScope(), profileId: await browserProfileId() })); }
            catch { socket.close(); reject(new Error("Could not initialize local tab history.")); }
        };
        socket.onmessage = async (event) => {
            let message;
            try { message = JSON.parse(event.data); }
            catch { return; }
            if (message.type === "ready") {
                ready = true;
                bridgeReady = true;
                clearTimeout(timeout);
                resolve();
                return;
            }
            if (ready && message.type === "agent-state") { publishAgentState(message.state); return; }
            if (ready && message.type === "history-changed") {
                if (agentState) agentState.historyRevision = message.revision;
                chrome.runtime.sendMessage?.({ type: "tabpilot:history-event", revision: message.revision }).catch(() => {});
                return;
            }
            if (ready && message.type === "agent-response") {
                const pending = agentRequests.get(message.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    agentRequests.delete(message.id);
                    if (message.ok) { if (message.state) publishAgentState(message.state); pending.resolve({ ok: true, state: message.state, history: message.history }); }
                    else pending.reject(new Error(message.error || "Agent request failed."));
                }
                return;
            }
            if (!ready || message.type !== "request" || typeof message.id !== "string") return;
            try {
                const data = await browserCommand(message.method, message.tabId, message.params);
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, data }));
                }
            } catch (error) {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: "response", id: message.id, ok: false, error: error.message }));
                }
            }
        };
        socket.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("Cannot connect. Start the bridge with npm start."));
        };
        socket.onclose = () => {
            clearTimeout(timeout);
            if (bridgeSocket === socket) {
                bridgeSocket = null;
                bridgeReady = false;
                agentState = null;
                for (const pending of agentRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Bridge disconnected.")); }
                agentRequests.clear();
            }
            if (!ready) reject(new Error("Pairing failed. Check the token and server."));
        };
    });
}
