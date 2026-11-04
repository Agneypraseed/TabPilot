const accessStatus = document.getElementById("access-status");
const toggleButton = document.getElementById("toggle-access");
const readButton = document.getElementById("read-page");
const snapshotOutput = document.getElementById("snapshot-output");

let enabled = false;

const bridgeToken = document.getElementById("bridge-token");
const connectButton = document.getElementById("connect-bridge");
const bridgeStatus = document.getElementById("bridge-status");

chrome.runtime.sendMessage({ type: "tabpilot:bridge-status" }).then((response) => {
    bridgeStatus.textContent = response?.connected ? "Bridge connected" : "Bridge disconnected";
}).catch((error) => { bridgeStatus.textContent = error.message; });

connectButton.addEventListener("click", async () => {
    connectButton.disabled = true;
    bridgeStatus.textContent = "Connecting…";
    try {
        const response = await chrome.runtime.sendMessage({
            type: "tabpilot:connect",
            token: bridgeToken.value.trim()
        });
        if (!response?.ok) throw new Error(response?.error ?? "Connection failed.");
        bridgeToken.value = "";
        bridgeStatus.textContent = "Bridge connected";
    } catch (error) {
        bridgeStatus.textContent = error.message;
    } finally {
        connectButton.disabled = false;
    }
});

chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(async ([tab]) => {
        if (!Number.isInteger(tab?.id)) throw new Error("No active tab found.");
        const key = `tab:${tab.id}`;
        const stored = await chrome.storage.session.get(key);

        enabled = stored[key] ?? false;

        accessStatus.textContent = enabled ? "Access enabled" : "Access disabled";
        toggleButton.textContent = enabled ? "Disable access" : "Enable access";
        toggleButton.disabled = false;
        readButton.disabled = false;

        toggleButton.addEventListener("click", async () => {
            toggleButton.disabled = true;
            try {
                const nextEnabled = !enabled;
                const response = await chrome.runtime.sendMessage({ type: "tabpilot:access", tabId: tab.id, enabled: nextEnabled });
                if (!response?.ok) throw new Error(response?.error || "Could not change tab access.");
                enabled = response.enabled;

                accessStatus.textContent = enabled ? "Access enabled" : "Access disabled";
                toggleButton.textContent = enabled ? "Disable access" : "Enable access";
                snapshotOutput.textContent = "";
            } catch (error) {
                snapshotOutput.textContent = error.message;
            } finally {
                toggleButton.disabled = false;
            }
        });

        readButton.addEventListener("click", async () => {
            readButton.disabled = true;
            snapshotOutput.textContent = "Reading page…";
            try {
                const response = await chrome.runtime.sendMessage({
                    type: "tabpilot:snapshot",
                    tabId: tab.id,
                });
                if (!response?.ok) throw new Error(response?.error ?? "No snapshot returned.");
                snapshotOutput.textContent = JSON.stringify(response.snapshot, null, 2);
            } catch (error) {
                snapshotOutput.textContent = error.message;
            } finally {
                readButton.disabled = false;
            }
        });
    })
    .catch((error) => {
        snapshotOutput.textContent = error.message;
    });
