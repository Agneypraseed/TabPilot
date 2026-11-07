import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../tab-access.js", import.meta.url), "utf8")) + "\n" + await readFile(new URL("../browser-controller.js", import.meta.url), "utf8");
test("concurrent revocations preserve both tabs and restoring one leaves the other blocked", async () => {
    const { browser, chrome } = controllerFixture();
    const local = {};
    chrome.storage.local = { get: async key => ({ [key]: structuredClone(local[key]) }), set: async value => { await Promise.resolve(); Object.assign(local, value); } };
    await Promise.all([browser.setAccess(12, false), browser.setAccess(34, false)]);
    assert.deepEqual([...local.tabAccessRevocations].sort((a,b) => a-b), [12, 34]);
    await browser.setAccess(12, true);
    await browser.permitted(12);
    await assert.rejects(browser.permitted(34), /Access disabled/);
});
export function controllerFixture() {
    const stored = {}, calls = [], handlers = {};
    const chrome = {
        storage: { session: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, value),
            remove: async key => { delete stored[key]; } } },
        tabs: { get: async id => ({ id, url: "https://example.com/", windowId: 1 }),
            create: async options => ({ id: 34, ...options }), remove: async id => calls.push({ method: "remove", id }),
            update: async (id, options) => calls.push({ method: "update", id, options }) },
        windows: { update: async () => {} },
        debugger: {
            onDetach: { addListener(fn) { handlers.detach = fn; } },
            onEvent: { addListener(fn) { handlers.event = fn; } },
            attach: async target => { calls.push({ method: "attach", target }); },
            detach: async target => { calls.push({ method: "detach", target }); },
            sendCommand: async (target, method, params) => {
                calls.push({ target, method, params });
                if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
                if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [
                    { id: 1, url: "https://example.com/first" }, { id: 2, url: "https://example.com/" }, { id: 3, url: "https://example.com/next" }
                ] };
                if (method === "Runtime.evaluate" && params.expression.includes(')("status",')) return { result: { value: { ready: true, matches: true } } };
                if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
                if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } };
                if (method === "Page.captureScreenshot") return { data: Buffer.from([255,216,255,192,0,11,8,3,32,3,232,1,1,0,0,255,217]).toString("base64") };
                if (method === "Runtime.evaluate" && params.expression.includes(')("fingerprint",')) return { result: { value: { id: "page-1", revision: 1 } } };
                if (method === "Runtime.evaluate" && params.expression.includes(')("resolve",')) return { result: { value: {
                    x: 10, y: 20, width: 100, height: 30, editable: true, tag: "input", type: "text"
                } } };
                if (method === "Runtime.evaluate" && (params.expression.includes(')("focus",') || params.expression.includes(')("typing-status",'))) return { result: { value: { focused: true } } };
                if (method === "Runtime.evaluate") return { result: { value: { title: "Test", url: "https://example.com/",
                    text: "Example", truncated: false, snapshotId: "snapshot-1" } } };
                return {};
            }
        }
    };
    const context = vm.createContext({ URL, setTimeout, clearTimeout, atob, crypto: globalThis.crypto });
    vm.runInContext(source, context);
    const Browser = vm.runInContext("TabPilotBrowser", context);
    return { browser: new Browser(chrome, () => {}), chrome, stored, calls, handlers };
}

test("web tabs default to access, attach lazily, and explicit revocation blocks control", async () => {
    const { browser, calls, stored } = controllerFixture();
    await browser.permitted(12);
    assert.equal(calls.length, 0);
    await browser.setAccess(12, false);
    await assert.rejects(browser.snapshot(12), /Access disabled/);
    await browser.setAccess(12, true);
    assert.equal(stored["tab:12"], undefined);
    assert.equal(calls.filter(call => call.method === "attach").length, 0);
    const simultaneous = await Promise.allSettled([browser.snapshot(12), browser.snapshot(12)]);
    assert.equal(simultaneous.filter(result => result.status === "fulfilled").length, 1);
    assert.match(simultaneous.find(result => result.status === "rejected").reason.message, /TAB_BUSY/);
    assert.equal(calls.filter(call => call.method === "attach").length, 1);
    await browser.setAccess(12, false);
    assert.equal(stored["tab:12"], false);
    assert.equal(calls.filter(call => call.method === "detach").length, 1);
    await assert.rejects(browser.snapshot(12), /Access disabled/);
});

test("embedded foreground-only tab creation falls back once and keeps default access", async () => {
    const { browser, chrome, stored } = controllerFixture();
    await browser.setAccess(12, true);
    const attempts = [];
    chrome.tabs.create = async options => {
        attempts.push({ ...options });
        if (!options.active) throw new Error("Owl extension-created tabs must be active.");
        return { id: 34, ...options };
    };
    const result = await browser.action(12, "open", { url: "https://example.com/research", active: false });
    assert.deepEqual(attempts.map(item => item.active), [false, true]);
    assert.equal(attempts[1].windowId, 1);
    assert.equal(result.openedInForeground, true);
    assert.equal(result.enabled, true);
    assert.equal(stored["tab:34"], undefined);
    attempts.length = 0;
    chrome.tabs.create = async options => { attempts.push(options); throw new Error("General failure; outcome unknown"); };
    await assert.rejects(browser.action(12, "open", { url: "https://example.com/" }), /General failure/);
    assert.equal(attempts.length, 1);
});

test("click, fill, key, and scroll use CDP input and return observed state", async () => {
    const { browser, calls } = controllerFixture();
    await browser.setAccess(12, true);
    await browser.snapshot(12);
    const clicked = await browser.action(12, "click", { ref: "snapshot-1:e1" });
    assert.equal(clicked.snapshot.title, "Test");
    const mouse = calls.filter(call => call.method === "Input.dispatchMouseEvent");
    assert.deepEqual(mouse.map(call => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
    assert.equal(mouse[1].params.x, 60);
    assert.equal(mouse[1].params.y, 35);
    await browser.action(12, "fill", { ref: "snapshot-1:e1", text: "Exact user text" });
    assert.equal(calls.filter(call => call.method === "Input.insertText").map(call => call.params.text).join(""), "Exact user text");
    await browser.action(12, "press", { key: "Enter" });
    assert.ok(calls.some(call => call.method === "Input.dispatchKeyEvent" && call.params.text === "\r"));
    await browser.action(12, "scroll", { deltaY: 500 });
    assert.ok(calls.some(call => call.params?.type === "mouseWheel" && call.params.deltaY === 500));
    await assert.rejects(browser.action(12, "click", { ref: "old:e1" }), /STALE_REF/);
});

test("held browser key sends keyDown and releases only after the hold", async () => {
    const { browser, calls } = controllerFixture();
    const start = performance.now();
    await browser.action(12, "press", { key: "w", holdMs: 40 });
    const events = calls.filter(call => call.method === "Input.dispatchKeyEvent");
    assert.deepEqual(events.map(({ params }) => [params.type, params.code]), [["keyDown", "KeyW"], ["keyUp", "KeyW"]]);
    assert.ok(performance.now() - start >= 35);
    await assert.rejects(browser.action(12, "press", { key: "w", holdMs: 2001 }), /Hold duration/);
});

test("pointer motion uses one page-local animation and hides before screenshots", async () => {
    const { browser, calls } = controllerFixture();
    await browser.setAccess(12, true);
    await browser.snapshot(12);
    await browser.action(12, "click", { ref: "snapshot-1:e1" });
    const pointer = calls.filter(c => c.method === "Runtime.evaluate" && c.params.expression.includes(')("pointer",'));
    assert.equal(pointer.length, 2, "one move and one click, without a protocol call per animation frame");
    assert.ok(pointer[0].params.expression.includes('"x":60,"y":35'));
    assert.equal(calls.some(c => c.method.startsWith("Overlay.")), false);
    await browser.screenshot(12);
    const capture = calls.findIndex(c => c.method === "Page.captureScreenshot");
    assert.ok(calls.slice(0, capture).some(c => c.params?.expression?.includes('"visible":false')));
    await browser.setAccess(12, false);
    assert.equal(browser.visuals.has(12), false);
});

test("unavailable pointer rendering does not prevent normal input", async () => {
    const { browser, chrome, calls } = controllerFixture();
    const send = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (...args) => {
        if (args[1] === "Runtime.evaluate" && args[2].expression.includes(')("pointer",')) throw new Error("Visual unavailable");
        return send(...args);
    };
    await browser.setAccess(12, true);
    await browser.snapshot(12);
    await browser.action(12, "click", { ref: "snapshot-1:e1" });
    assert.ok(calls.some(c => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased"));
    await browser.setAccess(12, false);
});

test("paced typing preserves Unicode and stops instead of typing into a different focused field", async () => {
    const { browser, chrome, calls } = controllerFixture();
    await browser.setAccess(12, true);
    await browser.snapshot(12);
    await browser.action(12, "fill", { ref: "snapshot-1:e1", text: "Hi 👋🏽" });
    assert.equal(calls.filter(c => c.method === "Input.insertText").map(c => c.params.text).join(""), "Hi 👋🏽");
    calls.length = 0;
    await browser.typeText(12, "snapshot-1:e1", "x".repeat(2000));
    const chunks = calls.filter(c => c.method === "Input.insertText");
    assert.ok(chunks.length <= 24, "long values must not create thousands of delayed input operations");
    assert.equal(chunks.map(c => c.params.text).join(""), "x".repeat(2000));
    const send = chrome.debugger.sendCommand;
    let checks = 0;
    chrome.debugger.sendCommand = async (...args) => {
        if (args[1] === "Runtime.evaluate" && args[2].expression.includes(')("typing-status",')) {
            return { result: { value: { focused: ++checks === 1 } } };
        }
        return send(...args);
    };
    calls.length = 0;
    await assert.rejects(browser.action(12, "fill", { ref: "snapshot-1:e1", text: "Stop here" }), /lost focus/);
    assert.equal(calls.filter(c => c.method === "Input.insertText").map(c => c.params.text).join(""), "S");
    await browser.setAccess(12, false);
});

test("detach revokes permission and navigation invalidates old references", async () => {
    const { browser, stored, handlers } = controllerFixture();
    await browser.setAccess(12, true);
    await browser.snapshot(12);
    assert.equal(browser.snapshots.get(12), "snapshot-1");
    handlers.event({ tabId: 12 }, "Page.frameNavigated", {});
    assert.equal(browser.snapshots.has(12), false);
    handlers.detach({ tabId: 12 });
    assert.equal(stored["tab:12"], false);
    await assert.rejects(browser.snapshot(12), /Access disabled/);
});

test("navigation/history stay within web pages and newly created tabs have access by default", async () => {
    const { browser, stored, calls } = controllerFixture();
    await browser.setAccess(12, true);
    await assert.rejects(browser.action(12, "navigate", { url: "javascript:alert(1)" }), /cannot be controlled/);
    await browser.action(12, "navigate", { url: "https://example.com/next" });
    assert.ok(calls.some(call => call.method === "Page.navigate" && call.params.url === "https://example.com/next"));
    await browser.action(12, "back");
    await browser.action(12, "forward");
    assert.deepEqual(calls.filter(call => call.method === "Page.navigateToHistoryEntry").map(call => call.params.entryId), [1, 3]);
    const created = await browser.action(12, "open", { url: "https://example.com/new" });
    assert.equal(created.tabId, 34);
    assert.equal(created.enabled, true);
    assert.equal(stored["tab:34"], undefined);
    await browser.snapshot(34);
    await browser.action(12, "close");
    assert.equal(stored["tab:12"], undefined);
    assert.ok(calls.some(call => call.method === "remove" && call.id === 12));
});

test("screenshots are bound to enabled tabs and stale coordinates are rejected", async () => {
    const { browser, calls, handlers } = controllerFixture();
    await browser.setAccess(12, false);
    await assert.rejects(browser.screenshot(12), /Access disabled/);
    await browser.setAccess(12, true);
    const screenshot = await browser.screenshot(12);
    assert.equal(screenshot.mimeType, "image/jpeg");
    assert.equal(screenshot.width, 1000);
    await assert.rejects(browser.action(12, "coordinate", { screenshotId: screenshot.screenshotId, x: 1001, y: 10 }), /inside/);
    await browser.action(12, "coordinate", { screenshotId: screenshot.screenshotId, x: 40, y: 50 });
    assert.ok(calls.some(call => call.params?.type === "mousePressed" && call.params.x === 40 && call.params.y === 50));
    await assert.rejects(browser.action(12, "coordinate", { screenshotId: screenshot.screenshotId, x: 40, y: 50 }), /STALE_SCREENSHOT/);
    const fresh = await browser.screenshot(12);
    handlers.event({ tabId: 12 }, "Page.frameNavigated", {});
    await assert.rejects(browser.action(12, "coordinate", { screenshotId: fresh.screenshotId, x: 40, y: 50 }), /STALE_SCREENSHOT/);
});

test("screenshot pointer coordinates account for device pixel scaling", async () => {
    const { browser, chrome, calls } = controllerFixture();
    const send = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (target, method, params) => method === "Page.getLayoutMetrics"
        ? { cssVisualViewport: { clientWidth: 800, clientHeight: 640 } } : send(target, method, params);
    await browser.setAccess(12, true);
    const image = await browser.screenshot(12);
    assert.equal(image.width, 1000);
    await browser.action(12, "coordinate", { screenshotId: image.screenshotId, x: 500, y: 400 });
    assert.ok(calls.some(call => call.params?.type === "mousePressed" && call.params.x === 400 && call.params.y === 320));
});

test("hover, drag, and JavaScript dialog handling remain permission gated", async () => {
    const { browser, calls, handlers } = controllerFixture();
    await browser.setAccess(12, true);
    await browser.snapshot(12);
    await browser.action(12, "hover", { ref: "snapshot-1:e1" });
    assert.ok(calls.some(call => call.params?.type === "mouseMoved"));
    const image = await browser.screenshot(12);
    await browser.action(12, "coordinate", { screenshotId: image.screenshotId, kind: "drag", x: 20, y: 20, toX: 100, toY: 100 });
    assert.ok(calls.some(call => call.params?.type === "mouseMoved" && call.params.buttons === 1 && call.params.x === 100));
    handlers.event({ tabId: 12 }, "Page.javascriptDialogOpening", { type: "prompt", message: "Choose a color" });
    const snapshot = await browser.snapshot(12);
    assert.equal(snapshot.dialog.type, "prompt");
    await assert.rejects(browser.action(12, "press", { key: "Enter" }), /dialog is open/);
    await browser.action(12, "dialog", { accept: true, promptText: "blue" });
    assert.ok(calls.some(call => call.method === "Page.handleJavaScriptDialog" && call.params.promptText === "blue"));
});

test("double click dispatches two complete native click sequences", async () => {
    const { browser, calls } = controllerFixture();
    await browser.setAccess(12, true);
    await browser.snapshot(12);
    await browser.action(12, "click", { ref: "snapshot-1:e1", clickCount: 2 });
    assert.deepEqual(calls.filter(call => ["mousePressed", "mouseReleased"].includes(call.params?.type)).map(call => call.params.clickCount), [1, 1, 2, 2]);
});
