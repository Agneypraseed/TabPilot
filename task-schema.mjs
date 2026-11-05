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
