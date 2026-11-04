import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskStore, taskInputSchema } from "../task-store.mjs";

async function fixture(t) {
  const root = fileURLToPath(new URL("../.tabpilot/", import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "task-store-test-"));
  t.after(async () => {
    assert.equal(resolve(dirname(directory)), resolve(root));
    assert.ok(basename(directory).startsWith("task-store-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file: join(directory, "nested", "tasks.json") };
}
const record = (extra = {}) => ({
  id: randomUUID(), scope: randomUUID(), tabId: 12, prompt: "Check page",
  mode: "browser", status: "queued", createdAt: Date.now(), ...extra,
});

test("task input uses strict bounded fields and fresh defaults", () => {
  const base = { scope: randomUUID(), tabId: 0, prompt: "  Check page  " };
  const before = Date.now(), parsed = taskInputSchema.parse(base);
  assert.deepEqual({ mode: parsed.mode, prompt: parsed.prompt, maxStages: parsed.maxStages, allowResearch: parsed.allowResearch },
    { mode: "browser", prompt: "Check page", maxStages: 20, allowResearch: true });
  assert.ok(parsed.notBefore >= before && parsed.notBefore <= Date.now());
  assert.equal(taskInputSchema.parse({ ...base, profileId: randomUUID(), repeatEveryMs: null }).repeatEveryMs, null);
  for (const change of [
    { extra: 1 }, { profileId: "bad" }, { scope: "../escape" }, { tabId: -1 }, { tabId: 1.5 },
    { tabId: Number.MAX_SAFE_INTEGER + 1 }, { prompt: "  " }, { prompt: "x".repeat(12001) },
    { tabTitle: "x".repeat(501) }, { mode: "other" }, { notBefore: -1 },
    { repeatEveryMs: 59999 }, { repeatEveryMs: 30 * 86400000 + 1 },
    { maxStages: 0 }, { maxStages: 201 }, { allowResearch: "yes" },
  ]) assert.equal(taskInputSchema.safeParse({ ...base, ...change }).success, false, JSON.stringify(change).slice(0, 80));
});

test("roundtrip keeps isolated scopes, tab metadata, and complete history", async t => {
  const { file } = await fixture(t), store = new TaskStore(file);
  assert.deepEqual(await store.load(), []);
  const one = record({ status: "completed", role: "coordinator", model: "fixture", checkpoint: { history: ["prior result"] } });
  const two = record({ tabId: one.tabId, parentTaskId: one.id, role: "worker", profileId: randomUUID() });
  await store.upsert(one); await store.upsert(two);
  await store.upsert({ ...one, answer: "Verified" });
  const tasks = await new TaskStore(file).load();
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0], { ...one, answer: "Verified" });
  assert.deepEqual(tasks[1], two);
  tasks[0].checkpoint.history.push("mutation");
  assert.deepEqual((await store.load())[0].checkpoint.history, ["prior result"]);
  await assert.rejects(store.upsert({ ...one, scope: two.scope }), /cannot move/);
  await assert.rejects(store.upsert({ ...one, tabId: 99 }), /cannot move/);
});

test("restart interrupts action-bearing states once and persists recovery", async t => {
  const { file } = await fixture(t), store = new TaskStore(file);
  const unsafe = ["running", "needs-input", "paused", "waiting-for-worker", "waiting-for-slot", "continuing"];
  const safe = ["queued", "scheduled", "waiting-for-tab", "completed", "failed", "cancelled", "interrupted"];
  for (const status of [...unsafe, ...safe]) await store.upsert(record({ status, checkpoint: { stage: 3 } }));
  assert.equal((await store.load())[0].status, "running");
  const reopened = new TaskStore(file), tasks = await reopened.load();
  assert.deepEqual(tasks.map(item => item.status), [...unsafe.map(() => "interrupted"), ...safe]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), tasks);
  await reopened.upsert({ ...tasks[0], status: "running" });
  assert.equal((await reopened.load())[0].status, "running");
});

test("concurrent writers serialize atomically without losing records or caller snapshots", async t => {
  const { directory, file } = await fixture(t);
  const store = new TaskStore(file), other = new TaskStore(file);
  await Promise.all([store.load(), other.load()]);
  const records = Array.from({ length: 40 }, () => record());
  const writes = records.map((item, index) => (index % 2 ? store : other).upsert(item));
  records[0].prompt = "Changed after submission";
  await Promise.all(writes);
  const tasks = JSON.parse(await readFile(file, "utf8"));
  assert.equal(tasks.length, 40);
  assert.equal(new Set(tasks.map(item => item.id)).size, 40);
  assert.equal(tasks[0].prompt, "Check page");
  assert.deepEqual(await readdir(join(directory, "nested")), ["tasks.json"]);
});

test("rejects malformed records and corrupted disk without overwriting history", async t => {
  const { file } = await fixture(t), store = new TaskStore(file);
  const valid = record(); await store.upsert(valid);
  for (const change of [{ id: "../escape" }, { scope: "bad" }, { tabId: -1 }, { status: "unknown" }, { mode: "bad" }, { prompt: "" }, { createdAt: -1 }])
    await assert.rejects(store.upsert({ ...valid, ...change }));
  assert.deepEqual(await store.load(), [valid]);
  await writeFile(file, JSON.stringify([valid, valid]));
  await assert.rejects(new TaskStore(file).load(), /Duplicate task ID/);
  await writeFile(file, "broken json");
  await assert.rejects(store.upsert(record()), SyntaxError);
  assert.equal(await readFile(file, "utf8"), "broken json");
});

test("sanitizer redacts persisted and returned metadata; rejected writes leave queue usable", async t => {
  const { file } = await fixture(t);
  const store = new TaskStore(file, { sanitize: value => ({ ...value, checkpoint: { text: "[redacted]" } }) });
  const input = record({ checkpoint: { text: "private-token" } });
  assert.equal((await store.upsert(input)).checkpoint.text, "[redacted]");
  assert.equal(input.checkpoint.text, "private-token");
  assert.ok(!(await readFile(file, "utf8")).includes("private-token"));
  const broken = new TaskStore(file, { sanitize: value => ({ ...value, id: randomUUID() }) });
  await assert.rejects(broken.upsert(record()), /cannot change task identity/);
  await store.upsert(record());
  assert.equal((await store.load()).length, 2);
});
