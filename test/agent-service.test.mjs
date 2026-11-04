import test from "node:test";
import assert from "node:assert/strict";
import { AgentService } from "../agent-service.mjs";
import { observedBrowserServer } from "../agent-browser-session.mjs";

const env = { AGENT_PROVIDER: "meta", AGENT_MODEL: "test-model", META_API_KEY: "test-secret-not-for-output" };
const setup = run => new AgentService({ env, run, configure: async () => ({ model: {}, modelSettings: {}, close: async () => {} }) });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("session exposes safe config, streams events, preserves follow-up context and resets on tab change", async () => {
    const histories = [];
    const service = setup(async (prompt, options) => {
        histories.push(options.history);
        options.onActivity({ tool: "browser_snapshot", phase: "complete" });
        options.onObservation({ type: "image", data: "fixture", mimeType: "image/png" });
        return { answer: prompt, history: [{ role: "user", content: prompt }] };
    });
    assert.ok(!JSON.stringify(service.snapshot()).includes(env.META_API_KEY));
    for (const tabId of [12, 12, 13]) {
        await service.command("start", { prompt: "read", tabId, mode: "computer" });
        await service.running;
        assert.equal(service.state.status, "completed");
    }
    assert.deepEqual(histories.map(h => h.length), [0, 1, 0]);
    assert.ok(service.state.events.some(e => e.kind === "assistant"));
    await service.command("clear");
    assert.equal(service.state.events.length, 0);
});

test("pause gates work, steering is delivered, stale controls rejected, stop aborts paused run", async () => {
    let entered = false, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const service = setup(async (_prompt, options) => {
        await barrier;
        await options.checkpoint();
        entered = true;
        assert.deepEqual(options.getSteering(), ["Use the other search"]);
        return { answer: "done" };
    });
    await service.command("start", { prompt: "Search", tabId: 12, mode: "browser" });
    const runId = service.state.runId;
    await assert.rejects(service.command("stop", { runId: "old" }), /previous run/);
    await assert.rejects(service.command("start", { prompt: "Other", tabId: 12, mode: "browser" }), /already running/);
    await service.command("pause", { runId });
    release(); await tick();
    assert.equal(service.state.status, "paused");
    assert.equal(entered, false);
    await service.command("steer", { runId, text: "Use the other search" });
    await service.command("resume", { runId });
    await service.running;
    assert.equal(entered, true);

    service.runAgent = async (_p, options) => { await tick(); await options.checkpoint(); return { answer: "should not complete" }; };
    await service.command("start", { prompt: "Again", tabId: 12, mode: "browser" });
    await service.command("pause", { runId: service.state.runId });
    await tick();
    await service.command("stop", { runId: service.state.runId });
    await service.running;
    assert.equal(service.state.status, "stopped");
});

test("model settings validate credentials, persist nonsecret fields, and report provider failures safely", async () => {
    let saved;
    const service = setup(async () => { throw new Error(`Provider rejected ${env.META_API_KEY}`); });
    service.saveSettings = async next => { saved = next; };
    await assert.rejects(service.command("settings", { provider: "claude", model: "x", maxTurns: 30, timeoutMs: 300000 }), /ANTHROPIC_API_KEY/);
    await service.command("settings", { provider: "meta", model: "other", maxTurns: 20, timeoutMs: 60000 });
    assert.equal(saved.model, "other");
    await service.command("start", { prompt: "Read", tabId: 12, mode: "browser" });
    await service.running;
    assert.equal(service.state.status, "error");
    assert.ok(!JSON.stringify(service.snapshot()).includes(env.META_API_KEY));
    assert.match(service.state.events.at(-1).text, /redacted/);
});

test("visible MCP adapter restricts tab scope, cancels obsolete actions, returns actual screenshot observations", async () => {
    const calls = [], images = [];
    const raw = { callToolResult: async (name, args) => {
        calls.push([name, args]);
        if (name === "browser_tabs") return { content: [], structuredContent: { tabs: [{ id: 1 }, { id: 2 }] } };
        if (name === "browser_screenshot") return { content: [{ type: "image", data: "pixels", mimeType: "image/jpeg" }] };
        return { content: [{ type: "text", text: "changed" }] };
    } };
    let steer = false;
    const server = observedBrowserServer(raw, { mode: "computer", targetTabId: 1, hasSteering: () => steer, onObservation: i => images.push(i) });
    assert.deepEqual((await server.callToolResult("browser_tabs", {})).structuredContent.tabs, [{ id: 1 }]);
    assert.equal((await server.callToolResult("browser_click", { tabId: 2 })).isError, true);
    steer = true;
    assert.equal((await server.callToolResult("browser_click", { tabId: 1 })).isError, true);
    steer = false;
    const result = await server.callToolResult("browser_click", { tabId: 1 });
    assert.equal(result.content.at(-1).data, "pixels");
    assert.equal(images.length, 1);
    assert.deepEqual(calls.map(c => c[0]), ["browser_tabs", "browser_click", "browser_screenshot"]);
});
