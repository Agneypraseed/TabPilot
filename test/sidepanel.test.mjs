import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const html = await readFile(new URL("../sidepanel.html", import.meta.url), "utf8");
const source = await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
async function panel() {
    const { window, document } = parseHTML(html);
    // linkedom implements selected options but not HTMLSelectElement.value's setter.
    for (const select of document.querySelectorAll("select")) Object.defineProperty(select, "value", {
        get() { return this.querySelector("option[selected]")?.value ?? this.firstElementChild?.value ?? ""; },
        set(value) { for (const option of this.querySelectorAll("option")) option.toggleAttribute("selected", option.value === String(value)); }
    });
    let runtimeListener;
    const stored = {}, calls = [];
    const agent = { revision: 1, status: "idle", runId: "run-1", events: [], settings: { provider: "meta", model: "fixture", maxTurns: 30, timeoutMs: 300000 }, providers: [{ id: "meta", configured: true }] };
    const event = { addListener() {} };
    const chrome = {
        tabs: { query: async () => [{ id: 12, windowId: 7, active: true, title: "Test <b>tab</b>", url: "https://example.com/" }], create: async args => calls.push({ createdTab: args }), onActivated: event, onUpdated: event, onRemoved: event },
        storage: { session: { get: async () => stored }, onChanged: event },
        runtime: { getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener(fn) { runtimeListener = fn; } }, sendMessage: async message => {
            calls.push(message);
            if (message.type === "tabpilot:ui-state") return { connected: true, agent };
            if (message.type === "tabpilot:access") { stored[`tab:${message.tabId}`] = message.enabled; return { ok: true, enabled: message.enabled }; }
            if (message.type === "tabpilot:agent") {
                if (message.method === "start") Object.assign(agent, { status: "running", tabId: 12, mode: message.payload.mode, revision: 2, events: [{ id: "message-1", kind: "user", text: message.payload.prompt }] });
                return { ok: true, state: agent };
            }
            return { ok: true };
        } }
    };
    vm.runInNewContext(source, { chrome, document, window, URL, URLSearchParams, setInterval: () => 1, clearInterval, Date });
    await flush();
    const dispatch = async (id, type = "click") => { document.getElementById(id).dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true })); await flush(); };
    return { document, calls, dispatch, agent, receive: state => runtimeListener({ type: "tabpilot:agent-event", state }) };
}

test("side panel enables selected tab, submits task with mode and renders untrusted text safely", async () => {
    const ui = await panel();
    const $ = id => ui.document.getElementById(id);
    assert.equal($("send").disabled, true);
    await ui.dispatch("access-toggle");
    assert.equal($("send").disabled, false);
    await ui.dispatch("mode-computer");
    $("task").value = "Search <img src=x onerror=alert(1)>";
    await ui.dispatch("task-form", "submit");
    assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(c => c.method === "start").payload)), { prompt: "Search <img src=x onerror=alert(1)>", tabId: 12, mode: "computer" });
    assert.equal($("messages").querySelector("img"), null);
    assert.match($("messages").textContent, /<img/);
    assert.equal($("target-tab").disabled, true);
    assert.equal($("run-controls").hidden, false);
    $("task").value = "Use another query";
    await ui.dispatch("task-form", "submit");
    assert.equal(ui.calls.at(-1).method, "steer");
    assert.equal(ui.calls.at(-1).payload.runId, "run-1");
});

test("panel settings and pause/stop controls route to agent service; reconnect state restores run", async () => {
    const ui = await panel();
    const $ = id => ui.document.getElementById(id);
    await ui.dispatch("settings-button");
    assert.equal($("settings-view").hidden, false);
    assert.equal($("model").value, "fixture");
    await ui.dispatch("settings-form", "submit");
    assert.equal(ui.calls.at(-1).method, "settings");
    ui.receive({ ...ui.agent, revision: 10, status: "paused", mode: "computer", tabId: 12 });
    await ui.dispatch("pause");
    assert.equal(ui.calls.at(-1).method, "resume");
    await ui.dispatch("stop");
    assert.equal(ui.calls.at(-1).method, "stop");
    assert.equal(ui.calls.at(-1).payload.runId, "run-1");
});

test("workspace falls back to an extension tab when the browser cannot create windows", async () => {
    const ui = await panel();
    await ui.dispatch("open-workspace");
    const created = ui.calls.find(c => c.createdTab).createdTab;
    assert.equal(created.url, "chrome-extension://test/sidepanel.html?window=7&tab=12");
    assert.equal(created.active, true);
});
