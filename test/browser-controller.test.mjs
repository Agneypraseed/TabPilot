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
