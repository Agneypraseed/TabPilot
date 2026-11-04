import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MCPServerStdio, Usage } from "@openai/agents";
import { runBrowserAgent } from "../agent.mjs";

function fixtureServer() {
    return new MCPServerStdio({
        name: "test-browser",
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/agent-mcp.mjs", import.meta.url))],
        cacheToolsList: true,
        useStructuredContent: true
    });
}

const call = (name, arguments_, index) => ({
    usage: new Usage({ requests: 1 }),
    output: [{ type: "function_call", callId: `call-${index}`, name, arguments: JSON.stringify(arguments_) }]
});

test("agent SDK executes model-selected MCP tools and returns tool results to the model", async () => {
    let turns = 0;
    const model = {
        async getResponse(request) {
            turns++;
            assert.equal(request.modelSettings.store, false);
            assert.ok(request.tools.some(tool => tool.name === "browser_tabs"));
            if (turns === 1) return call("browser_tabs", {}, turns);
            if (turns === 2) {
                assert.match(JSON.stringify(request.input), /Test page/);
                return call("browser_snapshot", { tabId: 12 }, turns);
            }
            assert.match(JSON.stringify(request.input), /museum opens at 10 AM/);
            return { usage: new Usage({ requests: 1 }), output: [{ type: "message", role: "assistant",
                status: "completed", content: [{ type: "output_text", text: "The museum opens at 10 AM." }] }] };
        },
        async *getStreamedResponse() { throw new Error("Streaming was not requested"); }
    };
    const observed = [];
    const result = await runBrowserAgent("Summarize my test tab", {
        server: fixtureServer(), model, onToolCall: name => observed.push(name)
    });
    assert.equal(result.answer, "The museum opens at 10 AM.");
    assert.deepEqual(result.toolCalls, ["browser_tabs", "browser_snapshot"]);
    assert.deepEqual(observed, result.toolCalls);
    assert.equal(turns, 3);
});

test("agent checks browser availability before model usage and closes MCP on failure", async () => {
    for (const available of [
        { isError: true, content: [{ type: "text", text: "Bridge disconnected" }] },
        { structuredContent: { tabs: [] } }
    ]) {
        let closed = false;
        const server = {
            connect: async () => {}, callToolResult: async () => available,
            close: async () => { closed = true; }
        };
        const model = { getResponse: async () => assert.fail("Must not call model before a browser is ready") };
        await assert.rejects(runBrowserAgent("Read a page", { server, model }), /Bridge disconnected|No enabled tabs/);
        assert.equal(closed, true);
    }
});

test("agent stops a model that repeatedly calls tools at the configured turn limit", async () => {
    let turns = 0;
    const model = {
        getResponse: async () => call("browser_tabs", {}, ++turns),
        async *getStreamedResponse() {}
    };
    await assert.rejects(runBrowserAgent("Loop", { server: fixtureServer(), model, maxTurns: 2 }), /turn/i);
    assert.equal(turns, 2);
});

test("agent receives screenshot image bytes in model context rather than metadata alone", async () => {
    let turns = 0;
    const model = {
        async getResponse(request) {
            if (++turns === 1) return call("browser_screenshot", { tabId: 12 }, turns);
            const input = JSON.stringify(request.input);
            assert.match(input, /data:image\/png;base64,/);
            assert.match(input, /test-shot/);
            return { usage: new Usage({ requests: 1 }), output: [{ type: "message", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: "Image received." }] }] };
        },
        async *getStreamedResponse() {}
    };
    const server = fixtureServer();
    server.useStructuredContent = false;
    const result = await runBrowserAgent("Inspect the screenshot", { server, model });
    assert.equal(result.answer, "Image received.");
    assert.deepEqual(result.toolCalls, ["browser_screenshot"]);
});
