const accessStatus = document.getElementById("access-status");
const toggleButton = document.getElementById("toggle-access");

let enabled = false;

chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
    const key = `tab:${tab.id}`;
    const stored = await chrome.storage.session.get(key);

    enabled = stored[key] ?? false;

    accessStatus.textContent = enabled ? "Access enabled" : "Access disabled";
    toggleButton.textContent = enabled ? "Disable access" : "Enable access";

    toggleButton.addEventListener("click", async () => {
        const nextEnabled = !enabled;
        await chrome.storage.session.set({ [key]: nextEnabled });
        enabled = nextEnabled;

        accessStatus.textContent = enabled ? "Access enabled" : "Access disabled";
        toggleButton.textContent = enabled ? "Disable access" : "Enable access";
    });
});
