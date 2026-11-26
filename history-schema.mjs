import { z } from "zod";
const uuid = z.string().uuid();
const tab = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const historyQuery = z
  .object({
    tabId: tab,
    scope: uuid,
    runId: uuid.optional(),
    offset: z.number().int().nonnegative().optional(),
    artifactId: uuid.optional(),
  })
  .strict();

export const historyDeleteQuery = z.object({ scope: uuid, tabId: tab, runId: uuid }).strict();
export const historyExpireQuery = z.object({
  scope: uuid,
  before: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export function historyScopeConflict() {
  return Object.assign(new Error("This History scope belongs to another browser profile."), {
    code: "HISTORY_SCOPE_CONFLICT",
  });
}
