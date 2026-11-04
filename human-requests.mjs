import { randomUUID } from "node:crypto";
import { z } from "zod";

export const helpRequestSchema = z
  .object({
    kind: z.enum(["approval", "handoff", "information"]),
    question: z.string().trim().min(1).max(3000),
    detail: z.string().max(6000).optional(),
  })
  .strict();
const responseSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    scope: z.string().uuid().optional(),
    decision: z.enum(["approve", "deny", "done", "answer"]),
    text: z.string().max(12000).optional(),
  })
  .strict();

export class HumanRequests {
  constructor({ onChange = () => {}, lifetimeMs = 30 * 60 * 1000 } = {}) {
    this.requests = new Map();
    this.onChange = onChange;
    this.lifetimeMs = lifetimeMs;
  }
  list() {
    return [...this.requests.values()].map(({ request }) => ({ ...request }));
  }
  request(input, { signal, runId, tabId, scope } = {}) {
    signal?.throwIfAborted();
    const request = {
      ...helpRequestSchema.parse(input),
      id: randomUUID(),
      runId,
      tabId,
      scope,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.lifetimeMs,
    };
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        const entry = this.requests.get(request.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        signal?.removeEventListener("abort", abort);
        this.requests.delete(request.id);
        this.onChange();
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => finish(signal.reason ?? new Error("Task stopped."));
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "The request for user input expired. Review the task before resuming.",
            ),
          ),
        this.lifetimeMs,
      );
      this.requests.set(request.id, { request, timer, finish });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else this.onChange();
    });
  }
  respond(input) {
    const response = responseSchema.parse(input),
      entry = this.requests.get(response.id);
    if (
      !entry ||
      entry.request.runId !== response.runId ||
      entry.request.scope !== response.scope
    )
      throw new Error("This request is no longer pending for this task.");
    const allowed = {
      approval: ["approve", "deny"],
      handoff: ["done", "deny"],
      information: ["answer", "deny"],
    }[entry.request.kind];
    if (!allowed.includes(response.decision))
      throw new Error("Choose a response appropriate to this request.");
    if (response.decision === "answer" && !response.text?.trim())
      throw new Error("Enter the requested information.");
    entry.finish(null, {
      decision: response.decision,
      text: response.text?.trim() ?? "",
    });
    return { decision: response.decision };
  }
}

// Charge only active execution time. Human handoffs may take longer than a model
// stage without spending tokens or causing the waiting task to silently expire.
export class ActiveRunBudget {
  constructor(milliseconds, onExpire) {
    this.remaining = milliseconds;
    this.onExpire = onExpire;
    this.holds = 0;
    this.resume();
  }
  suspend() {
    if (this.holds++ === 0) {
      clearTimeout(this.timer);
      this.remaining = Math.max(
        0,
        this.remaining - (Date.now() - this.started),
      );
    }
  }
  resume() {
    if (this.holds > 0 && --this.holds > 0) return;
    this.started = Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(this.onExpire, this.remaining);
  }
  stop() {
    clearTimeout(this.timer);
  }
}
