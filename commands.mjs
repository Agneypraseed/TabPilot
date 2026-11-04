import { z } from "zod";

const tabId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ref = z.string().min(1).max(100);
const tab = { tabId };
const downloadId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const downloadUrl = z.string().max(4000).refine(value => {
    try { const url = new URL(value); return /^https?:\/\//i.test(value) && /^https?:$/.test(url.protocol)
        && !url.username && !url.password && !/[\u0000-\u0020\u007f-\u009f]/.test(value); } catch { return false; }
}, "Use an absolute HTTP(S) URL without embedded credentials.");
const downloadFilename = z.string().min(1).max(1000).refine(value =>
    !/[\u0000-\u001f\u007f-\u009f<>:"|?*\\]/.test(value) && value.split("/").every(part =>
        part && part !== "." && part !== ".." && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
"Use a safe relative Downloads path with forward slashes, or saveAs for another location.");
export const actionParameters = {
    download: z.object({ url: downloadUrl, filename: downloadFilename.optional(), saveAs: z.boolean().optional() }).strict(),
    "download-status": z.object({ downloadId }).strict(),
    "download-cancel": z.object({ downloadId }).strict(),
    "download-local": z.object({ url: downloadUrl, filename: downloadFilename.optional() }).strict(),
    "download-local-status": z.object({ downloadId: z.string().uuid() }).strict(),
    "download-local-cancel": z.object({ downloadId: z.string().uuid() }).strict(),
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
    "download-local": "Explicitly download a PUBLIC page link through the local bridge into the user's configured local folder. No browser cookies or credentials are forwarded. Requires enabled originating tab; never use this automatically after a canceled native download. Returns a job ID; use browser_download_local_status to verify completion.",
    "download-local-status": "Read progress and final path for a bridge-local download belonging to this enabled tab. A started job does not prove completion.",
    "download-local-cancel": "Cancel a bridge-local download belonging to this enabled tab. Completed files are not deleted.",
    download: "Start an HTTP(S) file download from an enabled tab. filename is a relative path under Chrome Downloads; saveAs opens Chrome's native destination chooser. Existing files are uniquified. A returned ID means started, not complete: check browser_download_status. Never repeat a start just because status is unavailable; Chrome retains danger prompts.",
    "download-status": "Inspect only a download started for this enabled tab. Returns Chrome state, final filename and danger/error details when available. Only state=complete verifies completion.",
    "download-cancel": "Cancel only a download started for this enabled tab, then inspect its current state.",
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
    open: "Open a URL in a new web tab from an accessible source tab. New web tabs have access by default; user revocations and Chrome-protected pages remain blocked.",
    close: "Close an accessible web tab. Use only when the user requested closing it.",
    wait: "Wait up to timeoutMs (maximum 10000) for the document and optional visible text, then return a snapshot. Useful after asynchronous updates.",
    dialog: "Accept or dismiss an open JavaScript alert, confirm, or prompt. Optional promptText answers a prompt. Inspect the snapshot dialog and follow the user's intent before accepting.",
    screenshot: "Capture the current viewport of an enabled tab as a JPEG image. Returns screenshotId and image dimensions for coordinate actions.",
    coordinate: "Click, hover, or drag using IMAGE PIXEL coordinates from a recent browser_screenshot. Supply its screenshotId; capture again after any page/scroll change. For drag supply toX/toY. Prefer element refs when available."
};

export const mcpActionName = method => method === "coordinate" ? "browser_pointer" : `browser_${method.replaceAll("-", "_")}`;
