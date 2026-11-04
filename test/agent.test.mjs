import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MCPServerStdio, Usage } from "@openai/agents";
import { runBrowserAgent } from "../agent.mjs";
import { AgentService } from "../agent-service.mjs";

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

test("scheduled agent turn limit returns complete SDK tool history for continuation", async () => {
    const model = { getResponse: async () => call("browser_snapshot", { tabId: 12 }, 1), async *getStreamedResponse() {} };
    const result = await runBrowserAgent("Read", { server: fixtureServer(), model, targetTabId: 12, maxTurns: 1, continueOnLimit: true });
    assert.equal(result.continuation, true);
    assert.ok(result.history.some(item => item.type === "function_call"));
    assert.ok(result.history.some(item => item.type === "function_call_result"));
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

test("SDK incorporates mid-run guidance before executing a newly proposed obsolete action", async () => {
    let turns = 0, pending = [], rawCalls = 0;
    const server = fixtureServer();
    const raw = server.callToolResult.bind(server);
    server.callToolResult = async (...args) => { if (args[0] === "browser_snapshot") rawCalls++; return raw(...args); };
    const model = {
        async getResponse(request) {
            if (++turns === 1) {
                // User steers while this model response is in flight.
                pending.push("Instead, summarize only the title.");
                return call("browser_snapshot", { tabId: 12 }, turns);
            }
            assert.match(JSON.stringify(request.input), /Instead, summarize only the title/);
            assert.match(JSON.stringify(request.input), /Reconsider this action/);
            return { usage: new Usage({ requests: 1 }), output: [{ type: "message", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: "Updated task received." }] }] };
        },
        async *getStreamedResponse() {}
    };
    await runBrowserAgent("Read the page", { server, model, targetTabId: 12,
        hasSteering: () => pending.length > 0, getSteering: () => pending.splice(0) });
    assert.equal(rawCalls, 0, "obsolete action must never reach the browser");
});

test("session pause, steering, and resume gate actual SDK/MCP tool dispatch", { timeout: 15000 }, async () => {
    let service, turns = 0, snapshotCalls = 0;
    const server = fixtureServer();
    const raw = server.callToolResult.bind(server);
    server.callToolResult = async (...args) => { if (args[0] === "browser_snapshot") snapshotCalls++; return raw(...args); };
    const model = {
        async getResponse(request) {
            if (++turns === 1) {
                await service.command("pause", { runId: service.state.runId });
                return call("browser_snapshot", { tabId: 12 }, turns);
            }
            assert.match(JSON.stringify(request.input), /Only explain the title/);
            return { usage: new Usage({ requests: 1 }), output: [{ type: "message", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: "Guidance applied." }] }] };
        }, async *getStreamedResponse() {}
    };
    service = new AgentService({ env: { OPENAI_API_KEY: "fixture-key", AGENT_MODEL: "fixture" },
        configure: async () => ({ model, modelSettings: {}, close: async () => {} }),
        run: (prompt, options) => runBrowserAgent(prompt, { ...options, server }) });
    const paused = new Promise(resolve => {
        const unsubscribe = service.subscribe(state => { if (state.status === "paused") { unsubscribe(); resolve(); } });
    });
    await service.command("start", { prompt: "Read", tabId: 12, mode: "browser" });
    await paused;
    assert.equal(snapshotCalls, 0);
    await service.command("steer", { runId: service.state.runId, text: "Only explain the title" });
    await service.command("resume", { runId: service.state.runId });
    await service.running;
    assert.equal(service.state.status, "completed");
    assert.equal(snapshotCalls, 0);
    assert.match(JSON.stringify(service.history), /Only explain the title/);
});

test("Stop aborts a paused SDK run without dispatching the pending browser action", { timeout: 15000 }, async () => {
    let service, browserActions = 0;
    const server = fixtureServer();
    const raw = server.callToolResult.bind(server);
    server.callToolResult = async (...args) => { if (args[0] === "browser_click") browserActions++; return raw(...args); };
    const model = {
        async getResponse() {
            await service.command("pause", { runId: service.state.runId });
            return call("browser_click", { tabId: 12, ref: "fixture:e1" }, 1);
        }, async *getStreamedResponse() {}
    };
    service = new AgentService({ env: { OPENAI_API_KEY: "fixture-key", AGENT_MODEL: "fixture" },
        configure: async () => ({ model, modelSettings: {}, close: async () => {} }),
        run: (prompt, options) => runBrowserAgent(prompt, { ...options, server }) });
    const paused = new Promise(resolve => {
        const unsubscribe = service.subscribe(state => { if (state.status === "paused") { unsubscribe(); resolve(); } });
    });
    await service.command("start", { prompt: "Click", tabId: 12, mode: "browser" });
    await paused;
    await service.command("stop", { runId: service.state.runId });
    await service.running;
    assert.equal(service.state.status, "stopped");
    assert.equal(browserActions, 0);
    assert.equal(service.history.length, 0);
});

test("SDK human-help tool waits for a real reply then resumes the same task", { timeout: 15000 }, async () => {
    let turns = 0;
    const model = {
        async getResponse(request) {
            if (++turns === 1) return call("request_user_help", { kind: "information", question: "Which exhibit should I inspect?", detail: "Choose a topic." }, turns);
            assert.match(JSON.stringify(request.input), /Space exhibit/);
            return { usage: new Usage({ requests: 1 }), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "I will inspect the Space exhibit." }] }] };
        }, async *getStreamedResponse() {}
    };
    const service = new AgentService({ env: { OPENAI_API_KEY: "fixture", AGENT_MODEL: "fixture" },
        configure: async () => ({ model, close: async () => {} }),
        run: (prompt, options) => runBrowserAgent(prompt, { ...options, server: fixtureServer() }) });
    const waiting = new Promise(resolve => {
        const unsubscribe = service.subscribe(state => { if (state.requests.length) { unsubscribe(); resolve(state.requests[0]); } });
    });
    await service.command("start", { prompt: "Inspect an exhibit", tabId: 12, mode: "browser" });
    const request = await waiting;
    assert.equal(service.state.status, "needs-input");
    assert.equal(turns, 1);
    await service.command("human-response", { id: request.id, runId: request.runId, decision: "answer", text: "Space exhibit" });
    await service.running;
    assert.equal(service.state.status, "completed");
    assert.equal(service.humanRequests.list().length, 0);
    assert.match(JSON.stringify(service.history), /Space exhibit/);
});
