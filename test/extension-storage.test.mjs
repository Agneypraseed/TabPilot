import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ExtensionTaskStore, ExtensionTraceHistory, taskInputSchema, historyQuery } from '../extension-storage.mjs';

function storage(initial = {}) {
  let data = structuredClone(initial), fail = false;
  return {
    async get(keys) {
      await new Promise(resolve => setImmediate(resolve));
      if (keys === null) return structuredClone(data);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])]));
    },
    async set(updates) {
      await new Promise(resolve => setImmediate(resolve));
      if (fail) { fail = false; throw new Error('Storage quota exceeded'); }
      data = { ...data, ...structuredClone(updates) };
    },
    failNext() { fail = true; },
    snapshot() { return structuredClone(data); }
  };
}
const record = (extra = {}) => ({ id: randomUUID(), scope: randomUUID(), tabId: 12, prompt: 'Read the test page', mode: 'browser', createdAt: Date.now(), status: 'queued', ...extra });
const context = () => ({ scope: randomUUID(), tabId: 12, runId: randomUUID() });

test('extension tasks preserve identities and caller snapshots across concurrent writes and reopen', async () => {
  const area = storage(), one = new ExtensionTaskStore(area), two = new ExtensionTaskStore(area);
  await Promise.all([one.load(), two.load()]);
  const records = Array.from({ length: 35 }, () => record());
  const writes = records.map((item, index) => (index % 2 ? one : two).upsert(item));
  records[0].prompt = 'Caller changed after submission';
  await Promise.all(writes);
  const reopened = await new ExtensionTaskStore(area).load();
  assert.equal(reopened.length, 35);
  assert.equal(new Set(reopened.map(item => item.id)).size, 35);
  assert.equal(reopened[0].prompt, 'Read the test page');
  await assert.rejects(one.upsert({ ...reopened[0], scope: randomUUID() }), /cannot move/);
  await assert.rejects(one.upsert({ ...reopened[0], tabId: 99 }), /cannot move/);
  reopened[0].prompt = 'Mutated return';
  assert.equal((await one.load())[0].prompt, 'Read the test page');
});

test('extension restart interrupts pending actions without replaying queued or scheduled work', async () => {
  const area = storage(), store = new ExtensionTaskStore(area);
  const unsafe = ['running', 'needs-input', 'paused', 'waiting-for-worker', 'waiting-for-slot', 'continuing'];
  const safe = ['queued', 'scheduled', 'waiting-for-tab', 'completed', 'failed', 'cancelled', 'interrupted'];
  for (const status of [...unsafe, ...safe]) await store.upsert(record({ status, checkpoint: { stage: 2 } }));
  assert.equal((await store.load())[0].status, 'running');
  const reopened = new ExtensionTaskStore(area), records = await reopened.load();
  assert.deepEqual(records.map(item => item.status), [...unsafe.map(() => 'interrupted'), ...safe]);
  await reopened.upsert({ ...records[0], status: 'running' });
  assert.equal((await reopened.load())[0].status, 'running');
  assert.equal(records[0].checkpoint.stage, 2);
});

test('invalid tasks, corruption, sanitizers and storage limits never replace existing records', async () => {
  const area = storage(), store = new ExtensionTaskStore(area);
  const input = record(); await store.upsert(input);
  await assert.rejects(store.upsert({ ...input, status: 'invented' }));
  const bad = new ExtensionTaskStore(area, { sanitize: value => ({ ...value, id: randomUUID() }) });
  await assert.rejects(bad.upsert(record()), /cannot change task identity/);
  const capped = new ExtensionTaskStore(area, { maxBytes: 10 });
  await assert.rejects(capped.upsert(record()), /storage is full/);
  area.failNext(); await assert.rejects(store.upsert(record()), /quota/);
  assert.deepEqual(await store.load(), [input]);
  await store.upsert(record()); assert.equal((await store.load()).length, 2);
  await area.set({ 'extension.tasks.v1': [input, input] });
  await assert.rejects(new ExtensionTaskStore(area).load(), /Duplicate task ID/);
  assert.equal(area.snapshot()['extension.tasks.v1'].length, 2);
});

test('extension task/history adapters reuse portable strict input schemas', () => {
  const scope = randomUUID();
  assert.equal(taskInputSchema.parse({ scope, tabId: 0, prompt: ' Test ' }).prompt, 'Test');
  assert.equal(taskInputSchema.safeParse({ scope, tabId: -1, prompt: 'Test' }).success, false);
  assert.equal(historyQuery.safeParse({ scope, tabId: 0, extra: true }).success, false);
});

test('extension history persists redacted timelines and scoped screenshot artifacts across reopen', async () => {
  const area = storage(), store = new ExtensionTraceHistory(area, { env: { OPENAI_API_KEY: 'private-api-secret' }, secrets: ['pairing-secret'] });
  store.bridgeSessionId = 'first'; const ctx = context();
  await store.start({ ...ctx, bridgeSessionId: 'first', task: 'Test task' });
  await store.append(ctx, { kind: 'tool', result: { text: 'private-api-secret pairing-secret sk-abc123 https://test/?key=secret', token: 'hidden', image: { mimeType: 'image/png', data: btoa('test-image') } } });
  await store.finish(ctx, 'completed');
  const reopened = new ExtensionTraceHistory(area); reopened.bridgeSessionId = 'second';
  assert.equal((await reopened.list(ctx)).runs[0].status, 'completed');
  assert.equal((await reopened.list({ ...ctx, tabId: 99 })).runs.length, 0);
  assert.equal((await reopened.list({ ...ctx, scope: randomUUID() })).runs.length, 0);
  const event = (await reopened.events(ctx)).events[0];
  assert.equal(event.result.text, '[redacted] [redacted] [redacted] https://test/?key=[redacted]');
  assert.equal(event.result.token, '[redacted]');
  assert.equal(event.result.image.data, undefined);
  const image = await reopened.artifact({ ...ctx, artifactId: event.result.image.artifactId });
  assert.equal(atob(image.data), 'test-image'); assert.equal(image.mimeType, 'image/png');
  await assert.rejects(reopened.artifact({ ...ctx, tabId: 99, artifactId: event.result.image.artifactId }), /not found/);
  await assert.rejects(reopened.events({ ...ctx, runId: '../escape' }));
  const dump = JSON.stringify(area.snapshot());
  assert.ok(!dump.includes('private-api-secret')); assert.ok(!dump.includes('pairing-secret'));
});

test('extension histories serialize concurrent appends, paginate beyond feed cap and recover interrupted runs', async () => {
  const area = storage(), store = new ExtensionTraceHistory(area), other = new ExtensionTraceHistory(area);
  store.bridgeSessionId = 'current'; other.bridgeSessionId = 'current';
  const ctx = context(); await store.start({ ...ctx, bridgeSessionId: 'current' });
  await Promise.all(Array.from({ length: 185 }, (_, index) => (index % 2 ? store : other).append(ctx, { kind: 'status', text: `Step ${index}` })));
  const all = []; let offset = 0;
  do { const page = await store.events({ ...ctx, offset }); all.push(...page.events); offset = page.nextOffset; } while (offset !== null);
  assert.equal(all.length, 185); assert.equal(new Set(all.map(item => item.id)).size, 185);
  assert.equal((await store.events(ctx)).run.status, 'running');
  const reopened = new ExtensionTraceHistory(area); reopened.bridgeSessionId = 'new';
  assert.equal((await reopened.list(ctx)).runs[0].status, 'interrupted');
  assert.equal((await reopened.events(ctx)).run.status, 'interrupted');
  const contexts = Array.from({ length: 32 }, () => ({ ...ctx, runId: randomUUID() }));
  for (const next of contexts) await reopened.start({ ...next, bridgeSessionId: 'new' });
  const first = await reopened.list(ctx), second = await reopened.list({ ...ctx, offset: first.nextOffset });
  assert.equal(first.runs.length, 30); assert.equal(first.nextOffset, 30); assert.equal(second.runs.length, 3); assert.equal(second.nextOffset, null);
});

test('extension history storage failures and namespace cap preserve old records and keep queues usable', async () => {
  const area = storage(), store = new ExtensionTraceHistory(area), ctx = context();
  await store.start(ctx); await store.append(ctx, { text: 'Existing event' });
  const before = area.snapshot();
  const limited = new ExtensionTraceHistory(area, { maxBytes: 10 });
  await assert.rejects(limited.append(ctx, { text: 'Rejected' }), /storage is full/);
  assert.deepEqual(area.snapshot(), before);
  area.failNext(); await assert.rejects(store.append(ctx, { text: 'Quota failure' }), /quota/);
  assert.deepEqual(area.snapshot(), before);
  await store.append(ctx, { text: 'After failure' });
  assert.equal((await store.events(ctx)).events.length, 2);
  await assert.rejects(store.start(ctx), /already exists/);
});
