import { loadBridgeConfig, requestBridge, requestTask } from "./bridge-client.mjs";
import { parseBrowserCommand } from "./commands.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = `Usage: node cli.mjs <command>
  pair | tabs
  snapshot TAB
  click TAB REF | hover TAB REF
  fill TAB REF TEXT | select TAB REF VALUE...
  press TAB KEY [REF] | scroll TAB DELTA_Y [REF]
  navigate TAB URL | back TAB | forward TAB | reload TAB | focus TAB
  open SOURCE_TAB URL | close TAB
  wait TAB [TEXT] | dialog TAB accept|dismiss [PROMPT_TEXT]
  screenshot TAB [NEW_FILE.jpg]
  download TAB URL [RELATIVE_FILENAME] [--save-as]
  download-status TAB DOWNLOAD_ID | download-cancel TAB DOWNLOAD_ID
  download-local TAB PUBLIC_URL [RELATIVE_FILENAME]
  download-local-status TAB JOB_UUID | download-local-cancel TAB JOB_UUID
  task-list [TAB] | task-schedule TAB PROMPT [DELAY_SECONDS]
  task-cancel TASK_UUID | task-resume TASK_UUID TAB
  pointer TAB '{"screenshotId":"...","x":100,"y":200}'
  command TAB '{"method":"scroll","params":{"deltaY":500,"deltaX":0}}'
Web tabs have access by default. Revoked and protected tabs are blocked. Refs come from the latest snapshot.`;

async function main() {
    const [input, id, ...args] = process.argv.slice(2);
    if (["help", "--help", "-h"].includes(input)) { console.log(usage); return; }
    if (input?.startsWith("task-")) {
        let method = input, payload;
        const validTab = value => /^\d+$/.test(value ?? "") && Number.isSafeInteger(Number(value));
        if (input === "task-list") {
            if (args.length || (id !== undefined && !validTab(id))) throw new Error(usage);
            payload = id === undefined ? {} : { tabId: Number(id) };
        } else if (input === "task-schedule") {
            if (!validTab(id) || args.length < 1 || args.length > 2 || (args[1] !== undefined && !/^\d+$/.test(args[1]))) throw new Error(usage);
            const delay = Number(args[1] ?? 0);
            if (!Number.isSafeInteger(delay) || delay > 30 * 24 * 60 * 60) throw new Error("Delay must be 0–2592000 seconds.");
            method = "task-create";
            payload = { tabId: Number(id), prompt: args[0], mode: "browser", notBefore: Date.now() + delay * 1000 };
        } else if (input === "task-cancel") {
            if (args.length) throw new Error(usage);
            payload = { taskId: id };
        } else if (input === "task-resume") {
            if (args.length !== 1 || !validTab(args[0])) throw new Error(usage);
            payload = { taskId: id, tabId: Number(args[0]) };
        } else throw new Error(usage);
        console.log(JSON.stringify(await requestTask({ method, payload }), null, 2));
        return;
    }
    if (input === "pair" || input === "tabs") {
        if (id !== undefined) throw new Error(usage);
        if (input === "pair") console.log((await loadBridgeConfig()).token);
        else console.log(JSON.stringify(await requestBridge("tabs"), null, 2));
        return;
    }
    if (!/^\d+$/.test(id ?? "") || !Number.isSafeInteger(Number(id))) throw new Error(usage);
    const tabId = Number(id);
    let method = input, params = {}, output;
    const count = (min, max = min) => { if (args.length < min || args.length > max) throw new Error(usage); };
    if (method === "download-local") {
        count(1, 2);
        params = { url: args[0], ...(args[1] ? { filename: args[1] } : {}) };
    }
    else if (["download-local-status", "download-local-cancel"].includes(method)) {
        count(1); params = { downloadId: args[0] };
    }
    else if (method === "download") {
        count(1, 3);
        const saveAs = args.at(-1) === "--save-as";
        const values = saveAs ? args.slice(0, -1) : args;
        if (values.length < 1 || values.length > 2 || values.some(value => value.startsWith("--"))) throw new Error(usage);
        params = { url: values[0], ...(values[1] !== undefined ? { filename: values[1] } : {}), ...(saveAs ? { saveAs: true } : {}) };
    }
    else if (["download-status", "download-cancel"].includes(method)) {
        count(1);
        if (!/^\d+$/.test(args[0])) throw new Error(usage);
        params = { downloadId: Number(args[0]) };
    }
    else if (["click", "hover"].includes(method)) { count(1); params = { ref: args[0] }; }
    else if (method === "fill") { count(2); params = { ref: args[0], text: args[1] }; }
    else if (method === "select") { count(2, 101); params = { ref: args[0], values: args.slice(1) }; }
    else if (method === "press") { count(1, 2); params = { key: args[0], ...(args[1] ? { ref: args[1] } : {}) }; }
    else if (method === "scroll") { count(1, 2); params = { deltaY: Number(args[0]), ...(args[1] ? { ref: args[1] } : {}) }; }
    else if (["navigate", "open"].includes(method)) { count(1); params = { url: args[0] }; }
    else if (["snapshot", "back", "forward", "reload", "focus", "close"].includes(method)) count(0);
    else if (method === "screenshot") { count(0, 1); output = args[0]; }
    else if (method === "wait") { count(0, 1); params = args[0] ? { text: args[0] } : {}; }
    else if (method === "dialog") {
        count(1, 2);
        if (!["accept", "dismiss"].includes(args[0])) throw new Error(usage);
        params = { accept: args[0] === "accept", ...(args[1] ? { promptText: args[1] } : {}) };
    } else if (["pointer", "command"].includes(method)) {
        count(1);
        const json = JSON.parse(args[0]);
        if (method === "pointer") { method = "coordinate"; params = json; }
        else { method = json.method; params = json.params ?? {}; }
    } else throw new Error(usage);
    if (method !== "snapshot") parseBrowserCommand({ method, tabId, params });
    const data = await requestBridge(method, tabId, params);
    if (method === "screenshot") {
        const directory = new URL("./.tabpilot/screenshots/", import.meta.url);
        if (!output) await mkdir(directory, { recursive: true });
        const path = output ? resolve(output) : fileURLToPath(new URL(`${data.screenshotId}.jpg`, directory));
        await writeFile(path, Buffer.from(data.data, "base64"), { flag: "wx" });
        const { data: _image, ...metadata } = data;
        console.log(JSON.stringify({ ...metadata, path }, null, 2));
    } else console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
});
