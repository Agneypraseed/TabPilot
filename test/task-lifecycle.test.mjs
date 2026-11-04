import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RunContext } from "@openai/agents";
import { TaskManager } from "../task-manager.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (check()) return;
    await flush();
  }
  assert.fail("Lifecycle did not settle");
}
const invoke = (options, name, args) => options.extraTools.find(tool => tool.name === name)
  .invoke(new RunContext(), JSON.stringify(args));
async function complete(options) {
  await invoke(options, "complete_task", { summary: "Verified fixture", evidence: "Observed fixture state" });
  return { answer: "Verified fixture", history: [] };
}
function fixture(t, { run = async () => ({ answer: "Still working", history: [] }), store, browser, maxConcurrent = 3 } = {}) {
  let clock = 1000;
  const persisted = new Map(), scope = randomUUID();
  const manager = new TaskManager({ autoTick: false, now: () => ++clock, maxConcurrent,
    store: store ?? { load: async () => [], upsert: async record => {
      const copy = structuredClone(record); persisted.set(copy.id, copy); return copy;
    } }, browser: browser ?? (async () => ({ tabs: [{ id: 12 }] })),
    serviceOptions: { env: {}, configure: async () => ({ model: {}, close: async () => {} }), run },
  });
  t.after(() => manager.close());
  const input = extra => ({ scope, tabId: 12, prompt: "Inspect fixture", mode: "browser", notBefore: 0,
    maxStages: 1, allowResearch: true, ...extra });
  const create = extra => manager.command("task-create", input(extra));
  return { manager, scope, persisted, input, create };
}

test("cancel during the stage upsert prevents any subsequent agent run", async t => {
  const reached = deferred(), release = deferred();
  let blocked = false, runs = 0;
  const { manager, scope, input } = fixture(t, { run: async () => { runs++; return { answer: "Unexpected", history: [] }; },
    store: { load: async () => [], upsert: async record => {
      const copy = structuredClone(record);
      if (!blocked && copy.stage === 1 && copy.status === "running") {
        blocked = true; reached.resolve(); await release.promise;
      }
      return copy;
    } },
  });
  await manager.connected({ scope });
  const created = await manager.create(input());
  const record = manager.records.get(created.id);
  const launching = manager.launch(record);
  try {
    await reached.promise;
    await manager.command("task-cancel", { taskId: record.id, scope });
  } finally { release.resolve(); }
  await launching;
  await until(() => !manager.active);
  assert.equal(runs, 0, "Canceled stage must not start a fresh agent run");
  assert.equal(manager.records.get(record.id).status, "cancelled");
});

test("disconnect while initial store load is pending cannot resurrect connection", async t => {
  const loading = deferred(); let reads = 0, runs = 0;
  const { manager, scope, input } = fixture(t, { store: { load: () => loading.promise, upsert: async record => structuredClone(record) },
    browser: async () => { reads++; return { tabs: [{ id: 12 }] }; },
    run: async () => { runs++; return { answer: "Unexpected", history: [] }; },
  });
  const connecting = manager.connected({ scope });
  manager.disconnect();
  loading.resolve([{ ...input(), id: randomUUID(), createdAt: 0, stage: 0, status: "queued" }]);
  await connecting;
  await flush();
  assert.ok(!manager.connection, "Disconnected connection must stay disconnected");
  assert.equal(reads, 0);
  assert.equal(runs, 0);
});

test("specialist delegation honors occupied global capacity before opening or granting a tab", async t => {
  let opened = 0, grants = 0, runs = 0;
  const { manager, scope, input } = fixture(t, { maxConcurrent: 1,
    browser: async method => {
      if (method === "tabs") return { tabs: [{ id: 12 }] };
      opened++; return { tabId: 90, url: "https://example.test/source", enabled: false };
    }, run: async () => { runs++; return { answer: "Unexpected worker", history: [] }; },
  });
  await manager.connected({ scope });
  const created = await manager.create(input());
  const record = manager.records.get(created.id);
  record.status = "running";
  manager.executing.add(record.id);
  manager.approveResearchTab = async () => { grants++; };
  const session = { checkpoint: async () => {}, controller: new AbortController(), requestHuman: async () => ({ decision: "approve" }), event: () => {} };
  try {
    const delegate = manager.coordinatorTools(record, session).find(tool => tool.name === "delegate_research");
    await delegate.invoke(new RunContext(), JSON.stringify({ url: "https://example.test/source", task: "Read source" })).catch(() => {});
    await flush();
    assert.equal(opened, 0, "No new research tab when capacity is exhausted");
    assert.equal(grants, 0);
    assert.equal(runs, 0);
  } finally { manager.executing.delete(record.id); }
});

test("exhausted paused task is not relaunched and cannot evict newer completed chat", async t => {
  let runs = 0;
  const { manager, scope, create } = fixture(t, { run: async (_prompt, options) => {
    runs++; return runs === 1 ? { answer: "Unfinished fixture", history: [] } : complete(options);
  } });
  await manager.connected({ scope });
  await create(); await until(() => !manager.active);
  const older = [...manager.records.values()][0];
  assert.equal(older.status, "paused");
  await create(); await until(() => !manager.active);
  const newer = [...manager.records.values()].find(record => record.id !== older.id);
  assert.equal(newer.status, "completed");
  const completedSession = manager.sessions.get(newer.id);
  assert.ok(completedSession);
  await manager.tick(); await until(() => !manager.active);
  assert.equal(manager.sessions.get(newer.id), completedSession, "Newest completed chat must remain selected and available");
  assert.equal(manager.snapshot().taskId, newer.id);
  assert.equal(manager.snapshot().status, "completed");
  assert.equal(runs, 2);
});

test("parallel specialist requests reserve the last slot and release it after denial", async t => {
  const openedGate = deferred(); let opened = 0;
  const { manager, scope, input } = fixture(t, { maxConcurrent: 2,
    browser: async method => {
      if (method === "tabs") return { tabs: [{ id: 12 }] };
      opened++;
      await openedGate.promise;
      return { tabId: 90, url: "https://example.test/source", enabled: false };
    },
  });
  await manager.connected({ scope });
  const created = await manager.create(input());
  const record = manager.records.get(created.id);
  record.status = "running";
  manager.executing.add(record.id);
  const session = { checkpoint: async () => {}, controller: new AbortController(), requestHuman: async () => ({ decision: "deny" }), event: () => {} };
  const delegate = manager.coordinatorTools(record, session).find(tool => tool.name === "delegate_research");
  const call = () => delegate.invoke(new RunContext(), JSON.stringify({ url: "https://example.test/source", task: "Read source" }));
  let requests;
  try {
    requests = [call(), call()];
    await until(() => opened > 0);
    await flush();
    assert.equal(opened, 1, "A pending approval must reserve the sole remaining slot");
  } finally { openedGate.resolve(); }
  try {
    await Promise.all(requests);
    await call();
    assert.equal(opened, 2, "Denied research must release its capacity reservation");
  } finally { manager.executing.delete(record.id); }
});

test("completion is rechecked when a pending worker appears after complete_task", async t => {
  let manager;
  const fixtureResult = fixture(t, { run: async (_prompt, options) => {
    await invoke(options, "complete_task", { summary: "Premature completion", evidence: "Fixture observation" });
    const parent = [...manager.records.values()].find(record => record.tabId === 12);
    await manager.create({ ...manager.input(parent), tabId: 99, prompt: "Pending specialist", notBefore: 0 },
      { parentTaskId: parent.id, role: "research" });
    return { answer: "Premature completion", history: [] };
  } });
  manager = fixtureResult.manager;
  await manager.connected({ scope: fixtureResult.scope });
  await fixtureResult.create(); await until(() => !manager.active);
  const parent = [...manager.records.values()].find(record => record.tabId === 12);
  const child = [...manager.records.values()].find(record => record.parentTaskId === parent.id);
  assert.ok(child);
  assert.notEqual(child.status, "completed");
  assert.notEqual(parent.status, "completed", "New pending child invalidates earlier completion claim");
});
