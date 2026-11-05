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
