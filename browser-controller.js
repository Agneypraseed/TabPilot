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
            return this.observe(tabId);
        });
    }

    async observe(tabId) {
            if (this.dialogs.has(tabId)) {
                const tab = await this.permitted(tabId);
                return { title: tab.title || "", url: tab.url, text: "JavaScript dialog open.", truncated: false,
                    elements: [], dialog: this.dialogs.get(tabId) };
            }
            const snapshot = await this.evaluate(tabId, "snapshot");
            await this.permitted(tabId);
            if (!snapshot) throw new Error("The page did not return a snapshot.");
            this.snapshots.set(tabId, snapshot.snapshotId);
            return snapshot;
    }

    async resolve(tabId, ref) {
        const id = this.snapshots.get(tabId);
        if (typeof ref !== "string" || !id || !ref.startsWith(`${id}:`)) throw new Error("STALE_REF: take a new snapshot and use its refs.");
        return this.evaluate(tabId, "resolve", { ref });
    }

    async mouse(tabId, type, x, y, extra = {}) {
        if (![x, y].every(Number.isFinite) || x < 0 || y < 0) throw new Error("Invalid pointer coordinates.");
        return this.command(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });
    }

    async clickPoint(tabId, x, y, button = "left", clickCount = 1) {
        if (!["left", "right", "middle"].includes(button) || ![1, 2].includes(clickCount)) throw new Error("Invalid click options.");
        await this.mouse(tabId, "mouseMoved", x, y);
        await this.mouse(tabId, "mousePressed", x, y, { button, clickCount });
        await this.mouse(tabId, "mouseReleased", x, y, { button, clickCount });
    }

    async key(tabId, combination) {
        if (typeof combination !== "string" || combination.length > 80) throw new Error("Invalid key.");
        const parts = combination.split("+");
        let key = parts.pop(), modifiers = 0;
        for (const part of parts) {
            const bit = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 }[part];
            if (!bit) throw new Error("Unknown key modifier.");
            modifiers |= bit;
        }
        const codes = { Enter: ["Enter", 13], Tab: ["Tab", 9], Escape: ["Escape", 27], Backspace: ["Backspace", 8],
            Delete: ["Delete", 46], ArrowDown: ["ArrowDown", 40], ArrowUp: ["ArrowUp", 38], ArrowLeft: ["ArrowLeft", 37],
            ArrowRight: ["ArrowRight", 39], Home: ["Home", 36], End: ["End", 35], PageDown: ["PageDown", 34], PageUp: ["PageUp", 33], Space: ["Space", 32] };
        let code, virtualKey;
        if (codes[key]) [code, virtualKey] = codes[key];
        else if (key.length === 1) { code = /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : ""; virtualKey = key.toUpperCase().charCodeAt(0); }
        else throw new Error("Unsupported key. Use Enter, Tab, Escape, arrows, navigation keys, or a character with modifiers.");
        if (key === "Space") key = " ";
        const params = { key, code, windowsVirtualKeyCode: virtualKey, modifiers };
        const text = !(modifiers & (2 | 4)) ? (key === "Enter" ? "\r" : key.length === 1 ? key : undefined) : undefined;
        await this.command(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...params, ...(text ? { text } : {}) });
        await this.command(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
    }

    httpUrl(value) {
        let url;
        try { url = new URL(value); } catch { throw new Error("Provide an absolute HTTP or HTTPS URL."); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hostname === "chromewebstore.google.com" ||
            (url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"))) throw new Error("This URL cannot be controlled.");
        return url.href;
    }

    async waitDocument(tabId, { text, timeoutMs = 8000, loaderId } = {}) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 || (text !== undefined && typeof text !== "string")) throw new Error("Invalid wait condition.");
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            await this.permitted(tabId);
            if (this.dialogs.has(tabId)) return;
            try {
                const { frameTree } = await this.command(tabId, "Page.getFrameTree");
                if (!loaderId || frameTree.frame.loaderId === loaderId) {
                    const status = await this.evaluate(tabId, "status", { text });
                    if (status?.ready && status.matches) return;
                }
            } catch (error) {
                if (/Access disabled|No tab|Invalid tab|protected/i.test(error.message)) throw error;
                // A navigation can destroy the isolated world while it is being read.
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error("Wait timed out; take a fresh snapshot to inspect the current page.");
    }

    action(tabId, method, params = {}) {
        return this.serial(tabId, async () => {
            if (this.dialogs.has(tabId) && method !== "dialog") throw new Error("A JavaScript dialog is open. Use browser_dialog first.");
            let result = {};
            if (method === "navigate") {
                const navigation = await this.command(tabId, "Page.navigate", { url: this.httpUrl(params.url) });
                if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
                this.invalidate(tabId);
                await this.waitDocument(tabId, { loaderId: navigation.loaderId });
            } else if (["back", "forward"].includes(method)) {
                const history = await this.command(tabId, "Page.getNavigationHistory");
                const entry = history.entries[history.currentIndex + (method === "back" ? -1 : 1)];
                if (!entry) throw new Error(`No ${method} history entry.`);
                this.httpUrl(entry.url);
                await this.command(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
                this.invalidate(tabId);
                await new Promise(resolve => setTimeout(resolve, 150));
                await this.waitDocument(tabId);
            } else if (method === "reload") {
                await this.command(tabId, "Page.reload");
                this.invalidate(tabId);
                await new Promise(resolve => setTimeout(resolve, 150));
                await this.waitDocument(tabId);
            } else if (method === "wait") {
                await this.waitDocument(tabId, params);
            } else if (method === "open") {
                const url = this.httpUrl(params.url);
                await this.permitted(tabId);
                const created = await this.chrome.tabs.create({ url, active: params.active === true });
                // All newly opened tabs start disabled, including agent-created tabs.
                await this.chrome.storage.session.remove(`tab:${created.id}`);
                return { action: method, tabId: created.id, url, enabled: false,
                    message: "New tab opened disabled. The user must explicitly enable it before the agent can access it." };
            } else if (method === "close") {
                await this.permitted(tabId);
                await this.chrome.storage.session.remove(`tab:${tabId}`);
                await this.detach(tabId);
                await this.chrome.tabs.remove(tabId);
                return { action: method, tabId, closed: true };
            } else if (method === "focus") {
                const tab = await this.permitted(tabId);
                await this.chrome.tabs.update(tabId, { active: true });
                await this.chrome.windows.update(tab.windowId, { focused: true });
            } else if (method === "dialog") {
                if (!this.dialogs.has(tabId)) throw new Error("No JavaScript dialog is open.");
                if (typeof params.accept !== "boolean" || (params.promptText !== undefined && typeof params.promptText !== "string")) throw new Error("Specify accept true/false and optional promptText.");
                await this.command(tabId, "Page.handleJavaScriptDialog", params);
                this.dialogs.delete(tabId);
            } else if (["click", "hover", "fill", "select"].includes(method)) {
                const target = await this.resolve(tabId, params.ref);
                const x = target.x + target.width / 2, y = target.y + target.height / 2;
                if (method === "click") await this.clickPoint(tabId, x, y, params.button, params.clickCount);
                if (method === "hover") await this.mouse(tabId, "mouseMoved", x, y);
                if (method === "fill") {
                    if (typeof params.text !== "string" || params.text.length > 20000) throw new Error("Text must be a string of at most 20000 characters.");
                    if (!target.editable || target.readOnly || ["file", "checkbox", "radio", "range", "button", "submit"].includes(target.type)) throw new Error("Target does not accept text.");
                    await this.clickPoint(tabId, x, y);
                    await this.evaluate(tabId, "focus", { ref: params.ref });
                    await this.key(tabId, globalThis.navigator?.platform?.includes("Mac") ? "Meta+a" : "Control+a");
                    await this.key(tabId, "Backspace");
                    if (params.text) await this.command(tabId, "Input.insertText", { text: params.text });
                }
                if (method === "select") {
                    if (!Array.isArray(params.values) || !params.values.length || params.values.length > 100 || params.values.some(v => typeof v !== "string")) throw new Error("Provide option values.");
                    result = await this.evaluate(tabId, "select", { ref: params.ref, values: params.values });
                }
            } else if (method === "press") {
                if (params.ref) { await this.resolve(tabId, params.ref); await this.evaluate(tabId, "focus", { ref: params.ref }); }
                await this.key(tabId, params.key);
            } else if (method === "scroll") {
                const deltaY = params.deltaY ?? 600, deltaX = params.deltaX ?? 0;
                if (![deltaX, deltaY].every(v => Number.isFinite(v) && Math.abs(v) <= 10000)) throw new Error("Scroll deltas must be within 10000 pixels.");
                const { cssVisualViewport: viewport } = await this.command(tabId, "Page.getLayoutMetrics");
                const target = params.ref ? await this.resolve(tabId, params.ref) : { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight };
                await this.mouse(tabId, "mouseWheel", target.x + target.width / 2, target.y + target.height / 2, { deltaX, deltaY });
            } else throw new Error("Unknown browser action.");
            this.invalidate(tabId);
            await new Promise(resolve => setTimeout(resolve, 100));
            // Actions return fresh references and visible state for the next decision.
            try { return { action: method, ...result, snapshot: await this.observe(tabId) }; }
            catch (error) { return { action: method, ...result, observationError: error.message, needsSnapshot: true }; }
        });
    }
}
