import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { browserApprovalPolicy } from "../agent-interactions.mjs";
import { observedBrowserServer } from "../agent-browser-session.mjs";
import { createExtensionBrowserTools } from "../extension-browser-tools.mjs";

const load = name => readFile(new URL("../" + name, import.meta.url), "utf8");
const [accessSource, browserSource, pageSource] = await Promise.all([
    load("tab-access.js"), load("browser-controller.js"), load("page-runtime.js")
]);
const Browser = vm.runInNewContext(accessSource + "\n" + browserSource + "\nTabPilotBrowser", {
    URL, crypto: globalThis.crypto, setTimeout, clearTimeout
});

function setup(t, html, { url = "https://fixture.test/form" } = {}) {
    const { window } = new JSDOM(html, { url, runScripts: "outside-only" });
    t.after(() => window.close());
    const { document } = window;
    Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
    window.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 120, height: 30 });
    window.Element.prototype.scrollIntoView = () => {};
    window.matchMedia = () => ({ matches: true });
    document.elementFromPoint = () => document.querySelector("button");
    const browserEvents = {};
    const inputEvents = [];
    let onMove;
    const chrome = {
        storage: { session: { get: async () => ({}) } },
        tabs: { get: async id => ({ id, url: window.location.href, title: document.title, windowId: 1 }) },
        debugger: {
            onDetach: { addListener() {} },
            onEvent: { addListener(handler) { browserEvents.emit = handler; } },
            attach: async () => {},
            sendCommand: async (_target, method, params) => {
                if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "test" } } };
                if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
                if (method === "Runtime.evaluate") return { result: { value: window.eval(params.expression) } };
                if (method.startsWith("Input.") || method === "Page.handleJavaScriptDialog") inputEvents.push({ method, ...params });
                if (params.type === "mouseMoved") onMove?.();
                return {};
            }
        }
    };
    const browser = new Browser(chrome, window.eval(pageSource + "\ntabPilotPage"));
    const server = createExtensionBrowserTools({
        request(method, tabId, params, { approval } = {}) {
            if (method === "snapshot") return browser.snapshot(tabId);
            if (method === "approval-context") return browser.approvalContext(tabId, params);
            return browser.action(tabId, method, params, approval);
        }
    });
    const observed = requestHuman => observedBrowserServer(server, {
        targetTabId: 12,
        ...browserApprovalPolicy({ requestHuman, inspectApproval: server.inspectApproval })
    });
    return { browser, browserEvents, document, inputEvents, observed, setOnMove: callback => { onMove = callback; } };
}

test("changed recipient and amount cannot use stale approval and each fresh approval is single-use", async t => {
    const fixture = setup(t, '<title>Compose</title><form><input id="to" aria-label="Recipient" value="first@example.test"><input id="subject" aria-label="Subject" value="Local fixture"><input id="body" aria-label="Message" value="Private fixture body"><input id="total" aria-label="Payment amount" value="$10"><button type="submit">Send message</button></form>');
    const requests = [];
    const server = fixture.observed(async request => {
        requests.push(request);
        if (requests.length === 1) fixture.document.querySelector("#to").value = "second@example.test";
        return { decision: "approve" };
    });
    const click = async () => {
        const snapshot = await server.callToolResult("browser_snapshot", { tabId: 12 });
        return server.callToolResult("browser_click", {
            tabId: 12, ref: snapshot.structuredContent.elements.find(item => item.name === "Send message").ref
        });
    };
    const changedRecipient = await click();
    assert.equal(changedRecipient.isError, true);
    assert.match(changedRecipient.content[0].text, /APPROVAL_CHANGED/);
    assert.deepEqual(fixture.inputEvents, []);
    assert.match(requests[0].question, /first@example.test/);
    assert.doesNotMatch(requests[0].detail, /Private fixture body/);
    fixture.setOnMove(() => { fixture.document.querySelector("#total").value = "$25"; });
    const changedAmount = await click();
    assert.equal(changedAmount.isError, true);
    assert.match(changedAmount.content[0].text, /APPROVAL_CHANGED/);
    assert.equal(fixture.inputEvents.some(event => event.type === "mousePressed"), false);
    assert.match(requests[1].question, /second@example.test/);
    assert.match(requests[1].detail, /\$10/);
    fixture.setOnMove(undefined);
    assert.equal((await click()).isError, undefined);
    assert.match(requests[2].detail, /\$25/);
    assert.equal(fixture.inputEvents.filter(event => event.type === "mousePressed").length, 1);

    const snapshot = await fixture.browser.snapshot(12);
    const action = { method: "click", params: { ref: snapshot.elements.find(item => item.name === "Send message").ref } };
    const { token } = await fixture.browser.approvalContext(12, { action });
    await fixture.browser.action(12, action.method, action.params, token);
    await assert.rejects(fixture.browser.action(12, action.method, action.params, token), /APPROVAL_CHANGED/);
    assert.equal(fixture.inputEvents.filter(event => event.type === "mousePressed").length, 2);
});

test("replacement dialogs invalidate approval even with an identical message", async t => {
    const fixture = setup(t, "<title>Review</title><button>Open report</button>");
    const dialog = { type: "confirm", message: "Delete the fixture entry?", url: "https://fixture.test/form" };
    fixture.browserEvents.emit({ tabId: 12 }, "Page.javascriptDialogOpening", dialog);
    const action = { method: "dialog", params: { accept: true } };
    const { token } = await fixture.browser.approvalContext(12, { action });
    fixture.browserEvents.emit({ tabId: 12 }, "Page.javascriptDialogClosed");
    fixture.browserEvents.emit({ tabId: 12 }, "Page.javascriptDialogOpening", dialog);
    await assert.rejects(fixture.browser.action(12, action.method, action.params, token), /APPROVAL_CHANGED/);
    assert.deepEqual(fixture.inputEvents, []);
});

test("generic confirmation requires hands-on review while ordinary search Enter remains available", async t => {
    const fixture = setup(t, '<form role="search"><input type="search" aria-label="Search"><button type="submit">Search</button></form><button id="confirm">Confirm</button>');
    const requests = [];
    const server = fixture.observed(async request => { requests.push(request); return { decision: "done" }; });
    fixture.document.querySelector("input").focus();
    assert.equal((await server.callToolResult("browser_press", { tabId: 12, key: "Enter" })).isError, undefined);
    assert.equal(fixture.inputEvents.filter(event => event.type === "keyDown").length, 1);
    assert.deepEqual(requests, []);

    const snapshot = await server.callToolResult("browser_snapshot", { tabId: 12 });
    const ref = snapshot.structuredContent.elements.find(item => item.name === "Confirm").ref;
    const handoff = await server.callToolResult("browser_click", { tabId: 12, ref });
    assert.equal(requests[0].kind, "handoff");
    assert.match(handoff.content[0].text, /fresh snapshot/);
    assert.equal(fixture.inputEvents.filter(event => event.type === "mousePressed").length, 0);
});
