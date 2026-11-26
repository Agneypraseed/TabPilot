// Persistent task/history data lives outside Chrome storage.local's small quota.
// Credentials deliberately remain in Chrome's local/session settings stores.
const STORE = 'records';
const MIGRATION_KEY = 'extension.database.migration.v1';
const HISTORY_SCOPE = 'history-scope';
const HISTORY_TAB = 'history-tab';
const writers = new WeakMap();
const historyKeys = new WeakMap();

function databaseError(error) {
    if (error?.name === 'QuotaExceededError') return new Error('Browser task storage could not be saved because the device or browser storage quota is full. Free disk space and try again; existing records have been preserved.');
    if (error?.name === 'AbortError') return new Error('The browser task storage transaction was interrupted. Reopen TabPilot and review the task before retrying; existing records have been preserved.');
    if (error?.name === 'VersionError') return new Error('This task database was created by a newer TabPilot version. Reload the latest extension; saved records have not been changed.');
    if (error?.name === 'DataCloneError') return new Error('Task data could not be stored in the browser database. Existing records have been preserved.');
    return new Error('The browser task database is unavailable. Check browser storage permissions and available disk space, then reopen TabPilot. Saved records have not been replaced.');
}
function keysOf(value) {
    const keys = Array.isArray(value) ? value : [value];
    if (keys.some(key => typeof key !== 'string')) throw new TypeError('Database keys must be strings.');
    return [...new Set(keys)];
}

export class ExtensionDatabaseStorage {
    constructor({ indexedDB = globalThis.indexedDB, name = 'tabpilot-data', openTimeoutMs = 10000 } = {}) {
        if (!indexedDB || typeof indexedDB.open !== 'function') throw new Error('This browser does not provide IndexedDB task storage. Use desktop Chrome or the optional Developer local server.');
        if (typeof name !== 'string' || !name || !Number.isFinite(openTimeoutMs) || openTimeoutMs <= 0) throw new TypeError('Invalid task database configuration.');
        this.kind = 'indexeddb';
        this.indexedDB = indexedDB;
        this.name = name;
        this.openTimeoutMs = openTimeoutMs;
        this.connection = null;
        this.opening = null;
        let names = historyKeys.get(indexedDB);
        if (!names) { names = new Map(); historyKeys.set(indexedDB, names); }
        if (!names.has(name)) names.set(name, {});
        this.historyQueueKey = names.get(name);
    }
    queue(operation) {
        let databases = writers.get(this.indexedDB);
        if (!databases) { databases = new Map(); writers.set(this.indexedDB, databases); }
        const result = (databases.get(this.name) ?? Promise.resolve()).then(operation);
        const settled = result.catch(() => {});
        databases.set(this.name, settled);
        void settled.then(() => { if (databases.get(this.name) === settled) databases.delete(this.name); });
        return result;
    }
    async open() {
        if (this.connection) return this.connection;
        if (!this.opening) this.opening = new Promise((resolve, reject) => {
            let request, settled = false;
            const finish = (error, database) => {
                if (settled) { database?.close(); return; }
                settled = true; clearTimeout(timer);
                if (error) reject(error);
                else {
                    this.connection = database;
                    database.onversionchange = () => { database.close(); if (this.connection === database) this.connection = null; };
                    database.onclose = () => { if (this.connection === database) this.connection = null; };
                    resolve(database);
                }
            };
            const timer = setTimeout(() => finish(new Error('Opening browser task storage timed out. Close other TabPilot windows and reopen the extension; saved records have not been changed.')), this.openTimeoutMs);
            try { request = this.indexedDB.open(this.name, 2); }
            catch (error) { finish(databaseError(error)); return; }
            request.onupgradeneeded = () => {
                if (settled) { request.transaction.abort(); return; }
                // Never recreate or clear an existing store during upgrades.
                const store = request.result.objectStoreNames.contains(STORE)
                    ? request.transaction.objectStore(STORE)
                    : request.result.createObjectStore(STORE);
                if (!store.indexNames.contains(HISTORY_SCOPE)) store.createIndex(HISTORY_SCOPE, 'scope');
                if (!store.indexNames.contains(HISTORY_TAB)) store.createIndex(HISTORY_TAB, ['scope', 'tabId']);
            };
            request.onblocked = () => finish(new Error('Browser task storage is blocked by another open TabPilot window. Close older extension windows and reopen TabPilot; saved records have not been changed.'));
            request.onerror = () => finish(databaseError(request.error));
            request.onsuccess = () => finish(null, request.result);
        }).finally(() => { this.opening = null; });
        return this.opening;
    }
    async transaction(mode, operation) {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            let transaction, result, failure;
            try { transaction = database.transaction(STORE, mode); }
            catch (error) { reject(databaseError(error)); return; }
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = () => reject(databaseError(transaction.error ?? failure));
            // The abort event owns the failure result. Do not prevent the error's
            // default abort: doing so could commit only part of a multi-key set.
            transaction.onerror = event => { failure ??= event.target?.error; };
            const guard = callback => event => { try { callback(event); } catch (error) { failure = error; transaction.abort(); } };
            try { operation(transaction.objectStore(STORE), value => { result = value; }, guard); }
            catch (error) { failure = error; transaction.abort(); }
        });
    }
    get(key) {
        const keys = key === null ? null : keysOf(key);
        return this.queue(() => this.transaction('readonly', (store, result) => {
            const found = {};
            if (keys === null) {
                const request = store.openCursor();
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) { result(found); return; }
                    Object.defineProperty(found, cursor.key, { value: cursor.value, enumerable: true, configurable: true, writable: true });
                    cursor.continue();
                };
            } else {
                result(found);
                for (const item of keys) {
                    const request = store.get(item);
                    request.onsuccess = () => {
                        if (request.result !== undefined) Object.defineProperty(found, item, { value: request.result, enumerable: true, configurable: true, writable: true });
                    };
                }
            }
        }));
    }
    set(items) {
        if (!items || typeof items !== 'object' || Array.isArray(items)) return Promise.reject(new TypeError('Database updates must be an object.'));
        // Capture caller-owned data before entering the queue, just as Chrome's
        // message transport does. Clone failures must not begin a transaction.
        let updates;
        try { updates = structuredClone(items); } catch (error) { return Promise.reject(databaseError(error)); }
        return this.queue(() => this.transaction('readwrite', store => {
            for (const [key, value] of Object.entries(updates)) store.put(value, key);
        }));
    }
    remove(key) {
        const keys = keysOf(key);
        return this.queue(() => this.transaction('readwrite', store => { for (const item of keys) store.delete(item); }));
    }
    historyMetadata(prefix, scope, tabId) {
        return this.queue(() => this.transaction('readonly', (store, result, guard) => {
            const records = [];
            result(records);
            const index = store.index(tabId === undefined ? HISTORY_SCOPE : HISTORY_TAB);
            const request = index.openKeyCursor(tabId === undefined ? scope : [scope, tabId]);
            request.onsuccess = guard(() => {
                const cursor = request.result;
                if (!cursor) return;
                const key = cursor.primaryKey;
                if (typeof key === 'string' && key.startsWith(prefix) && key.endsWith('.meta')) {
                    const entry = store.get(key);
                    entry.onsuccess = () => records.push([key, entry.result]);
                }
                cursor.continue();
            });
        }));
    }
    removeHistoryRuns(prefixes) {
        const ranges = keysOf(prefixes).sort();
        if (!ranges.length) return Promise.resolve(0);
        return this.queue(() => this.transaction('readwrite', (store, result, guard) => {
            let index = 0, deleted = 0;
            const request = store.openKeyCursor();
            request.onsuccess = guard(() => {
                const cursor = request.result;
                if (!cursor) { result(deleted); return; }
                const key = cursor.key;
                while (index < ranges.length && key > ranges[index] && !key.startsWith(ranges[index])) index++;
                const prefix = ranges[index];
                if (prefix === undefined) { result(deleted); return; }
                if (key < prefix) { cursor.continue(prefix); return; }
                store.delete(key);
                deleted++;
                cursor.continue();
            });
        }));
    }
    // Called only at runtime startup. The marker and every imported value commit
    // in the same transaction; existing database values always win over legacy.
    migrate(local) {
        return this.queue(async () => {
            const current = await this.transaction('readonly', (store, result) => {
                const request = store.get(MIGRATION_KEY); request.onsuccess = () => result(request.result);
            });
            if (current?.version === 1) return { migrated: false, copied: 0 };
            let all;
            try { all = await local.get(null); }
            catch { throw new Error('Existing Chrome task data could not be read for migration. Reopen TabPilot; the original data has been preserved.'); }
            const entries = Object.entries(all).filter(([key]) => key === 'extension.tasks.v1' || key.startsWith('extension.history.v1.'));
            return this.transaction('readwrite', (store, result, guard) => {
                // Recheck inside the write transaction in case another runtime
                // completed migration while the legacy storage read was pending.
                const marker = store.get(MIGRATION_KEY);
                marker.onsuccess = guard(() => {
                    if (marker.result?.version === 1) { result({ migrated: false, copied: 0 }); return; }
                    let remaining = entries.length, copied = 0;
                    const finish = () => {
                        store.put({ version: 1, copied, completedAt: Date.now() }, MIGRATION_KEY);
                        result({ migrated: true, copied });
                    };
                    if (!remaining) { finish(); return; }
                    for (const [key, value] of entries) {
                        const existing = store.getKey(key);
                        existing.onsuccess = guard(() => {
                            if (existing.result === undefined) { store.put(value, key); copied++; }
                            if (!--remaining) finish();
                        });
                    }
                });
            });
        });
    }
    close() {
        return this.queue(async () => { this.connection?.close(); this.connection = null; });
    }
}

export async function migrateExtensionData(local, database) {
    if (!local || typeof local.get !== 'function' || !(database instanceof ExtensionDatabaseStorage)) throw new TypeError('Chrome local storage and an extension database are required for migration.');
    return database.migrate(local);
}
