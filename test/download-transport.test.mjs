import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTabPilotMcp } from "../mcp.mjs";
import { parseBrowserCommand } from "../commands.mjs";
import { backgroundSource, mockDebugger } from "./background-source.mjs";

test("download schemas enforce typed IDs, HTTP URLs and safe destination paths", () => {
    const parse = (method, params) => parseBrowserCommand({ method, params, tabId: 12 });
    assert.equal(parse("download", { url: "https://example.com/file", saveAs: true }).params.saveAs, true);
    for (const params of [{ url: "file:///a" }, { url: "https://u:p@example.com/a" },
        { url: "https://example.com/a", filename: "../a" }, { url: "https://example.com/a", filename: "a\u0085b" },
        { url: "https://example.com/a", filename: "C:/a" }, { url: "https://example.com/a", saveAs: "true" },
        { url: "https://example.com/a", conflictAction: "overwrite" }]) assert.throws(() => parse("download", params));
    for (const method of ["download-status", "download-cancel"]) {
        assert.equal(parse(method, { downloadId: 40 }).params.downloadId, 40);
        for (const downloadId of [-1, 1.5, "40", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parse(method, { downloadId }));
    }
});

test("download MCP tools forward typed operations and distinguish status from writes", async t => {
    const calls = [];
    const server = createTabPilotMcp({ request: async (method, tabId, params) => { calls.push({ method, tabId, params }); return { id: 40, state: "complete" }; } });
    const client = new Client({ name: "downloads-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(b);
    await client.connect(a);
    const { tools } = await client.listTools();
    assert.equal(tools.find(tool => tool.name === "browser_download_status").annotations.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === "browser_download").annotations.idempotentHint, false);
    assert.equal(tools.find(tool => tool.name === "browser_download_cancel").annotations.readOnlyHint, false);
    for (const [name, params] of [["download", { url: "https://example.com/file", saveAs: true }],
        ["download_status", { downloadId: 40 }], ["download_cancel", { downloadId: 40 }]]) {
        const result = await client.callTool({ name: `browser_${name}`, arguments: { tabId: 12, ...params } });
        assert.equal(result.structuredContent.id, 40);
    }
    assert.deepEqual(calls.map(call => call.method), ["download", "download-status", "download-cancel"]);
    assert.deepEqual(calls[0].params, { url: "https://example.com/file", saveAs: true });
    const invalid = await client.callTool({ name: "browser_download", arguments: { tabId: 12, url: "file:///a" } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 3);
});

test("CLI download forms route exact destination/ID options without network", async t => {
    const directory = await mkdtemp(fileURLToPath(new URL("../.tabpilot/download-cli-test-", import.meta.url)));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await copyFile(new URL("../cli.mjs", import.meta.url), join(directory, "cli.mjs"));
    await copyFile(new URL("../commands.mjs", import.meta.url), join(directory, "commands.mjs"));
    await writeFile(join(directory, "bridge-client.mjs"), 'export const loadBridgeConfig = async () => ({}); export const requestTask = async command => command; export const requestBridge = async (method, tabId, params) => ({ method, tabId, params });');
    const execute = promisify(execFile);
    const cli = async (...args) => JSON.parse((await execute(process.execPath, [join(directory, "cli.mjs"), ...args])).stdout);
    assert.deepEqual(await cli("download", "12", "https://example.com/file", "research/file.pdf", "--save-as"), {
        method: "download", tabId: 12, params: { url: "https://example.com/file", filename: "research/file.pdf", saveAs: true }
    });
    assert.equal((await cli("download", "12", "https://example.com/file", "--save-as")).params.filename, undefined);
    for (const method of ["download-status", "download-cancel"]) assert.deepEqual(await cli(method, "12", "40"), { method, tabId: 12, params: { downloadId: 40 } });
    const task = await cli("task-schedule", "12", "Read title", "60");
    assert.equal(task.method, "task-create");
    assert.equal(task.payload.tabId, 12);
    assert.ok(task.payload.notBefore > Date.now() + 50000);
    assert.deepEqual(await cli("task-list", "12"), { method: "task-list", payload: { tabId: 12 } });
    for (const args of [["download", "12", "https://example.com/file", "../a"], ["download", "12", "https://example.com/file", "--bad"],
        ["download-status", "12", "1.5"], ["download-cancel", "12", "-1"]]) await assert.rejects(cli(...args));
});

test("background dispatch routes all download commands through originating-tab access checks", async () => {
    const stored = { "tab:12": true }, calls = [], sent = [];
    const chrome = {
        runtime: { id: "test", onMessage: { addListener() {} } },
        tabs: { onRemoved: { addListener() {} }, get: async id => ({ id, url: "https://example.com/" }) },
        storage: { session: { get: async key => ({ [key]: stored[key] }), set: async values => Object.assign(stored, values) } },
        downloads: {
            download: async options => { calls.push({ method: "download", options }); return 40; },
            search: async () => [{ id: 40, state: "in_progress" }],
            cancel: async id => { calls.push({ method: "cancel", id }); }
        }
    };
    mockDebugger(chrome, async () => ({}));
    let socket;
    class Socket {
        static OPEN = 1;
        constructor() { socket = this; this.readyState = 1; }
        send(value) { sent.push(JSON.parse(value)); }
    }
    const context = vm.createContext({ chrome, URL, WebSocket: Socket, crypto: globalThis.crypto, setTimeout, clearTimeout });
    vm.runInContext(backgroundSource, context);
    vm.runInContext('executionMode = "bridge"', context);
    const connection = context.connectBridge("a".repeat(64));
    await new Promise(resolve => setImmediate(resolve));
    await socket.onmessage({ data: JSON.stringify({ type: "ready" }) });
    await connection;
    const request = async (method, tabId, params) => {
        await socket.onmessage({ data: JSON.stringify({ type: "request", id: `r${sent.length}`, method, tabId, params }) });
        return sent.at(-1);
    };
    assert.equal((await request("download", 12, { url: "https://example.com/file" })).data.started, true);
    assert.equal((await request("download-status", 12, { downloadId: 40 })).data.state, "in_progress");
    assert.equal((await request("download-cancel", 12, { downloadId: 40 })).ok, true);
    stored["tab:13"] = true;
    assert.match((await request("download-status", 13, { downloadId: 40 })).error, /not tracked/);
    stored["tab:12"] = false;
    assert.match((await request("download", 12, { url: "https://example.com/file" })).error, /Access disabled/);
    assert.equal(calls.filter(call => call.method === "download").length, 1);
    assert.equal(calls.filter(call => call.method === "cancel").length, 1);
});

test("browser profile ID persists across workers and browser startups independently of history scope", async () => {
    const local = {};
    let startup;
    const chrome = {
        runtime: { id: "test", onMessage: { addListener() {} }, onStartup: { addListener(fn) { startup = fn; } } },
        tabs: { onRemoved: { addListener() {} } },
        storage: { local: { get: async key => ({ [key]: local[key] }), set: async values => Object.assign(local, values) } }
    };
    mockDebugger(chrome, async () => ({}));
    const worker = () => { const context = vm.createContext({ chrome, URL, crypto: globalThis.crypto }); vm.runInContext(backgroundSource, context); return context; };
    const first = worker();
    const profile = await first.browserProfileId();
    const history = await first.historyScope();
    assert.match(profile, /^[a-f0-9-]{36}$/i);
    assert.notEqual(profile, history);
    const next = worker();
    assert.equal(await next.browserProfileId(), profile);
    assert.equal(await next.historyScope(), history);
    startup();
    assert.notEqual(await next.historyScope(), history);
    assert.equal(await next.browserProfileId(), profile);
});
