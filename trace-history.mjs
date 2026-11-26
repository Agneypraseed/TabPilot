import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  lstat,
  readdir,
  rename,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { formatAgentError } from "./agent-models.mjs";

const uuid = z.string().uuid();
const tab = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scopeRegistry = z.record(uuid, uuid);
const scopeUpdates = new Map();
import { historyDeleteQuery, historyExpireQuery, historyQuery, historyScopeConflict } from "./history-schema.mjs";
export { historyQuery } from "./history-schema.mjs";

async function directories(folder) {
  try {
    return (await readdir(folder, { withFileTypes: true })).filter(entry => entry.isDirectory());
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Images are separate files so browsing a timeline does not load screenshots.
export class TraceHistory {
  constructor(root, { env = {}, secrets = [] } = {}) {
    this.root = resolve(root);
    this.env = {
      ...env,
      ...Object.fromEntries(
        secrets.map((value, i) => [`HISTORY_${i}_SECRET`, value]),
      ),
    };
    this.pending = Promise.resolve();
    this.revision = 0;
  }
  path(scope, tabId, runId) {
    uuid.parse(scope);
    tab.parse(tabId);
    return join(
      this.root,
      scope,
      `tab-${tabId}`,
      ...(runId ? [uuid.parse(runId)] : []),
    );
  }
  queue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  async readScopeRegistry() {
    const file = join(this.root, ".scope-profiles.json");
    try {
      if (!(await lstat(file)).isFile()) throw new Error("History scope registry is unavailable.");
      return scopeRegistry.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }
  rememberScope(scope, profileId) {
    const operation = (scopeUpdates.get(this.root) ?? Promise.resolve()).then(async () => {
      const browserScope = uuid.parse(scope).toLowerCase(), profile = uuid.parse(profileId).toLowerCase();
      const scopes = await this.readScopeRegistry();
      const owner = scopes[browserScope];
      if (owner && owner !== profile) throw historyScopeConflict();
      if (owner === profile) return;
      scopes[browserScope] = profile;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const file = join(this.root, ".scope-profiles.json");
      const temporary = file + `.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(scopes), { flag: "wx", mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
    });
    const settled = operation.catch(() => {});
    scopeUpdates.set(this.root, settled);
    void settled.then(() => { if (scopeUpdates.get(this.root) === settled) scopeUpdates.delete(this.root); });
    return operation;
  }
  async scopesForProfile(profileId) {
    const profile = uuid.parse(profileId).toLowerCase();
    await scopeUpdates.get(this.root);
    return Object.entries(await this.readScopeRegistry()).filter(([, owner]) => owner === profile).map(([scope]) => scope);
  }
  clean(value) {
    if (typeof value === "string")
      return formatAgentError({ message: value }, this.env);
    if (Array.isArray(value)) return value.map((item) => this.clean(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          /^(authorization|apiKey|token|password)$/i.test(key)
            ? "[redacted]"
            : this.clean(item),
        ]),
      );
    return value;
  }
  changed() {
    this.revision++;
    this.onChange?.();
  }
  start(record) {
    return this.queue(async () => {
      const folder = this.path(record.scope, record.tabId, record.runId);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const meta = this.clean({
        ...record,
        bridgeSessionId: record.bridgeSessionId ?? this.bridgeSessionId,
        task: record.task?.slice(0, 200),
        startedAt: Date.now(),
        status: "running",
      });
      await writeFile(join(folder, "meta.json"), JSON.stringify(meta), {
        flag: "wx",
        mode: 0o600,
      });
      this.changed();
      return meta;
    });
  }
  append(context, event) {
    return this.queue(async () => {
      const folder = this.path(context.scope, context.tabId, context.runId);
      // Extract only known image shapes, never arbitrary paths from callers.
      const extract = async (value) => {
        if (
          value &&
          typeof value === "object" &&
          typeof value.data === "string" &&
          /^image\/(jpeg|png)$/.test(value.mimeType)
        ) {
          const artifactId = randomUUID();
          const extension = value.mimeType === "image/png" ? "png" : "jpg";
          await writeFile(
            join(folder, `${artifactId}.${extension}`),
            Buffer.from(value.data, "base64"),
            { flag: "wx", mode: 0o600 },
          );
          const { data, ...rest } = value;
          return { ...rest, artifactId };
        }
        if (Array.isArray(value)) return Promise.all(value.map(extract));
        if (value && typeof value === "object")
          return Object.fromEntries(
            await Promise.all(
              Object.entries(value).map(async ([key, item]) => [
                key,
                await extract(item),
              ]),
            ),
          );
        return value;
      };
      const record = this.clean(
        await extract({ id: randomUUID(), time: Date.now(), ...event }),
      );
      await appendFile(
        join(folder, "events.jsonl"),
        JSON.stringify(record) + "\n",
        { mode: 0o600 },
      );
      this.changed();
    });
  }
  finish(context, status) {
    return this.queue(async () => {
      const file = join(
        this.path(context.scope, context.tabId, context.runId),
        "meta.json",
      );
      const meta = JSON.parse(await readFile(file, "utf8"));
      const temporary = file + `.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ ...meta, status, endedAt: Date.now() }),
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporary, file);
      this.changed();
    });
  }
  isActive(run) {
    return run?.status === "running" && run.bridgeSessionId === this.bridgeSessionId;
  }
  async metadata(scope, tabId) {
    const folder = this.path(scope, tabId), runs = [];
    for (const entry of await directories(folder)) {
      if (!uuid.safeParse(entry.name).success) continue;
      let run;
      try {
        run = JSON.parse(await readFile(join(folder, entry.name, "meta.json"), "utf8"));
        if (run?.scope !== scope || run.tabId !== tabId || run.runId !== entry.name ||
            typeof run.status !== "string" || !Number.isSafeInteger(run.startedAt) ||
            (run.endedAt !== undefined && !Number.isSafeInteger(run.endedAt))) throw new SyntaxError("Invalid History metadata");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        if (!(error instanceof SyntaxError)) throw error;
        run = { scope, tabId, runId: entry.name, task: "History entry could not be read",
          status: "unavailable", startedAt: 0 };
      }
      runs.push(run);
    }
    return runs;
  }
  async list(query) {
    return this.queue(async () => {
      const { scope, tabId, offset = 0 } = historyQuery.parse(query);
      // A previous bridge process can no longer own a running task.
      const runs = (await this.metadata(scope, tabId)).map(run =>
        run.status === "running" && !this.isActive(run) ? { ...run, status: "interrupted" } : run);
      runs.sort(
        (a, b) => b.startedAt - a.startedAt || b.runId.localeCompare(a.runId),
      );
      return {
        runs: runs.slice(offset, offset + 30),
        nextOffset: runs.length > offset + 30 ? offset + 30 : null,
      };
    });
  }
  async events(query) {
    return this.queue(async () => {
      const { scope, tabId, runId, offset = 0 } = historyQuery.parse(query);
      if (!runId) throw new Error("Choose a history run.");
      let run;
      try {
        run = JSON.parse(
          await readFile(
            join(this.path(scope, tabId, runId), "meta.json"),
            "utf8",
          ),
        );
      } catch (error) {
        if (error.code === "ENOENT")
          throw new Error("History run not found for this tab.");
        throw error;
      }
      if (run.status === "running" && !this.isActive(run))
        run.status = "interrupted";
      const stream = createReadStream(
        join(this.path(scope, tabId, runId), "events.jsonl"),
        { encoding: "utf8" },
      );
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      const events = [];
      let index = 0,
        bytes = 0,
        nextOffset = null;
      try {
        for await (const line of lines) {
          if (index++ < offset) continue;
          if (
            events.length >= 30 ||
            (events.length && bytes + line.length > 1024 * 1024)
          ) {
            nextOffset = index - 1;
            break;
          }
          events.push(JSON.parse(line));
          bytes += line.length;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      } finally {
        lines.close();
        stream.destroy();
      }
      return { events, nextOffset, run };
    });
  }
  async artifact(query) {
    return this.queue(async () => {
      const { scope, tabId, runId, artifactId } = historyQuery.parse(query);
      if (!runId || !artifactId) throw new Error("Choose a history image.");
      for (const [extension, mimeType] of [
        ["jpg", "image/jpeg"],
        ["png", "image/png"],
      ]) {
        try {
          return {
            data: (
              await readFile(
                join(
                  this.path(scope, tabId, runId),
                  `${artifactId}.${extension}`,
                ),
              )
            ).toString("base64"),
            mimeType,
          };
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      throw new Error("History image not found in this tab and run.");
    });
  }
  async deleteRunFolder({ scope, tabId, runId }) {
    const folder = this.path(scope, tabId, runId);
    let target, physicalRoot;
    try {
      [target, physicalRoot] = await Promise.all([realpath(folder), realpath(this.root)]);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    const expected = resolve(physicalRoot, relative(this.root, folder));
    if (relative(expected, target) !== "") throw new Error("History directory changed. Refresh History before deleting.");
    let run;
    try {
      run = JSON.parse(await readFile(join(target, "meta.json"), "utf8"));
    } catch (error) {
      // Allow removing a corrupt run or retrying a partially deleted folder.
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (this.isActive(run)) throw new Error("An active History run cannot be deleted.");
    await rm(target, { recursive: true, force: true });
    return true;
  }
  remove(query) {
    return this.queue(async () => {
      const deleted = await this.deleteRunFolder(historyDeleteQuery.parse(query));
      if (deleted) this.changed();
      return { deleted };
    });
  }
  expire(query) {
    return this.queue(async () => {
      const { scope, before } = historyExpireQuery.parse(query);
      let deleted = 0;
      try {
        for (const entry of await directories(join(this.root, scope))) {
          const tabId = Number(entry.name.slice(4));
          if (!tab.safeParse(tabId).success || entry.name !== `tab-${tabId}`) continue;
          for (const run of await this.metadata(scope, tabId)) {
            if (run.status === "unavailable" || this.isActive(run) ||
                (run.endedAt ?? run.startedAt) >= before) continue;
            if (await this.deleteRunFolder(run)) deleted++;
          }
        }
      } finally {
        if (deleted) this.changed();
      }
      return { deleted };
    });
  }
}
