// Extension-only controller. Every Chrome command checks the enabled-tab boundary.
class TabPilotBrowser {
    constructor(chromeApi, pageFunction) {
        this.chrome = chromeApi;
        this.pageFunction = pageFunction;
        this.attached = new Set();
        this.attaching = new Map();
        this.queues = new Map();
        this.snapshots = new Map();
        this.screenshots = new Map();
        this.dialogs = new Map();
        chromeApi.debugger.onDetach.addListener(source => {
            this.attached.delete(source.tabId);
            this.invalidate(source.tabId);
            void chromeApi.storage.session.remove(`tab:${source.tabId}`);
        });
        chromeApi.debugger.onEvent.addListener((source, method, params) => {
            if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument") this.invalidate(source.tabId);
            if (method === "Page.javascriptDialogOpening") this.dialogs.set(source.tabId, { type: params.type, message: params.message });
            if (method === "Page.javascriptDialogClosed") this.dialogs.delete(source.tabId);
        });
    }

    invalidate(tabId) { this.snapshots.delete(tabId); this.screenshots.delete(tabId); }

    async permitted(tabId) {
        if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error("Invalid tab ID.");
        const key = `tab:${tabId}`;
        const stored = await this.chrome.storage.session.get(key);
        if (stored[key] !== true) throw new Error("Access disabled. Enable this tab before reading or controlling it.");
        const tab = await this.chrome.tabs.get(tabId);
        if (!/^https?:\/\//.test(tab.url ?? "")) throw new Error("Open a regular HTTP or HTTPS page before using TabPilot.");
        const url = new URL(tab.url);
        if (url.hostname === "chromewebstore.google.com" || (url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"))) {
            throw new Error("Chrome protects its extension store from browser control.");
        }
        return tab;
    }

    async setAccess(tabId, enabled) {
        if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof enabled !== "boolean") throw new Error("Invalid access request.");
        const key = `tab:${tabId}`;
        if (!enabled) {
            await this.chrome.storage.session.remove(key);
            this.invalidate(tabId);
            await this.detach(tabId);
            return { enabled: false };
        }
        await this.chrome.storage.session.set({ [key]: true });
        try { await this.ensureAttached(tabId); }
        catch (error) { await this.chrome.storage.session.remove(key); await this.detach(tabId); throw error; }
        return { enabled: true };
    }

    async detach(tabId) {
        if (this.attached.delete(tabId)) await this.chrome.debugger.detach({ tabId }).catch(() => {});
        this.invalidate(tabId);
        this.dialogs.delete(tabId);
    }

    async ensureAttached(tabId) {
        await this.permitted(tabId);
        if (this.attached.has(tabId)) return;
        if (this.attaching.has(tabId)) return this.attaching.get(tabId);
        const operation = (async () => {
            try { await this.chrome.debugger.attach({ tabId }, "1.3"); }
            catch { throw new Error("Chrome could not attach to this tab. Close conflicting DevTools/controllers, check extension permissions, then enable it again."); }
            this.attached.add(tabId);
            try {
                await this.command(tabId, "Page.enable");
                await this.command(tabId, "Runtime.enable");
            } catch (error) { await this.detach(tabId); throw error; }
        })();
        this.attaching.set(tabId, operation);
        try { await operation; } finally { this.attaching.delete(tabId); }
    }

    async command(tabId, method, params = {}) {
        await this.permitted(tabId);
        return this.chrome.debugger.sendCommand({ tabId }, method, params);
    }

    async evaluate(tabId, operation, args = {}) {
        const { frameTree } = await this.command(tabId, "Page.getFrameTree");
        const { executionContextId } = await this.command(tabId, "Page.createIsolatedWorld", {
            frameId: frameTree.frame.id, worldName: "TabPilot isolated controls"
        });
        const result = await this.command(tabId, "Runtime.evaluate", {
            expression: `(${this.pageFunction.toString()})(${JSON.stringify(operation)},${JSON.stringify(args)})`,
            contextId: executionContextId, returnByValue: true, awaitPromise: true
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Page operation failed.");
        if (result.result?.subtype === "error") throw new Error(result.result.description);
        return result.result?.value;
    }

    serial(tabId, operation) {
        const previous = this.queues.get(tabId) || Promise.resolve();
        const task = previous.catch(() => {}).then(async () => { await this.ensureAttached(tabId); return operation(); });
        this.queues.set(tabId, task);
        task.finally(() => { if (this.queues.get(tabId) === task) this.queues.delete(tabId); }).catch(() => {});
        return task;
    }

    snapshot(tabId) {
        return this.serial(tabId, async () => {
            const snapshot = await this.evaluate(tabId, "snapshot");
            await this.permitted(tabId);
            if (!snapshot) throw new Error("The page did not return a snapshot.");
            this.snapshots.set(tabId, snapshot.snapshotId);
            return { ...snapshot, dialog: this.dialogs.get(tabId) };
        });
    }
}
