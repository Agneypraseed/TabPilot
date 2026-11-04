importScripts("page-runtime.js");
importScripts("browser-controller.js");

const browser = new TabPilotBrowser(chrome, tabPilotPage);

let bridgeSocket = null;
let bridgeReady = false;
let agentState = null;
const agentRequests = new Map();

// A persistent side panel remains visible while the agent uses the page.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(`tab:${tabId}`);
    void browser.detach(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!["tabpilot:snapshot", "tabpilot:connect", "tabpilot:bridge-status", "tabpilot:access", "tabpilot:agent", "tabpilot:ui-state", "tabpilot:disconnect"].includes(message?.type)) return false;

    // Only our extension pages can request snapshots through this handler.
    if (sender.id !== chrome.runtime.id || sender.tab) {
        sendResponse({ ok: false, error: "Snapshots must be requested by an extension page." });
        return false;
    }

    if (message.type === "tabpilot:bridge-status") {
        sendResponse({ connected: bridgeReady });
        return false;
    }
    if (message.type === "tabpilot:ui-state") {
        sendResponse({ connected: bridgeReady, agent: agentState });
        return false;
    }
    if (message.type === "tabpilot:disconnect") {
        bridgeSocket?.close();
        sendResponse({ ok: true });
        return false;
    }
    const operation = message.type === "tabpilot:access"
        ? browser.setAccess(message.tabId, message.enabled).then(result => ({ ok: true, ...result }))
        : message.type === "tabpilot:agent"
        ? requestAgent(message.method, message.payload)
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
    if (agentState && state?.revision < agentState.revision) return;
    agentState = state;
    // No panel may be open; losing a UI observer is not a runtime error.
    chrome.runtime.sendMessage?.({ type: "tabpilot:agent-event", state }).catch(() => {});
}

async function readTabSnapshot(tabId) {
    return browser.snapshot(tabId);
}

async function listEnabledTabs() {
    const stored = await chrome.storage.session.get(null);
    const tabs = [];
    for (const [key, enabled] of Object.entries(stored)) {
        if (enabled !== true || !/^tab:\d+$/.test(key)) continue;
        try {
            const tab = await chrome.tabs.get(Number(key.slice(4)));
            if ((await chrome.storage.session.get(key))[key] !== true) continue;
            tabs.push({ id: tab.id, title: tab.title ?? "", url: tab.url ?? "" });
        } catch {
            // A tab may close while the list is being built.
        }
    }
    return tabs;
}

function connectBridge(token) {
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
        socket.onopen = () => socket.send(JSON.stringify({ type: "authenticate", token }));
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
            if (ready && message.type === "agent-response") {
                const pending = agentRequests.get(message.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    agentRequests.delete(message.id);
                    if (message.ok) { publishAgentState(message.state); pending.resolve({ ok: true, state: message.state }); }
                    else pending.reject(new Error(message.error || "Agent request failed."));
                }
                return;
            }
            if (!ready || message.type !== "request" || typeof message.id !== "string") return;
            try {
                let data;
                if (message.method === "tabs") data = await listEnabledTabs();
                else if (message.method === "snapshot") data = await readTabSnapshot(message.tabId);
                else if (message.method === "screenshot") data = await browser.screenshot(message.tabId);
                else data = await browser.action(message.tabId, message.method, message.params);
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

