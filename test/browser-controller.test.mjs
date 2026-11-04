import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../browser-controller.js", import.meta.url), "utf8");
export function controllerFixture() {
    const stored = {}, calls = [], handlers = {};
    const chrome = {
        storage: { session: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, value),
            remove: async key => { delete stored[key]; } } },
        tabs: { get: async id => ({ id, url: "https://example.com/" }) },
        debugger: {
            onDetach: { addListener(fn) { handlers.detach = fn; } },
            onEvent: { addListener(fn) { handlers.event = fn; } },
            attach: async target => { calls.push({ method: "attach", target }); },
            detach: async target => { calls.push({ method: "detach", target }); },
            sendCommand: async (target, method, params) => {
                calls.push({ target, method, params });
                if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
                if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
                if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } };
                if (method === "Runtime.evaluate" && params.expression.includes(')("resolve",')) return { result: { value: {
                    x: 10, y: 20, width: 100, height: 30, editable: true, tag: "input", type: "text"
                } } };
                if (method === "Runtime.evaluate" && params.expression.includes(')("focus",')) return { result: { value: { focused: true } } };
                if (method === "Runtime.evaluate") return { result: { value: { title: "Test", url: "https://example.com/",
                    text: "Example", truncated: false, snapshotId: "snapshot-1" } } };
                return {};
            }
        }
    };
    const context = vm.createContext({ URL, setTimeout, clearTimeout, crypto: globalThis.crypto });
    vm.runInContext(source, context);
    const Browser = vm.runInContext("TabPilotBrowser", context);
    return { browser: new Browser(chrome, () => {}), chrome, stored, calls, handlers };
}

test("disabled tabs cannot attach and explicit enable/disable controls the debugger", async () => {
    const { browser, calls, stored } = controllerFixture();
    await assert.rejects(browser.snapshot(12), /Access disabled/);
    assert.equal(calls.length, 0);
    await browser.setAccess(12, true);
    assert.equal(stored["tab:12"], true);
    await Promise.all([browser.snapshot(12), browser.snapshot(12)]);
    assert.equal(calls.filter(call => call.method === "attach").length, 1);
    await browser.setAccess(12, false);
    assert.equal(stored["tab:12"], undefined);
    assert.equal(calls.filter(call => call.method === "detach").length, 1);
    await assert.rejects(browser.snapshot(12), /Access disabled/);
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
    assert.equal(calls.find(call => call.method === "Input.insertText").params.text, "Exact user text");
    await browser.action(12, "press", { key: "Enter" });
    assert.ok(calls.some(call => call.method === "Input.dispatchKeyEvent" && call.params.text === "\r"));
    await browser.action(12, "scroll", { deltaY: 500 });
    assert.ok(calls.some(call => call.params?.type === "mouseWheel" && call.params.deltaY === 500));
    await assert.rejects(browser.action(12, "click", { ref: "old:e1" }), /STALE_REF/);
});

test("detach revokes permission and navigation invalidates old references", async () => {
    const { browser, stored, handlers } = controllerFixture();
    await browser.setAccess(12, true);
    await browser.snapshot(12);
    assert.equal(browser.snapshots.get(12), "snapshot-1");
    handlers.event({ tabId: 12 }, "Page.frameNavigated", {});
    assert.equal(browser.snapshots.has(12), false);
    handlers.detach({ tabId: 12 });
    assert.equal(stored["tab:12"], undefined);
    await assert.rejects(browser.snapshot(12), /Access disabled/);
});
