importScripts("page-runtime.js");

let bridgeSocket = null;
let bridgeReady = false;

chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(`tab:${tabId}`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!["tabpilot:snapshot", "tabpilot:connect", "tabpilot:bridge-status"].includes(message?.type)) return false;

    // Only our extension pages can request snapshots through this handler.
    if (sender.id !== chrome.runtime.id || sender.tab) {
        sendResponse({ ok: false, error: "Snapshots must be requested by an extension page." });
        return false;
    }

    if (message.type === "tabpilot:bridge-status") {
        sendResponse({ connected: bridgeReady });
        return false;
    }
    const operation = message.type === "tabpilot:connect"
        ? connectBridge(message.token).then(() => ({ ok: true }))
        : readTabSnapshot(message.tabId).then((snapshot) => ({ ok: true, snapshot }));
    operation.then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: error.message })
    );
    // Keep the response channel open while storage and script execution finish.
    return true;
});

async function readTabSnapshot(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Invalid tab ID.");

    const key = `tab:${tabId}`;
    const stored = await chrome.storage.session.get(key);
    if (stored[key] !== true) throw new Error("Access disabled. Enable this tab before reading it.");

    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:\/\//.test(tab.url ?? "")) {
        throw new Error("Open a regular HTTP or HTTPS page, then click TabPilot again.");
    }

    const [frame] = await chrome.scripting.executeScript({
        target: { tabId },
        func: tabPilotPage,
        args: ["snapshot", {}]
    });

    // Do not return a snapshot if access was revoked while reading.
    const current = await chrome.storage.session.get(key);
    if (current[key] !== true) throw new Error("Access was disabled while reading.");
    if (!frame?.result) throw new Error("The page did not return a snapshot.");
    return frame.result;
}

async function listEnabledTabs() {
    const stored = await chrome.storage.session.get(null);
    const tabs = [];
    for (const [key, enabled] of Object.entries(stored)) {
        if (enabled !== true || !/^tab:\d+$/.test(key)) continue;
        try {
            const tab = await chrome.tabs.get(Number(key.slice(4)));
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
            if (!ready || message.type !== "request" || typeof message.id !== "string") return;
            try {
                let data;
                if (message.method === "tabs") data = await listEnabledTabs();
                else if (message.method === "snapshot") data = await readTabSnapshot(message.tabId);
                else throw new Error("Unknown bridge command.");
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
            }
            if (!ready) reject(new Error("Pairing failed. Check the token and server."));
        };
    });
}

