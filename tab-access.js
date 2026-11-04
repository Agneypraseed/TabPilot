// Absence means access is allowed. Only an explicit false revokes a web tab.
globalThis.TabPilotTabAccess = {
    enabled(stored, tabId) { return stored[`tab:${tabId}`] !== false; },
    async read(chromeApi, key = null) {
        const [stored, local] = await Promise.all([
            chromeApi.storage.session.get(key),
            chromeApi.storage.local?.get("tabAccessRevocations") ?? {}
        ]);
        for (const id of local.tabAccessRevocations ?? []) if (Number.isSafeInteger(id) && id >= 0) stored[`tab:${id}`] = false;
        return stored;
    },
    supported(url) {
        try {
            const page = new URL(url);
            return /^https?:$/.test(page.protocol) && page.hostname !== "chromewebstore.google.com" &&
                !(page.hostname === "chrome.google.com" && page.pathname.startsWith("/webstore"));
        } catch { return false; }
    }
};
