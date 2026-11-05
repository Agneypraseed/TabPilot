import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../sidepanel.html", import.meta.url), "utf8");
const source = (await readFile(new URL("../tab-access.js", import.meta.url), "utf8")) + "\n" + await readFile(new URL("../sidepanel.js", import.meta.url), "utf8");
const tasksSource = await readFile(new URL("../task-view.js", import.meta.url), "utf8");
const markdownSource = (await Promise.all(["vendor/marked.js", "vendor/purify.js", "markdown.js"].map(path => readFile(new URL(`../${path}`, import.meta.url), "utf8")))).join("\n");
const flush = () => new Promise(resolve => setImmediate(resolve));
test("Tasks keeps workers with their parent tab, safely renders prompts, and submits schedule controls", async () => {
    const ui = await panel(), $ = id => ui.document.getElementById(id);
    Object.assign(ui.agent, { jobs: [
        { id: "root", tabId: 12, prompt: "Research <img src=x>", status: "running", createdAt: 2, maxStages: 20, stage: 1 },
        { id: "child", parentTaskId: "root", tabId: 34, prompt: "Read specialist source", status: "needs-input", createdAt: 3, maxStages: 10, stage: 1 },
        { id: "other", tabId: 34, prompt: "Other private task", status: "queued", createdAt: 1 }
    ], status: "running", tabId: 12, selectedTabId: 12 });
    ui.receive(ui.agent);
    await ui.dispatch("tasks-tab");
    assert.equal($("tasks-view").hidden, false);
    assert.match($("tasks-list").textContent, /Research <img src=x>/);
    assert.match($("tasks-list").textContent, /Read specialist source/);
    assert.doesNotMatch($("tasks-list").textContent, /Other private task/);
    assert.equal($("tasks-list").querySelector("img"), null);
    assert.equal($("target-tab").disabled, false);
    $("schedule-prompt").value = "Read later";
    $("schedule-at").value = "";
    $("schedule-stages").value = "5";
    $("schedule-repeat").value = "1800000";
    $("schedule-research").checked = false;
    await ui.dispatch("schedule-form", "submit");
    const payload = ui.calls.find(call => call.method === "task-create").payload;
    assert.equal(payload.tabId, 12);
    assert.equal(payload.repeatEveryMs, 1800000);
    assert.equal(payload.maxStages, 5);
    assert.equal(payload.allowResearch, false);
    assert.equal($("schedule-prompt").value, "");
});
async function panel({ initialActiveTab = 12, incognito = false, extraTabs = [], search = "", formatted = false, executionMode = "extension", configuredFields = [], savedValues = {}, rememberCredentials = false } = {}) {
    const window = formatted ? new JSDOM(html).window : parseHTML(html).window;
    const document = window.document;
    // linkedom implements selected options but not HTMLSelectElement.value's setter.
    for (const select of document.querySelectorAll("select")) Object.defineProperty(select, "value", {
        get() { return this.querySelector("option[selected]")?.value ?? this.firstElementChild?.value ?? ""; },
        set(value) { for (const option of this.querySelectorAll("option")) option.toggleAttribute("selected", option.value === String(value)); }
    });
    let runtimeListener;
    const runtime = { executionMode, configuredFields: [...configuredFields], rememberCredentials, savedValues, compatibleBaseUrl: "" };
    const activationListeners = [];
    const stored = {}, calls = [], queries = [];
    const agent = { revision: 1, status: "idle", runId: "run-1", events: [], historyAvailable: true, historyRevision: 0, settings: { provider: "meta", model: "fixture", maxTurns: 30, timeoutMs: 300000 }, providers: [{ id: "meta", configured: true }] };
    const event = { addListener() {} };
    const chrome = {
        permissions: { request: async options => { calls.push({ permissionRequest: options }); return true; } },
        tabs: { query: async query => { queries.push(query); const available = [{ id: 12, windowId: 7, incognito, active: true, title: "Test <b>tab</b>", url: "https://example.com/" }, { id: 34, windowId: 8, title: "Other tab", url: "https://other.example/" }, ...extraTabs]; return query.active ? available.filter(tab => tab.id === initialActiveTab && (!query.windowId || tab.windowId === query.windowId)) : available; }, create: async args => calls.push({ createdTab: args }), onActivated: { addListener(fn) { activationListeners.push(fn); } }, onUpdated: event, onRemoved: event },
        windows: { getCurrent: async () => ({ id: 7, incognito }), get: async id => ({ id, incognito }) },
        storage: { session: { get: async () => stored }, onChanged: event },
        runtime: { getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener(fn) { runtimeListener = fn; } }, sendMessage: async message => {
            calls.push(message);
            if (message.type === "tabpilot:ui-state") return { connected: runtime.executionMode === "extension" || executionMode === "bridge", executionMode: runtime.executionMode, runtime, agent: runtime.executionMode === "extension" || executionMode === "bridge" ? agent : null };
            if (message.type === "tabpilot:access") { if (message.enabled) delete stored[`tab:${message.tabId}`]; else stored[`tab:${message.tabId}`] = false; return { ok: true, enabled: message.enabled }; }
            if (message.type === "tabpilot:agent") {
                if (message.method === "runtime-settings") return { ok: true, runtime };
                if (message.method === "runtime-configure") {
                    Object.assign(runtime, { executionMode: message.payload.executionMode || runtime.executionMode });
                    for (const name of Object.keys(message.payload.credentials || {})) if (!runtime.configuredFields.includes(name)) runtime.configuredFields.push(name);
                    runtime.configuredFields = runtime.configuredFields.filter(name => !(message.payload.clearCredentials || []).includes(name));
                    if (typeof message.payload.rememberCredentials === "boolean") runtime.rememberCredentials = message.payload.rememberCredentials;
                    return { ok: true, runtime };
                }
                if (message.method === "history-list") return { ok: true, history: { runs: message.payload.tabId === 12 ? [{ runId: "history-1", task: "Find <img src=x>", source: "workspace", model: "fixture", status: "completed", startedAt: 1 }] : [], nextOffset: null } };
                if (message.method === "history-events") return { ok: true, history: { events: [{ kind: "assistant", text: "Found the page", time: 1 }, { kind: "tool", tool: "click", phase: "complete", time: 1, result: { clicked: true } }], nextOffset: null } };
                if (message.method === "start") Object.assign(agent, { status: "running", tabId: 12, mode: message.payload.mode, revision: 2, events: [{ id: "message-1", kind: "user", text: message.payload.prompt }] });
                return { ok: true, state: agent };
            }
            return { ok: true };
        } }
    };
    vm.runInNewContext((formatted ? markdownSource : "") + "\n" + tasksSource + "\n" + source, { chrome, document, window, URL, URLSearchParams, location: { search }, setInterval: () => 1, clearInterval, Date });
    await flush();
    const dispatch = async (id, type = "click") => { document.getElementById(id).dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true })); await flush(); };
    return { document, calls, queries, dispatch, agent, chrome, activate: info => activationListeners.forEach(listener => listener(info)), receive: state => runtimeListener({ type: "tabpilot:agent-event", state }) };
}

test("unified agent supports revocation, submits tasks and renders untrusted text safely", async () => {
    const ui = await panel();
    const $ = id => ui.document.getElementById(id);
    assert.equal($("send").disabled, false);
    await ui.dispatch("access-toggle");
    assert.equal($("send").disabled, true);
    await ui.dispatch("access-toggle");
    assert.equal($("send").disabled, false);
    assert.equal($("mode-switch"), null);
    assert.equal(ui.document.querySelector(".advanced-settings").hasAttribute("open"), false);
    $("task").value = "Search <img src=x onerror=alert(1)>";
    await ui.dispatch("task-form", "submit");
    assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(c => c.method === "start").payload)), { prompt: "Search <img src=x onerror=alert(1)>", tabId: 12, mode: "browser", tabTitle: "Test <b>tab</b>" });
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
    assert.equal(ui.document.getElementById("layout-menu").hidden, false);
    assert.equal(ui.calls.some(c => c.createdTab), false, "choosing layout must not silently open a new tab");
    await ui.dispatch("open-window");
    const created = ui.calls.find(c => c.createdTab).createdTab;
    assert.equal(created.url, "chrome-extension://test/sidepanel.html?window=7&tab=12&layout=tab");
    assert.equal(created.active, true);
});

test("native side panel uses the target window and unsupported hosts get a clear explanation", async () => {
    const ui = await panel();
    let opened;
    ui.chrome.sidePanel = { open: async options => { opened = options; } };
    await ui.dispatch("open-side-panel");
    assert.equal(opened.windowId, 7);
    delete ui.chrome.sidePanel;
    await ui.dispatch("open-side-panel-top");
    assert.match(ui.document.getElementById("notice").textContent, /desktop Chrome/);
});

test("a restarted bridge replaces old high-revision state instead of appearing permanently stuck", async () => {
    const ui = await panel();
    ui.receive({ ...ui.agent, sessionId: "old-runtime", revision: 80, status: "running", mode: "computer", tabId: 12 });
    assert.equal(ui.document.getElementById("run-controls").hidden, false);
    ui.receive({ ...ui.agent, sessionId: "new-runtime", revision: 0, status: "idle", events: [] });
    assert.equal(ui.document.getElementById("run-controls").hidden, true);
    ui.receive({ ...ui.agent, sessionId: "new-runtime", revision: -1, status: "running", mode: "computer", tabId: 12 });
    assert.equal(ui.document.getElementById("run-controls").hidden, true, "out-of-order messages from the same runtime are ignored");
});

test("History loads only the selected tab, displays trace details safely, and stays separate from Agent", async () => {
    const ui = await panel(), $ = id => ui.document.getElementById(id);
    await ui.dispatch("history-tab");
    assert.equal($("conversation").hidden, true);
    assert.equal($("history-view").hidden, false);
    assert.equal(ui.calls.find(c => c.method === "history-list").payload.tabId, 12);
    assert.equal($("history-content").querySelector("img"), null);
    assert.match($("history-content").textContent, /Find <img/);
    $("history-content").querySelector("button").click();
    await flush();
    assert.match($("history-content").textContent, /Found the page/);
    assert.match($("history-content").textContent, /clicked/);
    $("target-tab").value = "34";
    await ui.dispatch("target-tab", "change");
    assert.equal($("history-content").textContent, "");
    assert.match($("history-status").textContent, /No activity/);
    await ui.dispatch("agent-tab");
    assert.equal($("history-view").hidden, true);
    assert.equal($("conversation").hidden, false);
});

test("late history replies cannot show a previous tab's records after switching tabs", async () => {
    const ui = await panel(), $ = id => ui.document.getElementById(id);
    const send = ui.chrome.runtime.sendMessage;
    let release;
    ui.chrome.runtime.sendMessage = message => message.method === "history-list" && message.payload.tabId === 12
        ? new Promise(resolve => { release = resolve; }) : send(message);
    await ui.dispatch("history-tab");
    $("target-tab").value = "34";
    await ui.dispatch("target-tab", "change");
    release({ ok: true, history: { runs: [{ runId: "old", task: "Other tab secret", startedAt: 1 }], nextOffset: null } });
    await flush(); await flush();
    assert.equal($("history-content").textContent, "");
    assert.equal($("history-tab-label").textContent, "Other tab");
});

test("attention card keeps a draft reply across updates and resumes only through its matching request", async () => {
    const ui = await panel(), $ = id => ui.document.getElementById(id);
    const waiting = { ...ui.agent, revision: 2, status: "needs-input", tabId: 12, mode: "browser", requests: [{ id: "request-one", runId: "run-1", kind: "information", question: "Which topic? <img src=x>", detail: "A choice is needed" }] };
    ui.receive(waiting);
    assert.equal($("send").disabled, true);
    const input = $("attention-requests").querySelector("textarea"); input.value = "Space exhibit";
    ui.receive({ ...waiting, revision: 3 });
    assert.equal($("attention-requests").querySelector("textarea").value, "Space exhibit");
    assert.equal($("attention-requests").querySelector("img"), null);
    const send = ui.chrome.runtime.sendMessage;
    let response;
    ui.chrome.runtime.sendMessage = async message => {
        if (message.method === "human-response") {
            response = message.payload;
            return { ok: true, state: { ...waiting, revision: 4, status: "running", requests: [] } };
        }
        return send(message);
    };
    $("attention-requests").querySelector("button").click(); await flush();
    assert.equal(response.id, "request-one");
    assert.equal(response.runId, "run-1");
    assert.equal(response.decision, "answer");
    assert.equal(response.text, "Space exhibit");
    assert.equal($("attention-requests").hidden, true);
});

test("Settings lists all windows and revokes a specific tab without changing the selected tab", async () => {
    const ui = await panel();
    const $ = id => ui.document.getElementById(id);
    assert.ok(ui.queries.some(query => Object.keys(query).length === 0));
    await ui.dispatch("settings-button");
    const list = $("settings-tab-list");
    assert.equal(list.querySelectorAll(".tab-access-row").length, 2);
    assert.equal(list.querySelector("b"), null, "Tab titles are plain text");
    const other = [...list.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Revoke access: Other tab");
    other.click(); await flush(); await flush();
    assert.equal($("target-tab").value, "12");
    assert.equal($("access-toggle").getAttribute("aria-checked"), "true");
    assert.ok([...list.querySelectorAll("button")].some(button => button.getAttribute("aria-label") === "Restore access: Other tab"));
    const restore = [...list.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Restore access: Other tab");
    restore.click(); await flush(); await flush();
    assert.ok([...list.querySelectorAll("button")].some(button => button.getAttribute("aria-label") === "Revoke access: Other tab"));
});

test("all-window chooser starts on the UI window's active tab", async () => {
    const ui = await panel();
    assert.equal(ui.document.getElementById("target-tab").value, "12");
    assert.equal(ui.document.getElementById("target-tab").querySelectorAll("option").length, 2);
    assert.ok(ui.queries.some(query => query.active && query.windowId === 7));
});

test("tab activations in a different window do not change this workspace's selected tab", async () => {
    const ui = await panel();
    ui.activate({ tabId: 34, windowId: 8 });
    await flush(); await flush();
    assert.equal(ui.document.getElementById("target-tab").value, "12");
});

test("live and History agent replies render Markdown while user messages remain literal", async () => {
    const ui = await panel({ formatted: true }), $ = id => ui.document.getElementById(id);
    ui.receive({ ...ui.agent, revision: 2, events: [
        { kind: "user", text: "**literal** <img src=x>" },
        { kind: "assistant", text: "## Results\n\n- **Liverpool** 3–2\n- [Source](https://example.com/)" },
    ] });
    assert.equal($("messages").querySelector(".assistant strong").textContent, "Liverpool");
    assert.equal($("messages").querySelectorAll(".assistant li").length, 2);
    assert.match($("messages").querySelector(".user").textContent, /\*\*literal\*\*/);
    assert.equal($("messages").querySelector("img"), null);
    const send = ui.chrome.runtime.sendMessage;
    ui.chrome.runtime.sendMessage = message => message.method === "history-events"
        ? Promise.resolve({ ok: true, history: { events: [{ kind: "assistant", text: "**Saved result**", time: 1 }], nextOffset: null } }) : send(message);
    await ui.dispatch("history-tab");
    $("history-content").querySelector("button").click(); await flush(); await flush();
    assert.equal($("history-content").querySelector(".formatted-reply strong").textContent, "Saved result");
});

test("incognito chooser and Settings show existing and new tabs only from their source window", async () => {
    const extraTabs = [
        { id: 56, windowId: 7, incognito: true, title: "Private source", url: "https://private.example/" },
        { id: 78, windowId: 9, incognito: true, title: "Other private window", url: "https://elsewhere.example/" },
    ];
    const ui = await panel({ incognito: true, extraTabs, search: "?window=7&tab=12" });
    const $ = id => ui.document.getElementById(id);
    const ids = () => [...$("target-tab").querySelectorAll("option")].map(option => option.value);
    assert.deepEqual(ids(), ["12", "56"]);
    await ui.dispatch("settings-button");
    assert.equal($("settings-tab-list").querySelectorAll(".tab-access-row").length, 2);
    assert.doesNotMatch($("settings-tab-list").textContent, /Other tab|Other private window/);
    assert.match($("tab-access-help").textContent, /this incognito window/);
    extraTabs.push({ id: 90, windowId: 7, incognito: true, title: "New private tab", url: "https://new.example/" });
    await ui.dispatch("refresh-tabs");
    assert.deepEqual(ids(), ["12", "56", "90"]);
});

test("opening an incognito workspace preserves its window context in both layouts", async () => {
    const ui = await panel({ incognito: true });
    let createdWindow;
    ui.chrome.windows.create = async options => { createdWindow = options; };
    await ui.dispatch("open-window");
    assert.equal(createdWindow.incognito, true);
    assert.match(createdWindow.url, /window=7&tab=12/);
    ui.chrome.windows.create = async () => { throw new Error("Unsupported"); };
    await ui.dispatch("open-window");
    assert.equal(ui.calls.find(call => call.createdTab).createdTab.windowId, 7);
});


test("extension defaults expose local credential entry and keep server pairing in closed Developer settings", async () => {
    const ui = await panel({ configuredFields: ["META_API_KEY", "TELEGRAM_BOT_TOKEN", "TABPILOT_TELEGRAM_CHAT_ID"] });
    const $ = id => ui.document.getElementById(id);
    await ui.dispatch("settings-button");
    assert.equal($("connection-label").textContent, "In browser");
    assert.equal($("developer-settings").hasAttribute("open"), false);
    assert.equal($("pair-form").closest("details").id, "developer-settings");
    assert.equal($("developer-bridge").hidden, true);
    assert.equal($("extension-credentials").hidden, false);
    assert.equal($("provider-key").value, "");
    assert.match($("provider-key").placeholder, /Key saved/);
    assert.match($("telegram-status").textContent, /settings saved/);
    assert.equal($("telegram-token").value, "");
    assert.equal($("telegram-chat").value, "");
    assert.match($("settings-view").textContent, /No terminal, pairing token, or local server is required/);
});

test("credential save precedes model settings, preserves blank entries and clears the form", async () => {
    const ui = await panel(), $ = id => ui.document.getElementById(id);
    await ui.dispatch("settings-button");
    $("provider-key").value = "new-provider-fixture";
    $("telegram-token").value = "bot-fixture";
    $("telegram-chat").value = "1234";
    $("clear-email").checked = true;
    $("remember-credentials").checked = true;
    await ui.dispatch("settings-form", "input");
    await ui.dispatch("settings-form", "submit");
    const configuration = ui.calls.find(call => call.method === "runtime-configure");
    assert.deepEqual(JSON.parse(JSON.stringify(configuration.payload)), {
        credentials: { META_API_KEY: "new-provider-fixture", TELEGRAM_BOT_TOKEN: "bot-fixture", TABPILOT_TELEGRAM_CHAT_ID: "1234" },
        clearCredentials: ["RESEND_API_KEY", "TABPILOT_EMAIL_FROM", "TABPILOT_EMAIL_TO"], rememberCredentials: true
    });
    assert.ok(ui.calls.indexOf(configuration) < ui.calls.findIndex(call => call.method === "settings"));
    assert.equal($("provider-key").value, "");
    assert.equal($("telegram-token").value, "");
    assert.equal($("telegram-chat").value, "");
    assert.equal($("clear-email").checked, false);
    assert.doesNotMatch($("settings-view").textContent, /new-provider-fixture|bot-fixture/);
    await ui.dispatch("settings-form", "submit");
    assert.equal(Object.keys(ui.calls.filter(call => call.method === "runtime-configure").at(-1).payload.credentials).length, 0);
});

test("switching to developer mode reveals pairing and hides extension credential fields", async () => {
    const ui = await panel(), $ = id => ui.document.getElementById(id);
    await ui.dispatch("settings-button");
    $("execution-mode").value = "bridge";
    await ui.dispatch("execution-mode", "change");
    await ui.dispatch("apply-execution-mode");
    assert.equal(ui.calls.find(call => call.method === "runtime-configure").payload.executionMode, "bridge");
    assert.equal($("developer-bridge").hidden, false);
    assert.equal($("pair-form").hidden, false);
    assert.equal($("extension-credentials").hidden, true);
    assert.equal($("notification-settings").hidden, true);
    assert.equal($("send").disabled, true);
    assert.match($("settings-connection").textContent, /Start your local server/);
});

test("provider changes discard an unsaved key so it cannot be sent to another provider", async () => {
    const ui = await panel(), $ = id => ui.document.getElementById(id);
    await ui.dispatch("settings-button");
    $("provider-key").value = "meta-only-fixture";
    $("provider").value = "openai-compatible";
    await ui.dispatch("provider", "change");
    assert.equal($("provider-key").value, "");
    assert.equal($("compatible-endpoint").hidden, false);
    $("compatible-base-url").value = "https://provider.example/v1";
    await ui.dispatch("settings-form", "submit");
    const saved = ui.calls.find(call => call.method === "runtime-configure").payload.credentials;
    assert.equal(saved.COMPATIBLE_BASE_URL, "https://provider.example/v1");
    assert.equal(saved.META_API_KEY, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => call.permissionRequest).permissionRequest)), { origins: ["https://provider.example/*"] });
});


test("a denied compatible-host permission prevents saving credentials or model settings", async () => {
    const ui = await panel(), $ = id => ui.document.getElementById(id);
    ui.chrome.permissions.request = async () => false;
    await ui.dispatch("settings-button");
    $("provider").value = "openai-compatible";
    await ui.dispatch("provider", "change");
    $("model").value = "custom-model";
    $("compatible-base-url").value = "https://provider.example/v1";
    $("provider-key").value = "fixture";
    await ui.dispatch("settings-form", "submit");
    assert.equal(ui.calls.some(call => call.method === "runtime-configure" || call.method === "settings"), false);
    assert.match($("notice").textContent, /Allow access/);
});


test("saved credentials are visibly summarized and Change edits without revealing the saved key", async () => {
    const ui = await panel({ configuredFields: ["META_API_KEY", "TELEGRAM_BOT_TOKEN", "TABPILOT_TELEGRAM_CHAT_ID", "TABPILOT_EMAIL_TO"], savedValues: { TABPILOT_TELEGRAM_CHAT_ID: "12345", TABPILOT_EMAIL_TO: "alerts@example.com" } });
    const $ = id => ui.document.getElementById(id);
    await ui.dispatch("settings-button");
    assert.equal($("provider-key").hidden, true);
    assert.equal($("provider-key-saved").hidden, false);
    assert.match($("provider-key-saved-value").textContent, /Saved/);
    assert.equal($("telegram-token").hidden, true);
    assert.equal($("telegram-chat-saved-value").textContent, "12345");
    assert.equal($("email-to-saved-value").textContent, "alerts@example.com");
    assert.match($("settings-storage-scope").textContent, /New chats and switching tabs keep/);
    await ui.dispatch("provider-key-change");
    assert.equal($("provider-key").hidden, false);
    assert.equal($("provider-key").value, "");
    assert.equal($("provider-key-saved").hidden, true);
    $("provider-key").value = "replacement-test-key";
    await ui.dispatch("settings-form", "submit");
    assert.equal($("provider-key").value, "");
    assert.equal($("provider-key").hidden, true);
    assert.match($("notice").textContent, /all tabs and conversations/);
    assert.equal($("settings-view").textContent.includes("replacement-test-key"), false);
});

test("saved settings remain visible after new chat and tab changes and show their storage duration", async () => {
    const ui = await panel({ configuredFields: ["META_API_KEY", "TELEGRAM_BOT_TOKEN", "TABPILOT_TELEGRAM_CHAT_ID"], savedValues: { TABPILOT_TELEGRAM_CHAT_ID: "12345" }, rememberCredentials: true });
    const $ = id => ui.document.getElementById(id);
    await ui.dispatch("new-chat");
    await ui.activate({ tabId: 34, windowId: 7 });
    await ui.dispatch("settings-button");
    assert.equal($("provider-key-saved").hidden, false);
    assert.equal($("telegram-chat-saved-value").textContent, "12345");
    assert.match($("settings-storage-scope").textContent, /Saved on this device/);
    assert.equal(ui.calls.some(call => call.method === "runtime-configure"), false);
});


test("question cards show Telegram delivery updates without replacing a draft reply", async () => {
 const ui=await panel();const $=id=>ui.document.getElementById(id);
 const waiting={...ui.agent,revision:2,status:"needs-input",requests:[{id:"telegram-request",runId:"run-1",tabId:12,kind:"information",question:"Which title?"}],notificationDeliveries:[{requestId:"telegram-request",results:[{channel:"telegram",status:"sending"}]}]};
 ui.receive(waiting);assert.match($("attention-requests").textContent,/Telegram: sending alert/);
 $("attention-requests").querySelector("textarea").value="My pending reply";
 ui.receive({...waiting,revision:3,notificationDeliveries:[{requestId:"telegram-request",results:[{channel:"telegram",accepted:false,error:"Provider rejected the notification (HTTP 403)."}]}]});
 assert.match($("attention-requests").textContent,/Telegram alert failed.*HTTP 403/);
 assert.equal($("attention-requests").querySelector("textarea").value,"My pending reply");
 ui.receive({...waiting,revision:4,notificationDeliveries:[{requestId:"telegram-request",results:[{channel:"telegram",accepted:true}]}]});
 assert.match($("attention-requests").textContent,/Telegram accepted the alert/);
});

test("Telegram test button sends only an explicit saved-channel test and reports acceptance", async () => {
 const ui=await panel();const send=ui.chrome.runtime.sendMessage;
 ui.chrome.runtime.sendMessage=async message=>message.method==="notification-test"?{ok:true,notification:{accepted:true,results:[{channel:"telegram",accepted:true}]}}:send(message);
 await ui.dispatch("settings-button");await ui.dispatch("test-telegram");
 assert.match(ui.document.getElementById("notice").textContent,/Telegram accepted the test alert/);
});
