import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTabPilotMcp } from "../mcp.mjs";

async function connect(t, request) {
    const server = createTabPilotMcp({ request });
    const client = new Client({ name: "tabpilot-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
}

test("MCP advertises exactly the two read-only tools and their input schemas", async (t) => {
    const client = await connect(t, async () => []);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["browser_snapshot", "browser_tabs"]);
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint === true));
    const snapshot = tools.find(tool => tool.name === "browser_snapshot");
    assert.deepEqual(snapshot.inputSchema.required, ["tabId"]);
    assert.equal(snapshot.inputSchema.properties.tabId.type, "integer");
});

test("MCP routes tools to the bridge and returns structured JSON", async (t) => {
    const calls = [];
    const tabs = [{ id: 12, title: "Example", url: "https://example.com/" }];
    const snapshot = { title: "Example", url: "https://example.com/", text: "Page text", truncated: false };
    const client = await connect(t, async (method, tabId) => {
        calls.push({ method, tabId });
        return method === "tabs" ? tabs : snapshot;
    });
    const listed = await client.callTool({ name: "browser_tabs", arguments: {} });
    assert.deepEqual(listed.structuredContent, { tabs });
    const read = await client.callTool({ name: "browser_snapshot", arguments: { tabId: 12 } });
    assert.deepEqual(read.structuredContent, snapshot);
    assert.deepEqual(JSON.parse(read.content[0].text), snapshot);
    assert.deepEqual(calls, [{ method: "tabs", tabId: undefined }, { method: "snapshot", tabId: 12 }]);
});

test("MCP rejects invalid IDs before forwarding and reports bridge errors as tool errors", async (t) => {
    let calls = 0;
    const client = await connect(t, async () => {
        calls++;
        throw new Error("Access disabled. Enable this tab before reading it.");
    });
    for (const arguments_ of [{}, { tabId: "12" }, { tabId: -1 }, { tabId: 1.5 }]) {
        const result = await client.callTool({ name: "browser_snapshot", arguments: arguments_ });
        assert.equal(result.isError, true);
    }
    assert.equal(calls, 0);
    const disabled = await client.callTool({ name: "browser_snapshot", arguments: { tabId: 12 } });
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /Access disabled/);
    assert.equal(calls, 1);
});

test("real MCP process initializes over stdio from another working directory", async (t) => {
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../mcp.mjs", import.meta.url))],
        cwd: tmpdir(),
        stderr: "pipe"
    });
    let stderr = "";
    transport.stderr.on("data", data => { stderr += data; });
    t.after(() => client.close());
    await client.connect(transport);
    const result = await client.listTools();
    assert.equal(result.tools.length, 2);
    assert.equal(stderr, "");
});
