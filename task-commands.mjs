import { z } from "zod";
import { taskInputSchema } from "./task-store.mjs";

const tabId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const taskCommandSchema = z.discriminatedUnion("method", [
    z.object({ method: z.literal("task-create"), payload: taskInputSchema.omit({ scope: true, profileId: true }) }).strict(),
    z.object({ method: z.literal("task-list"), payload: z.object({ tabId: tabId.optional() }).strict() }).strict(),
    z.object({ method: z.literal("task-cancel"), payload: z.object({ taskId: z.string().uuid() }).strict() }).strict(),
    z.object({ method: z.literal("task-resume"), payload: z.object({ taskId: z.string().uuid(), tabId }).strict() }).strict()
]);
