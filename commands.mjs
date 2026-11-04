import { z } from "zod";

const tabId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ref = z.string().min(1).max(100);
const tab = { tabId };
export const actionParameters = {
    click: z.object({ ref, button: z.enum(["left", "right", "middle"]).optional(), clickCount: z.number().int().min(1).max(2).optional() }).strict(),
    hover: z.object({ ref }).strict(),
    fill: z.object({ ref, text: z.string().max(20000) }).strict(),
    select: z.object({ ref, values: z.array(z.string()).min(1).max(100) }).strict(),
    press: z.object({ ref: ref.optional(), key: z.string().min(1).max(80) }).strict(),
    scroll: z.object({ ref: ref.optional(), deltaY: z.number().min(-10000).max(10000).optional(), deltaX: z.number().min(-10000).max(10000).optional() }).strict()
};
export const commandSchema = z.discriminatedUnion("method", Object.entries(actionParameters)
    .map(([method, params]) => z.object({ method: z.literal(method), ...tab, params }).strict()));

export const parseBrowserCommand = value => commandSchema.parse(value);
