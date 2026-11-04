import test from "node:test";
test("download approval identifies exact URL and location and status does not ask again", async () => {
    const requests = [];
    const policy = browserApprovalPolicy({ requestHuman: async request => { requests.push(request); return { decision: "approve" }; } });
    await policy.beforeTool("browser_download", { tabId: 12, url: "https://example.com/report.pdf", filename: "research/report.pdf", saveAs: false });
    assert.match(requests[0].detail, /https:\/\/example.com\/report.pdf/);
    assert.match(requests[0].detail, /Downloads\/research\/report.pdf/);
    await policy.beforeTool("browser_download_status", { tabId: 12, downloadId: 9 });
    assert.equal(requests.length, 1);
    const local = browserApprovalPolicy({ downloadDirectory: "D:\\Reports", requestHuman: async request => { requests.push(request); return { decision: "deny" }; } });
    const denied = await local.beforeTool("browser_download_local", { tabId: 12, url: "https://example.com/report.pdf", filename: "study/report.pdf" });
    assert.equal(denied.isError, true);
    assert.match(requests[1].detail, /D:\\Reports/);
    assert.match(requests[1].detail, /study\/report.pdf/);
    assert.match(requests[1].detail, /without browser cookies/);
});
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HumanRequests, ActiveRunBudget } from "../human-requests.mjs";
import { browserApprovalPolicy } from "../agent-interactions.mjs";
import { observedBrowserServer } from "../agent-browser-session.mjs";

test("human requests are scoped, single-use, and distinguish approval from manual handoff", async () => {
    const broker = new HumanRequests();
    const scope = randomUUID(), runId = randomUUID();
    const reply = broker.request({ kind: "approval", question: "Allow this one action?" }, { scope, runId, tabId: 12 });
    const request = broker.list()[0];
    assert.throws(() => broker.respond({ id: request.id, runId, scope: randomUUID(), decision: "approve" }), /no longer pending/);
    broker.respond({ id: request.id, runId, scope, decision: "deny" });
    assert.equal((await reply).decision, "deny");
    assert.throws(() => broker.respond({ id: request.id, runId, scope, decision: "approve" }), /no longer pending/);
    const handoff = broker.request({ kind: "handoff", question: "Handle the CAPTCHA in the browser." }, { scope, runId, tabId: 12 });
    const captcha = broker.list()[0];
    assert.throws(() => broker.respond({ id: captcha.id, runId, scope, decision: "approve" }), /appropriate/);
    broker.respond({ id: captcha.id, runId, scope, decision: "done" });
    assert.equal((await handoff).decision, "done");
    assert.equal(broker.list().length, 0);
});

test("stopping aborts pending input and blank answers cannot resume a task", async () => {
    const broker = new HumanRequests(), controller = new AbortController(), runId = randomUUID();
    const reply = broker.request({ kind: "information", question: "Which date?" }, { signal: controller.signal, runId, tabId: 12 });
    const request = broker.list()[0];
    assert.throws(() => broker.respond({ id: request.id, runId, decision: "answer", text: "  " }), /Enter/);
    controller.abort(new Error("Stopped"));
    await assert.rejects(reply, /Stopped/);
    assert.equal(broker.list().length, 0);
});

test("active-time budget does not expire while the user is answering", async () => {
    let expired = false, expire;
    const done = new Promise(resolve => { expire = resolve; });
    const budget = new ActiveRunBudget(50, () => { expired = true; expire(); });
    budget.suspend();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(expired, false);
    budget.resume(); await done; budget.stop();
    assert.equal(expired, true);
});

test("important-action approval blocks browser dispatch until the actual user decision", async () => {
    let release, calls = 0;
    const policy = browserApprovalPolicy({ requestHuman: request => {
        assert.match(request.question, /Confirm order/);
        return new Promise(resolve => { release = resolve; });
    } });
    policy.afterTool("browser_snapshot", { tabId: 12 }, { structuredContent: { elements: [{ ref: "s:e1", name: "Confirm order" }] } });
    const server = observedBrowserServer({ callToolResult: async () => { calls++; return { content: [] }; } }, policy);
    const pending = server.callToolResult("browser_click", { tabId: 12, ref: "s:e1" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
    release({ decision: "deny" });
    assert.equal((await pending).isError, true);
    assert.equal(calls, 0);
});

test("recognized CAPTCHA interaction is handed to the user and never executed after acknowledgement", async () => {
    let calls = 0, kind;
    const policy = browserApprovalPolicy({ requestHuman: async request => { kind = request.kind; return { decision: "done" }; } });
    policy.afterTool("browser_snapshot", { tabId: 12 }, { structuredContent: { text: "Verify you are human", elements: [] } });
    const server = observedBrowserServer({ callToolResult: async () => { calls++; return { content: [] }; } }, policy);
    const result = await server.callToolResult("browser_pointer", { tabId: 12, x: 100, y: 100 });
    assert.equal(kind, "handoff");
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
    assert.match(result.content[0].text, /fresh snapshot/);
});
