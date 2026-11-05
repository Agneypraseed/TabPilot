import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import { AgentService } from "../agent-service.mjs";
import { TraceHistory } from "../trace-history.mjs";
import { backgroundSource, mockDebugger } from "./background-source.mjs";

const token = "a".repeat(64);
const origin = `chrome-extension://${"a".repeat(32)}`;

test("authenticated extension can start and observe an agent run; disconnect cancels it", async t => {
    let options;
    const service = new AgentService({ env: { AGENT_MODEL: "fixture", OPENAI_API_KEY: "secret-fixture-key" },
        configure: async () => ({ model: {}, modelSettings: {}, close: async () => {} }),
        run: async (_prompt, o) => { options = o; await new Promise(resolve => o.signal.addEventListener("abort", resolve, { once: true })); o.signal.throwIfAborted(); }
    });
    const api = await setup(t, { agentService: service });
    const socket = new WebSocket(`ws://127.0.0.1:${api.port}/extension`, { origin });
    const received = [];
    socket.on("message", data => received.push(JSON.parse(data)));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "authenticate", token }));
    while (!received.some(m => m.type === "agent-state")) await new Promise(r => setImmediate(r));
    assert.ok(!JSON.stringify(received).includes("secret-fixture-key"));
    socket.send(JSON.stringify({ type: "agent-request", id: "start", method: "start", payload: { prompt: "Read", tabId: 12, mode: "computer" } }));
    while (!received.some(m => m.type === "agent-response" && m.id === "start")) await new Promise(r => setImmediate(r));
    assert.equal(received.find(m => m.id === "start").ok, true);
    assert.equal(service.state.status, "running");
    socket.close();
    await once(socket, "close");
    await service.running;
    assert.equal(options.signal.aborted, true);
    assert.equal(service.state.status, "stopped");
});

async function setup(t, options = {}) {
    const bridge = createBridge({ token, ...options });
    await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
    t.after(() => bridge.close());
    const port = bridge.server.address().port;
    return {
        bridge, port,
        async request(path, headers = {}) {
            if (headers.Host) {
                return new Promise((resolve, reject) => {
                    const request = httpRequest(`http://127.0.0.1:${port}${path}`, {
                        method: "POST", headers: { Authorization: `Bearer ${token}`, ...headers }
                    }, (response) => {
                        response.resume();
                        response.on("end", () => resolve({ status: response.statusCode }));
                    });
                    request.on("error", reject);
                    request.end();
                });
            }
            return fetch(`http://127.0.0.1:${port}${path}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, ...headers }
            });
        }
    };
}

async function pair(port, candidate = token, historyScope) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin });
    await once(socket, "open");
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ type: "authenticate", token: candidate, historyScope }));
    await ready;
    return socket;
}

test("bridge archives workspace and external activity without crossing tab or browser history", { timeout: 15000 }, async t => {
    const root = fileURLToPath(new URL("../.tabpilot/", import.meta.url));
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "bridge-history-test-"));
    t.after(async () => {
        assert.equal(resolve(dirname(directory)), resolve(root));
        assert.ok(basename(directory).startsWith("bridge-history-test-"));
        await rm(directory, { recursive: true, force: true });
    });
    const scope = randomUUID(), traceStore = new TraceHistory(directory);
    let api;
    const service = new AgentService({ traceStore, env: { OPENAI_API_KEY: "fixture", AGENT_MODEL: "fixture" },
        configure: async () => ({ model: {}, close: async () => {} }),
        run: async (_prompt, options) => {
            const response = await api.request("/snapshot/12", { "X-TabPilot-Run": options.traceContext.runId, "X-TabPilot-Source": "mcp" });
            assert.equal(response.status, 200);
            await response.json();
            const fill = await fetch(`http://127.0.0.1:${api.port}/command`, { method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-TabPilot-Run": options.traceContext.runId },
                body: JSON.stringify({ method: "fill", tabId: 12, params: { ref: "snapshot:e1", text: "sensitive-typed-value" } }) });
            assert.equal(fill.status, 200);
            await fill.json();
            return { answer: "Workspace task complete" };
        } });
    api = await setup(t, { agentService: service });
    const extension = await pair(api.port, token, scope);
    extension.on("message", raw => {
        const message = JSON.parse(raw);
        if (message.type !== "request") return;
        extension.send(JSON.stringify({ type: "response", id: message.id, ok: true,
            data: { title: `Tab ${message.tabId}`, text: "Observed", elements: [] } }));
    });
    await service.command("start", { scope, tabId: 12, mode: "browser", prompt: "Check my page" });
    await service.running;
    const runs = (await traceStore.list({ scope, tabId: 12 })).runs;
    assert.equal(runs.length, 1, "workspace tool calls attach to their existing task, not duplicate runs");
    assert.equal(runs[0].source, "workspace");
    const events = (await traceStore.events({ scope, tabId: 12, runId: runs[0].runId })).events;
    assert.ok(events.some(event => event.kind === "tool" && event.phase === "complete" && event.result.title === "Tab 12"));
    assert.ok(!JSON.stringify(events).includes("sensitive-typed-value"));
    assert.match(events.find(event => event.tool === "fill" && event.phase === "running").arguments.text, /omitted/);
    await (await api.request("/snapshot/34", { "X-TabPilot-Source": "cli" })).json();
    const external = (await traceStore.list({ scope, tabId: 34 })).runs;
    assert.equal(external.length, 1);
    assert.equal(external[0].source, "cli");
    assert.equal((await traceStore.list({ scope, tabId: 12 })).runs.length, 1);
    const response = new Promise(resolve => {
        const listener = raw => {
            const message = JSON.parse(raw);
            if (message.type === "agent-response" && message.id === "history-check") { extension.off("message", listener); resolve(message); }
        };
        extension.on("message", listener);
    });
    extension.send(JSON.stringify({ type: "agent-request", id: "history-check", method: "history-list", payload: { scope: randomUUID(), tabId: 12 } }));
    const history = await response;
    assert.equal(history.ok, true);
    assert.equal(history.history.runs.length, 1);
    assert.equal(history.history.runs[0].tabId, 12);
});

test("authenticated UI can answer only the matching pending human request", async t => {
    const scope = randomUUID();
    const service = new AgentService({ env: { OPENAI_API_KEY: "fixture", AGENT_MODEL: "fixture" },
        configure: async () => ({ model: {}, close: async () => {} }),
        run: async (_prompt, options) => {
            const reply = await options.requestHuman({ kind: "information", question: "Which topic?" });
            return { answer: `Selected ${reply.text}` };
        } });
    const api = await setup(t, { agentService: service });
    const extension = await pair(api.port, token, scope);
    const send = (id, payload) => new Promise(resolve => {
        const listener = raw => { const message = JSON.parse(raw); if (message.type === "agent-response" && message.id === id) { extension.off("message", listener); resolve(message); } };
        extension.on("message", listener);
        extension.send(JSON.stringify({ type: "agent-request", id, method: "human-response", payload }));
    });
    await service.command("start", { scope, prompt: "Research", tabId: 12, mode: "browser" });
    while (!service.humanRequests.list().length) await new Promise(resolve => setImmediate(resolve));
    const pending = service.humanRequests.list()[0];
    const invalid = await send("wrong", { id: pending.id, runId: randomUUID(), decision: "answer", text: "Space" });
    assert.equal(invalid.ok, false);
    assert.equal(service.state.status, "needs-input");
    const valid = await send("right", { id: pending.id, runId: pending.runId, scope: randomUUID(), decision: "answer", text: "Space" });
    assert.equal(valid.ok, true);
    await service.running;
    assert.equal(service.state.status, "completed");
    assert.equal(service.state.events.at(-1).text, "Selected Space");
});

test("local API rejects bad tokens, browser origins, and rebound hosts", async (t) => {
    const api = await setup(t);
    assert.equal((await api.request("/tabs", { Authorization: "Bearer wrong" })).status, 401);
    assert.equal((await api.request("/tabs", { Origin: "https://example.com" })).status, 403);
    assert.equal((await api.request("/tabs", { Host: "example.com" })).status, 403);
    assert.equal((await api.request("/tabs")).status, 503);
});

test("WebSocket rejects page origins and incorrect pairing tokens", async (t) => {
    const { port } = await setup(t);
    const browser = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: "https://example.com" });
    const [error] = await once(browser, "error");
    assert.match(error.message, /403/);
    const unpaired = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin });
    await once(unpaired, "open");
    const closed = once(unpaired, "close");
    unpaired.send(JSON.stringify({ type: "authenticate", token: "wrong" }));
    assert.equal((await closed)[0], 1008);
});

test("concurrent CLI requests receive their own extension responses", async (t) => {
    const api = await setup(t);
    const extension = await pair(api.port);
    const requests = [];
    extension.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (message.type !== "request") return;
        requests.push(message);
        if (requests.length !== 2) return;
        for (const request of requests.reverse()) {
            extension.send(JSON.stringify({ type: "response", id: request.id, ok: true,
                data: { tabId: request.tabId } }));
        }
    });
    const responses = await Promise.all([api.request("/snapshot/12"), api.request("/snapshot/34")]);
    assert.deepEqual(await responses[0].json(), { ok: true, data: { tabId: 12 } });
    assert.deepEqual(await responses[1].json(), { ok: true, data: { tabId: 34 } });
});

test("action transport validates commands and preserves target arguments", async (t) => {
    const api = await setup(t);
    const extension = await pair(api.port);
    extension.on("message", raw => {
        const message = JSON.parse(raw);
        if (message.type !== "request") return;
        assert.equal(message.method, "fill");
        assert.equal(message.tabId, 12);
        assert.deepEqual(message.params, { ref: "snapshot:e1", text: "hello" });
        extension.send(JSON.stringify({ type: "response", id: message.id, ok: true, data: { action: "fill" } }));
    });
    const send = body => fetch(`http://127.0.0.1:${api.port}/command`, { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await send({ method: "Runtime.evaluate", tabId: 12, params: {} })).status, 400);
    assert.equal((await send({ method: "click", tabId: 12, params: {} })).status, 400);
    const response = await send({ method: "fill", tabId: 12, params: { ref: "snapshot:e1", text: "hello" } });
    assert.deepEqual(await response.json(), { ok: true, data: { action: "fill" } });
});

test("missing responses time out and extension disconnects fail promptly", async (t) => {
    const api = await setup(t, { timeoutMs: 100 });
    const extension = await pair(api.port);
    assert.equal((await api.request("/tabs")).status, 504);
    extension.on("message", () => extension.close());
    assert.equal((await api.request("/tabs")).status, 503);
});

test("real background handler enforces permissions through the bridge", async (t) => {
    const api = await setup(t);
    const stored = { "tab:99": false };
    let removed;
    let reads = 0;
    const chrome = {
        runtime: { id: "test", onMessage: { addListener() {} } },
        tabs: {
            onRemoved: { addListener(fn) { removed = fn; } },
            query: async () => [{ id: 12, title: "Example", url: "https://example.com/" }, { id: 99, url: "https://other.example/" }].filter(tab => tab.id !== 12 || stored["tab:12"] !== "closed"),
            get: async (id) => ({ id, title: "Example", url: "https://example.com/" })
        },
        storage: { session: {
            get: async (key) => key === null ? { ...stored } : { [key]: stored[key] },
            remove: async (key) => { delete stored[key]; }
        } },
        scripting: { executeScript: async ({ func }) => {
            reads++;
            return [{ result: func() }];
        } }
    };
    class BrowserSocket extends WebSocket {
        constructor(url) {
            assert.equal(url, "ws://127.0.0.1:4311/extension");
            super(`ws://127.0.0.1:${api.port}/extension`, { origin });
        }
    }
    const context = vm.createContext({ chrome, WebSocket: BrowserSocket, setTimeout, clearTimeout, URL,
        document: { title: "Example", body: { innerText: "x".repeat(20001) }, querySelectorAll: () => [] },
        crypto: globalThis.crypto, innerWidth: 1000, innerHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
        location: { href: "https://example.com/" } });
    mockDebugger(chrome, expression => { reads++; return vm.runInContext(expression, context); });
    vm.runInContext(backgroundSource, context);
    vm.runInContext('executionMode = "bridge"', context);
    await vm.runInContext(`connectBridge("${token}")`, context);

    const tabs = await (await api.request("/tabs")).json();
    assert.deepEqual(tabs.data, [{ id: 12, title: "Example", url: "https://example.com/" }]);
    assert.equal((await api.request("/snapshot/99")).status, 409);
    assert.equal(reads, 0, "disabled tab must never execute the reader");
    const snapshot = await (await api.request("/snapshot/12")).json();
    assert.equal(snapshot.data.text.length, 20000);
    assert.equal(snapshot.data.truncated, true);
    stored["tab:12"] = false;
    assert.equal((await api.request("/snapshot/12")).status, 409);
    assert.equal(reads, 1, "revoked access must block additional reads");
    stored["tab:12"] = true;
    removed(12);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stored["tab:12"], undefined);
    stored["tab:12"] = "closed";
    assert.deepEqual((await (await api.request("/tabs")).json()).data, []);
});
