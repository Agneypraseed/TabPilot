const accessStatus = document.getElementById("access-status");
const toggleButton = document.getElementById("toggle-access");
const readButton = document.getElementById("read-page");
const snapshotOutput = document.getElementById("snapshot-output");

let enabled = false;

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
                await chrome.storage.session.set({ [key]: nextEnabled });
                enabled = nextEnabled;

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
