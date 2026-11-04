import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RunContext } from "@openai/agents";
import { TaskManager } from "../task-manager.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
test("repeat schedules only after successful completion and canceling the next occurrence prevents execution", async () => {
    let calls = 0;
    const ui = setup(async (_prompt, options) => { calls++; return complete(options); });
    await ui.manager.connected({ scope: ui.scope });
    await ui.create({ repeatEveryMs: 60000 });
    await until(() => !ui.manager.active && ui.records.size === 2);
    const first = [...ui.records.values()].find(record => record.status === "completed");
    const next = [...ui.records.values()].find(record => record.status === "scheduled");
    assert.equal(next.seriesId, first.id);
    assert.equal(next.notBefore, 61000);
    await ui.manager.tick();
    assert.equal(calls, 1);
    await ui.manager.command("task-cancel", { taskId: next.id, scope: ui.scope });
    ui.advance(60000);
    await ui.manager.tick();
    assert.equal(calls, 1);
    assert.equal(ui.records.get(next.id).status, "cancelled");
    await ui.manager.close();
});
test("stopping coordinator during child persistence cannot launch the new specialist", async () => {
    let release, blocked = false, childCalls = 0;
    const barrier = new Promise(resolve => { release = resolve; });
    const ui = setup(async (_prompt, options) => {
        if (options.targetTabId !== 12) { childCalls++; return complete(options); }
        await options.extraTools.find(tool => tool.name === "delegate_research").invoke(new RunContext(), JSON.stringify({ url: "https://example.com/research", task: "Read source" }));
        return complete(options);
    }, { browser: async method => method === "tabs" ? [{ id: 12 }] : { tabId: 90, url: "https://example.com/research", enabled: false } });
    const save = ui.manager.store.upsert;
    ui.manager.store.upsert = async record => {
        if (record.role === "research" && record.status === "queued" && !blocked) { blocked = true; await barrier; }
        return save(record);
    };
    ui.manager.approveResearchTab = async () => {};
    await ui.manager.connected({ scope: ui.scope });
    await ui.create();
    await until(() => ui.manager.snapshot().requests.length === 1);
    const request = ui.manager.snapshot().requests[0];
    await ui.manager.command("human-response", { id: request.id, runId: request.runId, scope: ui.scope, decision: "approve" });
    await until(() => blocked);
    const parent = [...ui.manager.records.values()].find(record => !record.parentTaskId);
    await ui.manager.command("task-cancel", { taskId: parent.id, scope: ui.scope });
    release();
    await until(() => !ui.manager.active);
    assert.equal(childCalls, 0);
    assert.equal([...ui.manager.records.values()].find(record => record.role === "research").status, "cancelled");
    await ui.manager.close();
});
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await flush(); } assert.fail("Task did not settle"); }
function setup(run, options = {}) {
    const records = new Map();
    const scope = randomUUID(), profileId = randomUUID();
    let clock = 1000, tabs = [{ id: 12 }, { id: 34 }];
    const manager = new TaskManager({ store: { load: async () => [], upsert: async record => { records.set(record.id, structuredClone(record)); return structuredClone(record); } },
        browser: async () => ({ tabs }), now: () => clock, autoTick: false,
        serviceOptions: { env: { META_API_KEY: "fixture", AGENT_PROVIDER: "meta", AGENT_MODEL: "fixture" }, run,
            configure: async () => ({ model: {}, modelSettings: {}, close: async () => {} }) }, ...options });
    const create = input => manager.command("task-create", { prompt: "Read the page", mode: "browser", scope, tabId: 12, ...input });
    return { manager, records, scope, profileId, create, advance: ms => { clock += ms; }, disable: () => { tabs = []; } };
}
async function complete(options) {
    await options.extraTools.find(tool => tool.name === "complete_task").invoke(new RunContext(), JSON.stringify({ summary: "Read page", evidence: "Observed current title and content" }));
    return { answer: "Read page", history: [{ role: "assistant", content: "Read page" }] };
}

test("scheduler waits without model calls, enforces enabled tab and records explicit completion", async () => {
    let calls = 0;
    const ui = setup(async (_prompt, options) => { calls++; return complete(options); });
    await ui.manager.connected({ scope: ui.scope, profileId: ui.profileId });
    await ui.create({ notBefore: 2000 });
    assert.equal(calls, 0);
    ui.advance(1000); ui.disable();
    await ui.manager.tick();
    assert.equal(calls, 0);
    assert.equal([...ui.records.values()][0].status, "waiting-for-tab");
    await ui.manager.close();

    const live = setup(async (_prompt, options) => complete(options));
    await live.manager.connected({ scope: live.scope });
    await live.create();
    await until(() => [...live.records.values()][0]?.status === "completed");
    const job = [...live.records.values()][0];
    assert.equal(job.evidence, "Observed current title and content");
    assert.equal(live.manager.snapshot().status, "completed");
    await live.manager.close();
});

test("concurrent tabs run independently while same-tab tasks queue and cancellation is durable", async () => {
    const releases = new Map(), starts = [];
    const ui = setup(async (_prompt, options) => {
        starts.push(options.targetTabId);
        await new Promise(resolve => releases.set(options.targetTabId, resolve));
        return complete(options);
    });
    await ui.manager.connected({ scope: ui.scope });
    await ui.create(); await ui.create(); await ui.create({ tabId: 34 });
    await until(() => starts.length === 2);
    assert.deepEqual(starts, [12, 34]);
    const queued = [...ui.records.values()].find(record => record.status === "queued");
    await ui.manager.command("task-cancel", { taskId: queued.id, scope: ui.scope });
    releases.get(12)(); releases.get(34)();
    await until(() => !ui.manager.active);
    await ui.manager.tick();
    assert.equal(starts.length, 2);
    assert.equal(ui.records.get(queued.id).status, "cancelled");
    await ui.manager.close();
});

test("turn/final-answer limits continue with tool history and never claim completion", async () => {
    const histories = [];
    const ui = setup(async (_prompt, options) => {
        histories.push(options.history);
        return { answer: "Still working", continuation: true, history: [{ role: "assistant", content: "Observed step" }] };
    });
    await ui.manager.connected({ scope: ui.scope });
    await ui.create({ maxStages: 2 });
    await until(() => !ui.manager.active);
    assert.equal(histories.length, 2);
    assert.equal(histories[1][0].content, "Observed step");
    assert.equal([...ui.records.values()][0].status, "paused");
    await ui.manager.close();
});

test("rotated tab namespace requires explicit rebind and isolates other browser profiles", async () => {
    const ui = setup(async (_prompt, options) => complete(options));
    await ui.manager.connected({ scope: ui.scope, profileId: ui.profileId });
    await ui.create({ notBefore: 9000 });
    const old = [...ui.records.values()][0];
    await ui.manager.connected({ scope: randomUUID(), profileId: ui.profileId });
    assert.equal(ui.manager.snapshot().jobs[0].needsRebind, true);
    await ui.manager.command("task-resume", { taskId: old.id, tabId: 34 });
    await until(() => !ui.manager.active);
    const rebound = [...ui.records.values()].find(record => record.resumedFrom === old.id);
    assert.equal(rebound.tabId, 34);
    assert.notEqual(rebound.scope, old.scope);
    assert.equal(ui.records.get(old.id).status, "cancelled");
    await ui.manager.connected({ scope: randomUUID(), profileId: randomUUID() });
    assert.equal(ui.manager.snapshot().jobs.length, 0);
    await ui.manager.close();
});

test("coordinator creates disabled research tabs, waits for scoped approval and collects real worker results", async () => {
    const opened = [], grants = [], results = [];
    const invoke = (options, name, args) => options.extraTools.find(tool => tool.name === name).invoke(new RunContext(), JSON.stringify(args));
    const ui = setup(async (_prompt, options) => {
        if (options.targetTabId !== 12) {
            assert.equal(options.extraTools.some(tool => tool.name === "delegate_research"), false);
            return complete(options);
        }
        const ids = [];
        for (const url of ["https://example.com/a", "https://example.com/b"]) {
            const worker = JSON.parse(await invoke(options, "delegate_research", { url, task: "Read source and report evidence" }));
            ids.push(worker.workerId);
        }
        for (const workerId of ids) results.push(JSON.parse(await invoke(options, "collect_worker_result", { workerId })));
        return complete(options);
    }, { browser: async (method, _tabId, params) => {
        if (method === "tabs") return [{ id: 12 }];
        assert.equal(method, "open");
        const result = { tabId: 90 + opened.length, url: params.url, enabled: false };
        opened.push(result); return result;
    } });
    ui.manager.approveResearchTab = async input => { grants.push(input); };
    await ui.manager.connected({ scope: ui.scope });
    await ui.create();
    for (let i = 0; i < 2; i++) {
        await until(() => ui.manager.snapshot().requests.length === 1);
        assert.equal(grants.length, i);
        const request = ui.manager.snapshot().requests[0];
        assert.match(request.detail, /https:\/\/example.com/);
        await ui.manager.command("human-response", { id: request.id, runId: request.runId, scope: ui.scope, decision: "approve" });
    }
    await until(() => !ui.manager.active);
    assert.equal(grants.length, 2);
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.status === "completed" && result.evidence.includes("Observed")));
    assert.equal([...ui.records.values()].filter(record => record.role === "research").length, 2);
    await ui.manager.close();
});
