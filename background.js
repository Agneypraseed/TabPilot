chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(`tab:${tabId}`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "tabpilot:snapshot") return false;

    // Only our extension pages can request snapshots through this handler.
    if (sender.id !== chrome.runtime.id || sender.tab) {
        sendResponse({ ok: false, error: "Snapshots must be requested by an extension page." });
        return false;
    }

    readTabSnapshot(message.tabId).then(
        (snapshot) => sendResponse({ ok: true, snapshot }),
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
        func: () => {
            const text = document.body?.innerText ?? "";
            return {
                title: document.title,
                url: location.href,
                text: text.slice(0, 20000),
                truncated: text.length > 20000
            };
        }
    });

    // Do not return a snapshot if access was revoked while reading.
    const current = await chrome.storage.session.get(key);
    if (current[key] !== true) throw new Error("Access was disabled while reading.");
    if (!frame?.result) throw new Error("The page did not return a snapshot.");
    return frame.result;
}

