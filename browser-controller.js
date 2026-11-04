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
        this.visuals = new Map();
        chromeApi.debugger.onDetach.addListener(source => {
            this.forgetVisual(source.tabId);
            this.attached.delete(source.tabId);
            this.invalidate(source.tabId);
            void chromeApi.storage.session.remove(`tab:${source.tabId}`);
        });
        chromeApi.debugger.onEvent.addListener((source, method, params) => {
            if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument") { this.invalidate(source.tabId); this.forgetVisual(source.tabId); }
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
        this.forgetVisual(tabId);
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
        // Reject overlapping work rather than executing an old action after its caller timed out.
        if (this.queues.has(tabId)) return Promise.reject(new Error("TAB_BUSY: wait for the current operation, then observe again."));
        const task = Promise.resolve().then(async () => { await this.ensureAttached(tabId); return operation(); });
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
        if (type === "mouseMoved") {
            if (extra.buttons) { await this.drawVisual(tabId, x, y); await new Promise(resolve => setTimeout(resolve, 20)); }
            else await this.moveVisual(tabId, x, y);
        }
        if (type === "mousePressed") await this.drawVisual(tabId, x, y, true);
        return this.command(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });
    }

    forgetVisual(tabId) {
        if (this.visuals.get(tabId)?.timer) clearTimeout(this.visuals.get(tabId).timer);
        this.visuals.delete(tabId);
    }

    async drawVisual(tabId, x, y, pressed = false) {
        let visual = this.visuals.get(tabId);
        if (visual?.unsupported) return;
        try {
            if (!visual) {
                await this.command(tabId, "DOM.enable");
                await this.command(tabId, "Overlay.enable");
                visual = {};
                this.visuals.set(tabId, visual);
            }
            clearTimeout(visual.timer);
            // Chrome's compositor overlay never enters the page DOM, intercepts
            // clicks, or invalidates element refs / screenshot fingerprints.
            if (pressed) await this.command(tabId, "Overlay.highlightRect", {
                x: Math.max(0, Math.round(x - 11)), y: Math.max(0, Math.round(y - 11)), width: 22, height: 22,
                color: { r: 52, g: 89, b: 238, a: 0.3 }, outlineColor: { r: 52, g: 89, b: 238, a: 1 }
            });
            else await this.command(tabId, "Overlay.highlightQuad", {
                quad: [x, y, x + 5, y + 20, x + 9, y + 11, x + 20, y + 7],
                color: { r: 52, g: 89, b: 238, a: 1 }, outlineColor: { r: 255, g: 255, b: 255, a: 1 }
            });
            visual.x = x; visual.y = y;
            visual.timer = setTimeout(() => { void this.command(tabId, "Overlay.hideHighlight").catch(() => {}); }, 1200);
        } catch {
            // Some embedded hosts omit Overlay. Input still works there.
            this.forgetVisual(tabId);
            if (this.attached.has(tabId)) this.visuals.set(tabId, { unsupported: true });
        }
    }

    async moveVisual(tabId, x, y) {
        const previous = this.visuals.get(tabId);
        const from = previous?.x !== undefined ? { x: previous.x, y: previous.y } : { x: Math.max(0, x - 35), y: Math.max(0, y - 20) };
        for (let step = 1; step <= 8; step++) {
            const progress = 1 - Math.pow(1 - step / 8, 3);
            await this.drawVisual(tabId, from.x + (x - from.x) * progress, from.y + (y - from.y) * progress);
            if (this.visuals.get(tabId)?.unsupported) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }

    async clickPoint(tabId, x, y, button = "left", clickCount = 1) {
        if (!["left", "right", "middle"].includes(button) || ![1, 2].includes(clickCount)) throw new Error("Invalid click options.");
        await this.mouse(tabId, "mouseMoved", x, y);
        for (let count = 1; count <= clickCount; count++) {
            await this.mouse(tabId, "mousePressed", x, y, { button, clickCount: count });
            if (!this.visuals.get(tabId)?.unsupported) await new Promise(resolve => setTimeout(resolve, 110));
            await this.mouse(tabId, "mouseReleased", x, y, { button, clickCount: count });
        }
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

    screenshot(tabId) {
        return this.serial(tabId, async () => {
            if (this.dialogs.has(tabId)) throw new Error("Dismiss the JavaScript dialog before taking a screenshot.");
            const { cssVisualViewport: viewport } = await this.command(tabId, "Page.getLayoutMetrics");
            const scale = Math.min(1, 1400 / viewport.clientWidth);
            const before = await this.evaluate(tabId, "fingerprint");
            if (this.visuals.get(tabId) && !this.visuals.get(tabId).unsupported) {
                await this.command(tabId, "Overlay.hideHighlight").catch(() => {});
            }
            const image = await this.command(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70, fromSurface: true,
                captureBeyondViewport: false, clip: { x: viewport.pageX, y: viewport.pageY,
                    width: viewport.clientWidth, height: viewport.clientHeight, scale } });
            const after = await this.evaluate(tabId, "fingerprint");
            if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Page changed during capture; take another screenshot.");
            await this.permitted(tabId);
            if (typeof image.data !== "string" || image.data.length > 6 * 1024 * 1024) throw new Error("Screenshot exceeds the supported size.");
            const screenshotId = crypto.randomUUID();
            const { width, height } = this.jpegDimensions(image.data);
            this.screenshots.set(tabId, { screenshotId, viewport, fingerprint: after,
                scaleX: width / viewport.clientWidth, scaleY: height / viewport.clientHeight, width, height, time: Date.now() });
            return { screenshotId, mimeType: "image/jpeg", data: image.data, width, height,
                coordinateSpace: "image pixels", viewport: { width: viewport.clientWidth, height: viewport.clientHeight } };
        });
    }

    jpegDimensions(data) {
        const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
        if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error("Screenshot is not a JPEG.");
        let offset = 2;
        while (offset + 4 < bytes.length) {
            if (bytes[offset] !== 255) throw new Error("Invalid JPEG marker.");
            const marker = bytes[offset + 1]; offset += 2;
            const length = (bytes[offset] << 8) | bytes[offset + 1];
            if (length < 2 || offset + length > bytes.length) break;
            if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
                const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
                const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
                if (!width || !height) break;
                return { width, height };
            }
            offset += length;
        }
        throw new Error("Could not read screenshot dimensions.");
    }

    async pointer(tabId, params) {
        const screenshot = this.screenshots.get(tabId);
        if (!screenshot || screenshot.screenshotId !== params.screenshotId || Date.now() - screenshot.time > 30000) {
            throw new Error("STALE_SCREENSHOT: capture a fresh screenshot before coordinate actions.");
        }
        const { cssVisualViewport: viewport } = await this.command(tabId, "Page.getLayoutMetrics");
        const current = await this.evaluate(tabId, "fingerprint");
        if (JSON.stringify(current) !== JSON.stringify(screenshot.fingerprint) ||
            ["pageX", "pageY", "clientWidth", "clientHeight"].some(key => viewport[key] !== screenshot.viewport[key])) {
            throw new Error("STALE_SCREENSHOT: page, scroll, or viewport changed; capture again.");
        }
        const point = (x, y) => {
            if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= screenshot.width || y >= screenshot.height) throw new Error("Coordinates must be inside the screenshot image.");
            return { x: x / screenshot.scaleX, y: y / screenshot.scaleY };
        };
        const from = point(params.x, params.y);
        if (params.kind === "hover") return this.mouse(tabId, "mouseMoved", from.x, from.y);
        if (params.kind === "click" || params.kind === undefined) return this.clickPoint(tabId, from.x, from.y, params.button, params.clickCount);
        if (params.kind !== "drag") throw new Error("Unknown pointer operation.");
        const to = point(params.toX, params.toY);
        await this.mouse(tabId, "mouseMoved", from.x, from.y);
        await this.mouse(tabId, "mousePressed", from.x, from.y, { button: "left", buttons: 1, clickCount: 1 });
        try {
            for (let step = 1; step <= 12; step++) await this.mouse(tabId, "mouseMoved", from.x + (to.x - from.x) * step / 12,
                from.y + (to.y - from.y) * step / 12, { button: "left", buttons: 1 });
        } finally { await this.mouse(tabId, "mouseReleased", to.x, to.y, { button: "left", clickCount: 1 }); }
    }

    action(tabId, method, params = {}) {
        return this.serial(tabId, async () => {
            if (this.dialogs.has(tabId) && method !== "dialog") throw new Error("A JavaScript dialog is open. Use browser_dialog first.");
            let result = {};
            if (method === "coordinate") {
                await this.pointer(tabId, params);
            } else if (method === "navigate") {
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
                    const focus = await this.evaluate(tabId, "focus", { ref: params.ref });
                    if (!focus?.focused) throw new Error("Could not focus the editable target; take a new snapshot.");
                    await this.key(tabId, globalThis.navigator?.platform?.includes("Mac") ? "Meta+a" : "Control+a");
                    await this.key(tabId, "Backspace");
                    if (params.text) await this.command(tabId, "Input.insertText", { text: params.text });
                }
                if (method === "select") {
                    if (!Array.isArray(params.values) || !params.values.length || params.values.length > 100 || params.values.some(v => typeof v !== "string")) throw new Error("Provide option values.");
                    result = await this.evaluate(tabId, "select", { ref: params.ref, values: params.values });
                }
            } else if (method === "press") {
                if (params.ref) {
                    await this.resolve(tabId, params.ref);
                    const focus = await this.evaluate(tabId, "focus", { ref: params.ref });
                    if (!focus?.focused) throw new Error("Could not focus the target.");
                }
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
