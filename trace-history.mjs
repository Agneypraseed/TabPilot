import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  readdir,
  rename,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { formatAgentError } from "./agent-models.mjs";

const uuid = z.string().uuid();
const tab = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
import { historyQuery } from "./history-schema.mjs";
export { historyQuery } from "./history-schema.mjs";

// Append-only local trace records. Images are separate files so browsing a
// timeline never loads every screenshot into memory or sends them to a model.
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
  async list(query) {
    return this.queue(async () => {
      const { scope, tabId, offset = 0 } = historyQuery.parse(query);
      const folder = this.path(scope, tabId);
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return { runs: [], nextOffset: null };
        throw error;
      }
      const runs = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !uuid.safeParse(entry.name).success)
          continue;
        let meta;
        try {
          meta = JSON.parse(
            await readFile(join(folder, entry.name, "meta.json"), "utf8"),
          );
        } catch (error) {
          if (error.code === "ENOENT") continue;
          if (error instanceof SyntaxError) {
            runs.push({
              scope,
              tabId,
              runId: entry.name,
              task: "History entry could not be read",
              status: "unavailable",
              startedAt: 0,
            });
            continue;
          }
          throw error;
        }
        // A previous bridge process can no longer own a running task.
        runs.push({
          ...meta,
          status:
            meta.status === "running" &&
            meta.bridgeSessionId !== this.bridgeSessionId
              ? "interrupted"
              : meta.status,
        });
      }
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
      if (
        run.status === "running" &&
        run.bridgeSessionId !== this.bridgeSessionId
      )
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
}
