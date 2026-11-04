import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import { backgroundSource, mockDebugger } from "./background-source.mjs";

const token = "a".repeat(64);
const origin = `chrome-extension://${"a".repeat(32)}`;

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

async function pair(port, candidate = token) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin });
    await once(socket, "open");
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ type: "authenticate", token: candidate }));
    await ready;
    return socket;
}

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

test("missing responses time out and extension disconnects fail promptly", async (t) => {
    const api = await setup(t, { timeoutMs: 100 });
    const extension = await pair(api.port);
    assert.equal((await api.request("/tabs")).status, 504);
    extension.on("message", () => extension.close());
    assert.equal((await api.request("/tabs")).status, 503);
});

test("real background handler enforces permissions through the bridge", async (t) => {
    const api = await setup(t);
    const stored = { "tab:12": true };
    let removed;
    let reads = 0;
    const chrome = {
        runtime: { id: "test", onMessage: { addListener() {} } },
        tabs: {
            onRemoved: { addListener(fn) { removed = fn; } },
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
    assert.equal(stored["tab:12"], undefined);
    assert.deepEqual((await (await api.request("/tabs")).json()).data, []);
});
