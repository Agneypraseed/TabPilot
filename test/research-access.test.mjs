import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { backgroundSource, mockDebugger } from "./background-source.mjs";

// Exercise the actual worker policy, without attaching to every listed tab.
test("all web tabs across windows are available by default; revocations persist and close clears them", async () => {
    const stored = {}, local = { historyScope: randomUUID() };
    let removed, startup;
    const tabs = new Map([[12, { id: 12, windowId: 1, title: "First", url: "https://example.com/" }],
        [34, { id: 34, windowId: 2, title: "Second", url: "https://other.example/" }],
        [99, { id: 99, url: "chrome://extensions/" }], [100, { id: 100, url: "https://chromewebstore.google.com/" }]]);
    let attaches = 0;
    const chrome = { runtime: { id: "test", onMessage: { addListener() {} }, onStartup: { addListener(fn) { startup = fn; } } },
        tabs: { query: async filter => { assert.deepEqual(Object.keys(filter), []); return [...tabs.values()]; },
            get: async id => { if (!tabs.has(id)) throw Error("Tab closed"); return tabs.get(id); }, onRemoved: { addListener(fn) { removed = fn; } } },
        storage: { session: { get: async key => key === null ? { ...stored } : { [key]: stored[key] }, set: async value => Object.assign(stored, value), remove: async key => { delete stored[key]; } },
            local: { get: async key => ({ [key]: local[key] }), set: async value => Object.assign(local, value), remove: async key => { delete local[key]; } } } };
    mockDebugger(chrome, async () => ({}));
    chrome.debugger.attach = async () => { attaches++; };
    const worker = () => { const context = vm.createContext({ chrome, URL, crypto: globalThis.crypto }); vm.runInContext(backgroundSource, context); return context; };
    const first = worker();
    assert.deepEqual(Array.from(await first.listEnabledTabs(), tab => tab.id), [12, 34]);
    assert.equal(attaches, 0, "Listing default access must not attach to every tab");
    await vm.runInContext('browser.setAccess(12, false)', first);
    assert.equal(stored["tab:12"], false);
    assert.deepEqual(Array.from(await first.listEnabledTabs(), tab => tab.id), [34]);
    delete stored["tab:12"]; // Chrome clears session storage on extension reload.
    const reloaded = worker();
    assert.deepEqual(Array.from(await reloaded.listEnabledTabs(), tab => tab.id), [34]);
    await vm.runInContext('browser.setAccess(12, true)', reloaded);
    assert.deepEqual(Array.from(await reloaded.listEnabledTabs(), tab => tab.id), [12, 34]);
    await vm.runInContext('browser.setAccess(12, false)', reloaded);
    tabs.delete(12); removed(12); await new Promise(resolve => setImmediate(resolve));
    assert.equal(stored["tab:12"], undefined);
    assert.equal(local.tabAccessRevocations.includes(12), false);
    tabs.set(56, { id: 56, windowId: 2, title: "New", url: "https://new.example/" });
    assert.deepEqual(Array.from(await reloaded.listEnabledTabs(), tab => tab.id), [34, 56]);
    await vm.runInContext('browser.setAccess(34, false)', reloaded);
    delete stored["tab:34"]; startup(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(Array.from(await reloaded.listEnabledTabs(), tab => tab.id), [34, 56]);
});
