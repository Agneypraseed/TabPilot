import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { ExtensionDatabaseStorage, migrateExtensionData } from '../extension-database.mjs';
import { ExtensionTaskStore } from '../extension-storage.mjs';

const marker = 'extension.database.migration.v1';
function fixture(t, options = {}) {
    const indexedDB = options.indexedDB ?? new IDBFactory();
    const database = new ExtensionDatabaseStorage({ indexedDB, name: 'test-' + randomUUID(), ...options });
    t.after(() => database.close());
    return { database, indexedDB };
}
const local = values => ({ async get(key) { assert.equal(key, null); return structuredClone(values); } });
const task = (extra = {}) => ({ id: randomUUID(), scope: randomUUID(), tabId: 12, prompt: 'Observe the test page', mode: 'browser', status: 'running', createdAt: Date.now(), ...extra });
const requestDone = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

test('IndexedDB adapter persists Chrome-compatible get/set/remove and isolates caller data', async t => {
    const { database, indexedDB } = fixture(t);
    assert.equal(database.kind, 'indexeddb');
    const input = { one: { text: 'first' }, two: [1, 2] };
    const write = database.set(input); input.one.text = 'caller changed'; await write;
    assert.deepEqual(await database.get('one'), { one: { text: 'first' } });
    assert.deepEqual(await database.get(['two', 'missing']), { two: [1, 2] });
    const snapshot = await database.get(null); snapshot.one.text = 'changed return';
    await database.close();
    const reopened = new ExtensionDatabaseStorage({ indexedDB, name: database.name }); t.after(() => reopened.close());
    assert.deepEqual(await reopened.get(null), { one: { text: 'first' }, two: [1, 2] });
    await reopened.remove('one'); await reopened.remove(['two', 'missing']);
    assert.deepEqual(await reopened.get(null), {});
    await assert.rejects(reopened.set({ bad: () => {} }), /could not be stored/);
    assert.throws(() => reopened.get(12), /keys must be strings/);
});

test('IndexedDB serializes callers and atomically aborts multi-key writes on quota failure', async t => {
    const { database, indexedDB } = fixture(t);
    const other = new ExtensionDatabaseStorage({ indexedDB, name: database.name }); t.after(() => other.close());
    await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? other : database).set({ ['key' + index]: index })));
    assert.equal(Object.keys(await database.get(null)).length, 40);
    await database.set({ existing: 'before' });
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
        if (key === 'fail-quota') throw new DOMException('Test quota', 'QuotaExceededError');
        return original.call(this, value, key);
    };
    try { await assert.rejects(database.set({ existing: 'after', 'fail-quota': 'rejected' }), /storage quota is full/); }
    finally { IDBObjectStore.prototype.put = original; }
    assert.equal((await database.get('existing')).existing, 'before');
    assert.deepEqual(await database.get('fail-quota'), {});
    await database.set({ afterFailure: true });
    assert.equal((await database.get('afterFailure')).afterFailure, true);
});

test('migration copies only legacy task/history keys, preserves originals and never replaces DB records', async t => {
    const { database } = fixture(t);
    const legacy = { 'extension.tasks.v1': [task()], 'extension.history.v1.old.meta': { title: 'legacy' }, 'extension.history.v1.image': { data: 'legacy-image' }, extensionCredentials: { OPENAI_API_KEY: 'not-for-database' }, historyScope: randomUUID() };
    const before = structuredClone(legacy);
    await database.set({ 'extension.history.v1.old.meta': { title: 'database wins' } });
    assert.deepEqual(await migrateExtensionData(local(legacy), database), { migrated: true, copied: 2 });
    assert.deepEqual(legacy, before);
    const data = await database.get(null);
    assert.deepEqual(data['extension.tasks.v1'], legacy['extension.tasks.v1']);
    assert.equal(data['extension.history.v1.old.meta'].title, 'database wins');
    assert.equal(data['extension.history.v1.image'].data, 'legacy-image');
    assert.equal(data.extensionCredentials, undefined); assert.equal(data.historyScope, undefined);
    assert.equal(data[marker].version, 1);
    await database.set({ 'extension.tasks.v1': [task({ status: 'completed' })] });
    assert.deepEqual(await migrateExtensionData({ get: () => assert.fail('Completed migration must not reread Chrome storage') }, database), { migrated: false, copied: 0 });
    assert.equal((await database.get('extension.tasks.v1'))['extension.tasks.v1'][0].status, 'completed');
});

test('migration marker and all copied values commit atomically and retry safely after failure', async t => {
    const { database } = fixture(t);
    await database.set({ existing: 'preserved' });
    const legacy = { 'extension.tasks.v1': [task()], 'extension.history.v1.fail': { value: 'history' } };
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
        if (key === 'extension.history.v1.fail') throw new DOMException('Test quota', 'QuotaExceededError');
        return original.call(this, value, key);
    };
    try { await assert.rejects(migrateExtensionData(local(legacy), database), /storage quota is full/); }
    finally { IDBObjectStore.prototype.put = original; }
    assert.deepEqual(await database.get(null), { existing: 'preserved' });
    assert.deepEqual(await migrateExtensionData(local(legacy), database), { migrated: true, copied: 2 });
    assert.equal((await database.get(marker))[marker].version, 1);
    assert.deepEqual(Object.keys(legacy), ['extension.tasks.v1', 'extension.history.v1.fail']);
});

test('migration and concurrent writes serialize without overwriting a later saved value', async t => {
    const { database } = fixture(t);
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const migrate = migrateExtensionData({ async get() { entered(); await barrier; return { 'extension.tasks.v1': ['legacy'] }; } }, database);
    await started;
    const update = database.set({ 'extension.tasks.v1': ['newer'] });
    release(); await Promise.all([migrate, update]);
    assert.deepEqual((await database.get('extension.tasks.v1'))['extension.tasks.v1'], ['newer']);
});

test('near-full Chrome legacy checkpoint migrates and larger than 2MiB tasks persist with restart recovery', async t => {
    const { database } = fixture(t);
    const legacyTask = task({ checkpoint: { text: 'x'.repeat(1900 * 1024) } });
    const legacy = { 'extension.tasks.v1': [legacyTask] };
    await migrateExtensionData(local(legacy), database);
    const store = new ExtensionTaskStore(database, { maxBytes: Infinity });
    const migrated = await store.load();
    assert.equal(migrated[0].status, 'interrupted');
    assert.equal(migrated[0].checkpoint.text.length, 1900 * 1024);
    const large = task({ checkpoint: { text: 'y'.repeat(3 * 1024 * 1024) } });
    await store.upsert(large);
    assert.ok(JSON.stringify((await database.get('extension.tasks.v1'))['extension.tasks.v1']).length > 2 * 1024 * 1024);
    await database.close();
    const restored = await new ExtensionTaskStore(database, { maxBytes: Infinity }).load();
    assert.equal(restored.length, 2);
    assert.equal(restored[1].status, 'interrupted');
    assert.equal(restored[1].checkpoint.text.length, 3 * 1024 * 1024);
    assert.equal(legacy['extension.tasks.v1'][0].status, 'running', 'Legacy Chrome record remains untouched');
});

test('legacy read failure or incompatible database version never mark migration complete', async t => {
    const { database, indexedDB } = fixture(t);
    await assert.rejects(migrateExtensionData({ async get() { throw new Error('Chrome storage unavailable'); } }, database), /original data has been preserved/);
    assert.deepEqual(await database.get(null), {});
    const name = 'newer-' + randomUUID();
    const newer = await requestDone(indexedDB.open(name, 2)); newer.close();
    const older = new ExtensionDatabaseStorage({ indexedDB, name }); t.after(() => older.close());
    await assert.rejects(older.get(null), /newer TabPilot version/);
});

test('blocked database open times out safely and a later open can succeed without deleting records', async t => {
    const indexedDB = new IDBFactory(), name = 'blocked-' + randomUUID();
    const initial = indexedDB.open(name, 1);
    initial.onupgradeneeded = () => initial.result.createObjectStore('records');
    const held = await requestDone(initial);
    const deletion = indexedDB.deleteDatabase(name);
    const blocked = new Promise(resolve => { deletion.onblocked = resolve; });
    await blocked;
    const database = new ExtensionDatabaseStorage({ indexedDB, name, openTimeoutMs: 20 }); t.after(() => database.close());
    await assert.rejects(database.get(null), /timed out/);
    held.close(); await requestDone(deletion);
    // The previously timed-out open request is aborted during upgrade; a fresh
    // request must work after it settles, without resetting an existing store.
    await new Promise(resolve => setTimeout(resolve, 20));
    await database.set({ afterBlockedOpen: 'saved' });
    assert.deepEqual(await database.get(null), { afterBlockedOpen: 'saved' });
});
