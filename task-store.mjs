import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const uuid = z.string().uuid();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const prompt = z.string().trim().min(1).max(12000);
const mode = z.enum(["browser", "computer"]);
export const taskInputSchema = z.object({
  scope: uuid,
  profileId: uuid.optional(),
  tabId: integer,
  tabTitle: z.string().max(500).optional(),
  prompt,
  mode: mode.default("browser"),
  notBefore: integer.default(() => Date.now()),
  repeatEveryMs: z.number().int().min(60000).max(30 * 24 * 60 * 60 * 1000).nullable().optional(),
  maxStages: z.number().int().min(1).max(200).default(20),
  allowResearch: z.boolean().default(true),
}).strict();

const recordSchema = z.object({
  id: uuid,
  scope: uuid,
  tabId: integer,
  prompt,
  mode,
  status: z.enum([
    "queued", "scheduled", "running", "needs-input", "paused", "completed",
    "failed", "cancelled", "interrupted", "waiting-for-tab", "waiting-for-worker",
    "waiting-for-slot", "continuing",
  ]),
  createdAt: integer,
}).passthrough();
const recordsSchema = z.array(recordSchema).superRefine((records, context) => {
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) context.addIssue({ code: "custom", message: "Duplicate task ID" });
    ids.add(record.id);
  }
});
const interruptedOnRestart = new Set([
  "running", "needs-input", "paused", "waiting-for-worker", "waiting-for-slot", "continuing",
]);
const pendingFiles = new Map();

// One queue per file also protects callers using multiple store objects. Records
// are read inside the queue, so concurrent writes cannot replace newer history.
export class TaskStore {
  constructor(filePath, { sanitize = value => value } = {}) {
    this.filePath = resolve(filePath);
    if (typeof sanitize !== "function") throw new TypeError("sanitize must be a function");
    this.sanitize = sanitize;
    this.initialized = false;
  }

  queue(operation) {
    const result = (pendingFiles.get(this.filePath) ?? Promise.resolve()).then(operation);
    const settled = result.catch(() => {});
    pendingFiles.set(this.filePath, settled);
    void settled.then(() => {
      if (pendingFiles.get(this.filePath) === settled) pendingFiles.delete(this.filePath);
    });
    return result;
  }

  async read() {
    let data;
    try { data = await readFile(this.filePath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return recordsSchema.parse(JSON.parse(data));
  }

  async write(records) {
    const cleaned = recordsSchema.parse(await Promise.all(records.map(async record => {
      const cleaned = recordSchema.parse(await this.sanitize(structuredClone(record)));
      if (cleaned.id !== record.id || cleaned.scope !== record.scope || cleaned.tabId !== record.tabId)
        throw new Error("Sanitizer cannot change task identity");
      return cleaned;
    })));
    // Validate the JSON representation too: custom metadata must round-trip.
    const json = JSON.stringify(cleaned, null, 2) + "\n";
    const persisted = recordsSchema.parse(JSON.parse(json));
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, json, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
    return persisted;
  }

  async readAndRecover() {
    let records = await this.read();
    if (!this.initialized) {
      if (records.some(record => interruptedOnRestart.has(record.status))) {
        records = await this.write(records.map(record => interruptedOnRestart.has(record.status)
          ? { ...record, status: "interrupted" } : record));
      }
      this.initialized = true;
    }
    return records;
  }

  load() {
    return this.queue(() => this.readAndRecover());
  }

  async upsert(record) {
    // Capture caller-owned metadata before waiting for other writes.
    const candidate = recordSchema.parse(structuredClone(record));
    return this.queue(async () => {
      const records = await this.readAndRecover();
      const index = records.findIndex(existing => existing.id === candidate.id);
      if (index >= 0) {
        const existing = records[index];
        if (existing.scope !== candidate.scope || existing.tabId !== candidate.tabId)
          throw new Error("An existing task cannot move to another scope or tab");
        records[index] = candidate;
      } else records.push(candidate);
      const persisted = await this.write(records);
      return persisted.find(item => item.id === candidate.id);
    });
  }
}
