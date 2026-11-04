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
    scroll: z.object({ ref: ref.optional(), deltaY: z.number().min(-10000).max(10000).optional(), deltaX: z.number().min(-10000).max(10000).optional() }).strict(),
    navigate: z.object({ url: z.string().url().max(4000) }).strict(),
    back: z.object({}).strict(),
    forward: z.object({}).strict(),
    reload: z.object({}).strict(),
    focus: z.object({}).strict(),
    open: z.object({ url: z.string().url().max(4000), active: z.boolean().optional() }).strict(),
    close: z.object({}).strict(),
    wait: z.object({ text: z.string().min(1).max(1000).optional(), timeoutMs: z.number().int().min(100).max(10000).optional() }).strict(),
    dialog: z.object({ accept: z.boolean(), promptText: z.string().max(1000).optional() }).strict(),
    screenshot: z.object({}).strict(),
    coordinate: z.object({ screenshotId: z.string().min(1).max(100), kind: z.enum(["click", "hover", "drag"]).optional(),
        x: z.number().nonnegative(), y: z.number().nonnegative(), toX: z.number().nonnegative().optional(), toY: z.number().nonnegative().optional(),
        button: z.enum(["left", "right", "middle"]).optional(), clickCount: z.number().int().min(1).max(2).optional() }).strict()
};
export const commandSchema = z.discriminatedUnion("method", Object.entries(actionParameters)
    .map(([method, params]) => z.object({ method: z.literal(method), ...tab, params }).strict()));

export const parseBrowserCommand = value => commandSchema.parse(value);

export const commandDescriptions = {
    click: "Click a current element ref. Returns a fresh snapshot; use its refs for the next action.",
    hover: "Move the pointer over an element ref, for example to reveal a menu.",
    fill: "Replace an editable element's contents with exact text. Uses trusted keyboard input and returns fresh page state.",
    select: "Select option values in a native select element. Discover values from snapshot elements[].options.",
    press: "Press a key or shortcut, e.g. Enter, Tab, Escape, ArrowDown, or Control+a. Optional ref focuses a target first.",
    scroll: "Scroll the page or a referenced scrollable element by CSS pixel deltas. Positive deltaY scrolls down.",
    navigate: "Navigate an enabled tab to an absolute HTTP/HTTPS URL and observe the resulting page. Access remains tied to this tab.",
    back: "Go back in an enabled tab's web-page history.",
    forward: "Go forward in an enabled tab's web-page history.",
    reload: "Reload an enabled tab and return its current page state.",
    focus: "Activate an enabled tab and focus its Chrome window.",
    open: "Open a URL in a NEW DISABLED tab, from an enabled source tab. The user must enable the new tab before any reading or control. Prefer navigate for uninterrupted work in the current enabled tab.",
    close: "Close an explicitly enabled tab and revoke its permission. Use only when the user requested closing it.",
    wait: "Wait up to timeoutMs (maximum 10000) for the document and optional visible text, then return a snapshot. Useful after asynchronous updates.",
    dialog: "Accept or dismiss an open JavaScript alert, confirm, or prompt. Optional promptText answers a prompt. Inspect the snapshot dialog and follow the user's intent before accepting.",
    screenshot: "Capture the current viewport of an enabled tab as a JPEG image. Returns screenshotId and image dimensions for coordinate actions.",
    coordinate: "Click, hover, or drag using IMAGE PIXEL coordinates from a recent browser_screenshot. Supply its screenshotId; capture again after any page/scroll change. For drag supply toX/toY. Prefer element refs when available."
};

export const mcpActionName = method => method === "coordinate" ? "browser_pointer" : `browser_${method}`;
