import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { TraceHistory } from "../trace-history.mjs";
import { AgentService } from "../agent-service.mjs";

export async function historyFixture(t) {
    const root = fileURLToPath(new URL("../.tabpilot/", import.meta.url));
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "history-test-"));
    t.after(async () => {
        assert.equal(resolve(dirname(directory)), resolve(root));
        assert.ok(basename(directory).startsWith("history-test-"));
        await rm(directory, { recursive: true, force: true });
    });
    return directory;
}

test("history survives reopening, isolates tab/browser sessions, and resolves images only within their run", async t => {
    const root = await historyFixture(t), scope = randomUUID();
    const store = new TraceHistory(root, { env: { OPENAI_API_KEY: "private-api-key" }, secrets: ["pairing-secret"] });
    store.bridgeSessionId = "bridge-1";
    const context = { scope, tabId: 12, runId: randomUUID() };
    await store.start({ ...context, bridgeSessionId: "bridge-1", source: "workspace", task: "Check page" });
    await store.append(context, { kind: "tool", tool: "screenshot", result: { text: "private-api-key pairing-secret", token: "hidden", image: { mimeType: "image/png", data: Buffer.from("test-image").toString("base64") } } });
    await store.finish(context, "completed");
    const reopened = new TraceHistory(root); reopened.bridgeSessionId = "bridge-2";
    assert.equal((await reopened.list({ scope, tabId: 12 })).runs.length, 1);
    assert.equal((await reopened.list({ scope, tabId: 99 })).runs.length, 0);
    assert.equal((await reopened.list({ scope: randomUUID(), tabId: 12 })).runs.length, 0);
    const event = (await reopened.events(context)).events[0];
    assert.equal(event.result.text, "[redacted] [redacted]");
    assert.equal(event.result.token, "[redacted]");
    assert.equal(event.result.image.data, undefined);
    const artifact = await reopened.artifact({ ...context, artifactId: event.result.image.artifactId });
    assert.equal(Buffer.from(artifact.data, "base64").toString(), "test-image");
    await assert.rejects(reopened.artifact({ ...context, tabId: 99, artifactId: event.result.image.artifactId }), /not found/);
    await assert.rejects(reopened.events({ ...context, runId: "../escape" }));
    const disk = await readFile(join(store.path(scope, 12, context.runId), "events.jsonl"), "utf8");
    assert.ok(!disk.includes("private-api-key"));
});

test("all run events persist past the live feed cap, and New chat keeps history", async t => {
    const store = new TraceHistory(await historyFixture(t));
    const scope = randomUUID(); let service;
    service = new AgentService({ traceStore: store, env: { OPENAI_API_KEY: "fixture", AGENT_MODEL: "fixture" },
        configure: async () => ({ model: {}, close: async () => {} }),
        run: async () => { for (let n = 0; n < 185; n++) service.event("status", `Step ${n}`); return { answer: "Complete" }; } });
    await service.command("start", { scope, tabId: 12, mode: "browser", prompt: "A long task" });
    await service.running;
    assert.equal(service.state.events.length, 160);
    const { runs } = (await service.command("history-list", { scope, tabId: 12 })).history;
    assert.equal(runs[0].status, "completed");
    let offset = 0, events = [];
    do {
        const page = await store.events({ scope, tabId: 12, runId: runs[0].runId, offset });
        events.push(...page.events); offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(events.length, 187);
    await service.command("clear");
    assert.equal((await store.list({ scope, tabId: 12 })).runs.length, 1);
    assert.equal((await store.list({ scope, tabId: 13 })).runs.length, 0);
});

test("abandoned runs are marked interrupted after a bridge restart", async t => {
    const root = await historyFixture(t), scope = randomUUID();
    const store = new TraceHistory(root); store.bridgeSessionId = "old";
    const runId = randomUUID();
    await store.start({ scope, tabId: 12, runId, task: "Unfinished", bridgeSessionId: "old" });
    const reopened = new TraceHistory(root); reopened.bridgeSessionId = "new";
    assert.equal((await reopened.list({ scope, tabId: 12 })).runs[0].status, "interrupted");
    assert.equal((await reopened.events({ scope, tabId: 12, runId })).events.length, 0);
});
