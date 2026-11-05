import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { backgroundSource, mockDebugger } from "./background-source.mjs";
const popupSource = (await readFile(new URL("../tab-access.js", import.meta.url), "utf8")) + "\n" + await readFile(new URL("../popup.js", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function background({ url = "https://example.com/", revokeDuringRead = false, sidePanel } = {}) {
    const stored = { "tab:12": true };
    let listener;
    let executions = 0;
    const chrome = {
        runtime: { id: "test", onMessage: { addListener(fn) { listener = fn; } } },
        tabs: { onRemoved: { addListener() {} }, get: async () => ({ url }) },
        storage: { session: { get: async key => ({ [key]: stored[key] }), remove: async () => {} } },
        scripting: { executeScript: async () => {
            executions++;
            if (revokeDuringRead) stored["tab:12"] = false;
            return [{ result: { text: "Example" } }];
        } }
    };
    if (sidePanel !== undefined) chrome.sidePanel = sidePanel;
    mockDebugger(chrome, async () => (await chrome.scripting.executeScript())[0].result);
    vm.runInNewContext(backgroundSource, { chrome, URL });
    return {
        get executions() { return executions; },
        request(tabId = 12, sender = { id: "test" }) {
            return new Promise(resolve => listener({ type: "tabpilot:snapshot", tabId }, sender, resolve));
        }
    };
}

test("background tolerates a sidePanel namespace without setPanelBehavior", () => {
    assert.doesNotThrow(() => background({ sidePanel: {} }));
});

test("background rejects content-script and foreign-extension requests", async () => {
    const worker = background();
    assert.equal((await worker.request(12, { id: "test", tab: { id: 12 } })).ok, false);
    assert.equal((await worker.request(12, { id: "another-extension" })).ok, false);
    assert.equal(worker.executions, 0);
});

test("a trusted extension workspace tab can use the same API as the popup", async () => {
    const worker = background();
    const response = await worker.request(12, { id: "test", tab: { id: 50 }, url: "chrome-extension://test/sidepanel.html" });
    assert.equal(response.ok, true);
    assert.equal(worker.executions, 1);
    const rejected = await worker.request(12, { id: "test", tab: { id: 12 }, url: "https://example.com/sidepanel.html" });
    assert.equal(rejected.ok, false);
    assert.equal(worker.executions, 1);
});

test("history namespace survives extension reload and changes on browser startup", async () => {
    const local = {};
    let startup;
    const chrome = {
        runtime: { id: "test", onMessage: { addListener() {} }, onStartup: { addListener(fn) { startup = fn; } } },
        tabs: { onRemoved: { addListener() {} } },
        storage: { local: { get: async () => ({ ...local }), set: async value => Object.assign(local, value) } }
    };
    mockDebugger(chrome, async () => ({}));
    function worker() { const context = vm.createContext({ chrome, URL, crypto: globalThis.crypto }); vm.runInContext(backgroundSource, context); return context; }
    const original = await worker().historyScope();
    const reloaded = worker();
    assert.equal(await reloaded.historyScope(), original);
    startup();
    const fresh = await reloaded.historyScope();
    assert.notEqual(fresh, original);
    assert.equal(await worker().historyScope(), fresh);
});

test("invalid tab IDs and protected pages never execute a reader", async () => {
    const worker = background({ url: "chrome://extensions/" });
    for (const id of [undefined, "12", -1, 1.5]) {
        assert.match((await worker.request(id === undefined ? null : id)).error, /Invalid tab ID/);
    }
    assert.match((await worker.request()).error, /HTTP or HTTPS/);
    assert.equal(worker.executions, 0);
});

test("access revoked during reading prevents returning page content", async () => {
    const worker = background({ revokeDuringRead: true });
    const result = await worker.request();
    assert.equal(result.ok, false);
    assert.match(result.error, /Access disabled/);
    assert.equal(result.snapshot, undefined);
    assert.equal(worker.executions, 1);
});

async function popup(stored, tabId, failSave = false) {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { disabled: true, textContent: "", value: "",
            listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } });
        return elements.get(id);
    };
    const messages = [];
    const chrome = {
        tabs: { query: async () => [{ id: tabId, url: "https://example.com/" }] },
        storage: { session: {
            get: async key => ({ [key]: stored[key] }),
            set: async value => {
                if (failSave) throw new Error("Storage unavailable");
                Object.assign(stored, value);
            }
        } },
        runtime: { sendMessage: async message => {
            messages.push(message);
            if (message.type === "tabpilot:access") {
                if (failSave) throw new Error("Storage unavailable");
                if (message.enabled) delete stored[`tab:${message.tabId}`];
                else stored[`tab:${message.tabId}`] = false;
                return { ok: true, enabled: message.enabled };
            }
            return message.type === "tabpilot:bridge-status" ? { connected: false }
                : { ok: true, snapshot: { title: "Example", text: "<b>page text</b>" } };
        } }
    };
    vm.runInNewContext(popupSource, { chrome, URL, document: { getElementById: element } });
    await flush();
    return { element, messages, click: id => element(id).listeners.click() };
}

test("popup defaults to access and preserves per-tab revocation after reopening", async () => {
    const stored = {};
    const first = await popup(stored, 12);
    assert.equal(first.element("access-status").textContent, "Access enabled");
    await first.click("toggle-access");
    assert.equal(stored["tab:12"], false);
    const reopened = await popup(stored, 12);
    assert.equal(reopened.element("access-status").textContent, "Access disabled");
    const otherTab = await popup(stored, 34);
    assert.equal(otherTab.element("access-status").textContent, "Access enabled");
    await reopened.click("toggle-access");
    assert.equal(stored["tab:12"], undefined);
});

test("popup requests the current tab and displays returned data as text", async () => {
    const ui = await popup({}, 12);
    await ui.click("read-page");
    const request = ui.messages.find(message => message.type === "tabpilot:snapshot");
    assert.equal(request.tabId, 12);
    const output = JSON.parse(ui.element("snapshot-output").textContent);
    assert.equal(output.text, "<b>page text</b>");
    assert.equal(ui.element("read-page").disabled, false);
});

test("failed storage writes preserve displayed state and allow retry", async () => {
    const ui = await popup({}, 12, true);
    await ui.click("toggle-access");
    assert.equal(ui.element("access-status").textContent, "Access enabled");
    assert.equal(ui.element("snapshot-output").textContent, "Storage unavailable");
    assert.equal(ui.element("toggle-access").disabled, false);
});
