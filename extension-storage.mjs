import { z } from "zod";
import { historyDeleteQuery, historyExpireQuery, historyQuery, historyScopeConflict } from "./history-schema.mjs";
export { historyQuery } from "./history-schema.mjs";
export { taskInputSchema } from "./task-schema.mjs";

const uuid = z.string().uuid();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const recordSchema = z.object({
  id: uuid, scope: uuid, tabId: integer, prompt: z.string().trim().min(1).max(12000),
  mode: z.enum(["browser", "computer"]), createdAt: integer,
  status: z.enum(["queued", "scheduled", "running", "needs-input", "paused", "completed", "failed", "cancelled", "interrupted", "waiting-for-tab", "waiting-for-worker", "waiting-for-slot", "continuing"])
}).passthrough();
const recordsSchema = z.array(recordSchema).superRefine((records, ctx) => {
  if (new Set(records.map(item => item.id)).size !== records.length) ctx.addIssue({ code: "custom", message: "Duplicate task ID" });
});
const interrupted = new Set(["running", "needs-input", "paused", "waiting-for-worker", "waiting-for-slot", "continuing"]);
const pending = new WeakMap();
const clone = value => structuredClone(value);
const json = value => JSON.parse(JSON.stringify(value));
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

// All adapters in the owning runtime share a queue per storage area. Chrome's
// storage API is persistent but has no compare-and-swap or transaction API.
function queue(storage, operation) {
  const result = (pending.get(storage) ?? Promise.resolve()).then(operation);
  const settled = result.catch(() => {});
  pending.set(storage, settled);
  void settled.then(() => { if (pending.get(storage) === settled) pending.delete(storage); });
  return result;
}
function validateStorage(storage) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") throw new TypeError("A Chrome storage area is required.");
}

export class ExtensionTaskStore {
  constructor(storage, { sanitize = value => value, key = "extension.tasks.v1", maxBytes = 2 * 1024 * 1024 } = {}) {
    validateStorage(storage);
    if (typeof sanitize !== "function") throw new TypeError("sanitize must be a function");
    this.storage = storage; this.sanitize = sanitize; this.key = key; this.maxBytes = maxBytes; this.initialized = false;
  }
  async read() {
    const stored = (await this.storage.get(this.key))[this.key];
    return stored === undefined ? [] : recordsSchema.parse(clone(stored));
  }
  async write(records) {
    const cleaned = recordsSchema.parse(await Promise.all(records.map(async record => {
      const next = recordSchema.parse(await this.sanitize(clone(record)));
      if (next.id !== record.id || next.scope !== record.scope || next.tabId !== record.tabId) throw new Error("Sanitizer cannot change task identity");
      return next;
    })));
    const persisted = recordsSchema.parse(json(cleaned));
    if (bytes({ [this.key]: persisted }) > this.maxBytes) throw new Error("Extension task storage is full. Existing tasks have been preserved.");
    await this.storage.set({ [this.key]: persisted });
    return clone(persisted);
  }
  async readAndRecover() {
    let records = await this.read();
    if (!this.initialized) {
      if (records.some(record => interrupted.has(record.status))) records = await this.write(records.map(record => interrupted.has(record.status) ? { ...record, status: "interrupted", interruption: "runtime-restarted" } : record));
      this.initialized = true;
    }
    return records;
  }
  load() { return queue(this.storage, () => this.readAndRecover()); }
  async upsert(record) {
    const candidate = recordSchema.parse(clone(record));
    return queue(this.storage, async () => {
      const records = await this.readAndRecover();
      const index = records.findIndex(existing => existing.id === candidate.id);
      if (index >= 0) {
        if (records[index].scope !== candidate.scope || records[index].tabId !== candidate.tabId) throw new Error("An existing task cannot move to another scope or tab");
        records[index] = candidate;
      } else records.push(candidate);
      return (await this.write(records)).find(item => item.id === candidate.id);
    });
  }
}

const metaSchema = z.object({
  scope: uuid, tabId: integer, runId: uuid, startedAt: integer, endedAt: integer.optional(),
  status: z.string(), eventCount: integer.optional()
}).passthrough();
const eventSchema = z.object({ id: uuid, time: integer }).passthrough();
const eventsSchema = z.array(eventSchema);
const artifactSchema = z.object({ data: z.string(), mimeType: z.enum(["image/png", "image/jpeg"]) }).strict();

export class ExtensionTraceHistory {
  constructor(storage, { env = {}, secrets = [], key = "extension.history.v1.",
    maxBytes = storage?.kind === "indexeddb" ? Infinity : 8 * 1024 * 1024, legacyStorage } = {}) {
    validateStorage(storage);
    this.storage = storage; this.key = key; this.maxBytes = maxBytes;
    this.queueKey = storage.historyQueueKey ?? storage;
    this.legacyStorage = legacyStorage;
    this.incremental = storage.kind === "indexeddb";
    this.env = { ...env, ...Object.fromEntries(secrets.map((value, index) => [`HISTORY_${index}_SECRET`, value])) };
    this.revision = 0;
  }
  clean(value) {
    if (typeof value === "string") {
      for (const [name, secret] of Object.entries(this.env)) {
        if (/(?:API_KEY|TOKEN|SECRET)$/.test(name) && typeof secret === "string" && secret.trim().length >= 8) value = value.replaceAll(secret.trim(), "[redacted]");
      }
      return value.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/([?&](?:key|api_key|access_token)=)[^&\s"']+/gi, "$1[redacted]");
    }
    if (Array.isArray(value)) return value.map(item => this.clean(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(authorization|apiKey|token|password)$/i.test(key) ? "[redacted]" : this.clean(item)]));
    return value;
  }
  changed() { this.revision++; this.onChange?.(); }
  path(scope, tabId, runId) {
    uuid.parse(scope); integer.parse(tabId);
    return `${this.key}${scope}.tab-${tabId}.` + (runId ? `${uuid.parse(runId)}.` : "");
  }
  rememberScope(scope, profileId) {
    return queue(this.queueKey, async () => {
      const browserScope = uuid.parse(scope).toLowerCase(), profile = uuid.parse(profileId).toLowerCase();
      const ownerKey = this.key + "scope-owner." + browserScope;
      const profileKey = this.key + "profile-scopes." + profile;
      const records = await this.storage.get([ownerKey, profileKey]);
      const owner = uuid.optional().parse(records[ownerKey]);
      if (owner && owner !== profile) throw historyScopeConflict();
      const scopes = z.array(uuid).parse(records[profileKey] ?? []);
      if (owner === profile && scopes.includes(browserScope)) return;
      await this.write({ [ownerKey]: profile, [profileKey]: [...new Set([...scopes, browserScope])] });
    });
  }
  scopesForProfile(profileId) {
    return queue(this.queueKey, async () => {
      const profile = uuid.parse(profileId).toLowerCase(), profileKey = this.key + "profile-scopes." + profile;
      const scopes = z.array(uuid).parse((await this.storage.get(profileKey))[profileKey] ?? []);
      if (!scopes.length) return scopes;
      const ownerKey = scope => this.key + "scope-owner." + scope;
      const owners = await this.storage.get(scopes.map(ownerKey));
      return scopes.filter(scope => owners[ownerKey(scope)] === profile);
    });
  }
  // Writes include images, events and metadata in one call. Reject at the
  // namespace limit before touching existing data; storage failures propagate.
  async write(updates) {
    if (Number.isFinite(this.maxBytes)) {
      const all = await this.storage.get(null);
      const own = Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith(this.key)));
      const next = { ...own, ...json(updates) };
      if (bytes(next) > this.maxBytes) throw new Error("Extension history storage is full. Existing history has been preserved.");
    }
    await this.storage.set(updates);
  }
  start(record) {
    return queue(this.queueKey, async () => {
      const path = this.path(record.scope, record.tabId, record.runId);
      if ((await this.storage.get(path + "meta"))[path + "meta"] !== undefined) throw new Error("History run already exists.");
      const meta = metaSchema.parse(this.clean({ ...record, bridgeSessionId: record.bridgeSessionId ?? this.bridgeSessionId,
        task: record.task?.slice(0, 200), startedAt: Date.now(),
        status: "running", eventCount: this.incremental ? 0 : undefined }));
      const updates = { [path + "meta"]: json(meta) };
      if (!this.incremental) updates[path + "events"] = [];
      await this.write(updates);
      this.changed(); return clone(meta);
    });
  }
  async getRun(context, { missing = false } = {}) {
    const path = this.path(context.scope, context.tabId, context.runId);
    const raw = (await this.storage.get(path + "meta"))[path + "meta"];
    if (raw === undefined && missing) return null;
    if (raw === undefined) throw new Error("History run not found for this tab.");
    const run = metaSchema.parse(clone(raw));
    if (run.scope !== context.scope || run.tabId !== context.tabId || run.runId !== context.runId) throw new Error("History identity does not match its storage key.");
    return run;
  }
  async readEvents(path) {
    const stored = (await this.storage.get(path + "events"))[path + "events"];
    return stored === undefined ? [] : eventsSchema.parse(clone(stored));
  }
  append(context, event) {
    return queue(this.queueKey, async () => {
      const run = await this.getRun(context);
      const path = this.path(context.scope, context.tabId, context.runId), updates = {};
      const extract = value => {
        if (value && typeof value === "object" && typeof value.data === "string" && /^image\/(jpeg|png)$/.test(value.mimeType)) {
          const artifactId = crypto.randomUUID();
          updates[path + "image." + artifactId] = artifactSchema.parse({ data: value.data, mimeType: value.mimeType });
          const { data, ...rest } = value;
          return { ...rest, artifactId };
        }
        if (Array.isArray(value)) return value.map(extract);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, extract(item)]));
        return value;
      };
      const next = eventSchema.parse(json(this.clean(extract({ id: crypto.randomUUID(), time: Date.now(), ...clone(event) }))));
      if (run.eventCount === undefined) {
        const events = await this.readEvents(path);
        updates[path + "events"] = [...events, next];
      } else {
        updates[path + "event." + run.eventCount] = next;
        updates[path + "meta"] = { ...run, eventCount: run.eventCount + 1 };
      }
      await this.write(updates); this.changed();
    });
  }
  finish(context, status) {
    return queue(this.queueKey, async () => {
      const path = this.path(context.scope, context.tabId, context.runId), run = await this.getRun(context);
      await this.write({ [path + "meta"]: { ...run, status: z.string().parse(status), endedAt: Date.now() } });
      this.changed();
    });
  }
  recovered(run) { return { ...run, status: run.status === "running" && run.bridgeSessionId !== this.bridgeSessionId ? "interrupted" : run.status }; }
  async metadata(scope, tabId, storage = this.storage) {
    const prefix = tabId === undefined ? this.key + uuid.parse(scope) + "." : this.path(scope, tabId);
    const entries = storage.historyMetadata
      ? await storage.historyMetadata(prefix, scope, tabId)
      : Object.entries(await storage.get(null)).filter(([key]) => key.startsWith(prefix) && key.endsWith(".meta"));
    return entries.map(([key, raw]) => {
      const run = metaSchema.parse(raw);
      if (run.scope !== scope || (tabId !== undefined && run.tabId !== tabId) ||
        key !== this.path(scope, run.tabId, run.runId) + "meta") throw new Error("History identity does not match its storage key.");
      return run;
    });
  }
  list(query) {
    return queue(this.queueKey, async () => {
      const { scope, tabId, offset = 0 } = historyQuery.parse(query);
      const runs = (await this.metadata(scope, tabId)).map(run => this.recovered(run));
      runs.sort((a, b) => b.startedAt - a.startedAt || b.runId.localeCompare(a.runId));
      return { runs: runs.slice(offset, offset + 30), nextOffset: runs.length > offset + 30 ? offset + 30 : null };
    });
  }
  events(query) {
    return queue(this.queueKey, async () => {
      const context = historyQuery.parse(query), { scope, tabId, runId, offset = 0 } = context;
      if (!runId) throw new Error("Choose a history run.");
      const run = this.recovered(await this.getRun(context)), path = this.path(scope, tabId, runId);
      let items, total = run.eventCount;
      if (total === undefined) {
        const all = await this.readEvents(path);
        total = all.length;
        items = all.slice(offset, offset + 30);
      } else {
        const keys = Array.from({ length: Math.max(0, Math.min(30, total - offset)) }, (_, i) => path + "event." + (offset + i));
        const stored = keys.length ? await this.storage.get(keys) : {};
        items = keys.map(key => eventSchema.parse(stored[key]));
      }
      const events = []; let size = 0;
      for (const item of items) {
        const length = bytes(item);
        if (events.length && size + length > 1024 * 1024) break;
        events.push(item); size += length;
      }
      const cursor = offset + events.length;
      return { events, nextOffset: cursor < total ? cursor : null, run };
    });
  }
  artifact(query) {
    return queue(this.queueKey, async () => {
      const context = historyQuery.parse(query), { scope, tabId, runId, artifactId } = context;
      if (!runId || !artifactId) throw new Error("Choose a history image.");
      await this.getRun(context);
      const key = this.path(scope, tabId, runId) + "image." + artifactId;
      const raw = (await this.storage.get(key))[key];
      if (raw === undefined) throw new Error("History image not found in this tab and run.");
      return artifactSchema.parse(clone(raw));
    });
  }
  async removePaths(storage, paths) {
    if (!paths.length) return 0;
    if (storage.removeHistoryRuns) return storage.removeHistoryRuns(paths);
    const keys = Object.keys(await storage.get(null)).filter(key => paths.some(path => key.startsWith(path)));
    if (keys.length) await storage.remove(keys);
    return keys.length;
  }
  async purge(paths) {
    // Migration keeps the previous Chrome-local data as a backup. Remove its
    // copies first so a failed database deletion can be retried from History.
    const copies = this.legacyStorage ? await this.removePaths(this.legacyStorage, paths) : 0;
    return copies + await this.removePaths(this.storage, paths);
  }
  remove(query) {
    return queue(this.queueKey, async () => {
      const context = historyDeleteQuery.parse(query);
      const run = await this.getRun(context, { missing: true });
      if (run && this.recovered(run).status === "running") throw new Error("An active History run cannot be deleted.");
      const deleted = await this.purge([this.path(context.scope, context.tabId, context.runId)]) > 0;
      if (deleted) this.changed();
      return { deleted };
    });
  }
  expire(query) {
    return queue(this.queueKey, async () => {
      const { scope, before } = historyExpireQuery.parse(query);
      const runs = await this.metadata(scope);
      const paths = runs.filter(run => this.recovered(run).status !== "running" && (run.endedAt ?? run.startedAt) < before)
        .map(run => this.path(scope, run.tabId, run.runId));
      if (await this.purge(paths)) this.changed();
      return { deleted: paths.length };
    });
  }
}
