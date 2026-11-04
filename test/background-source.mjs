import { readFile } from "node:fs/promises";

export const backgroundSource = (await readFile(new URL("../attention-alerts.js", import.meta.url), "utf8")) + "\n" +
    (await readFile(new URL("../page-runtime.js", import.meta.url), "utf8")) + "\n" +
    (await readFile(new URL("../browser-controller.js", import.meta.url), "utf8")) + "\n" +
    (await readFile(new URL("../background.js", import.meta.url), "utf8")).replace(/importScripts\([^\n]+\);/g, "");

export function mockDebugger(chrome, evaluate) {
    chrome.debugger = {
        onDetach: { addListener() {} }, onEvent: { addListener() {} },
        attach: async () => {}, detach: async () => {},
        sendCommand: async (_target, method, params) => {
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
            if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
            if (method === "Runtime.evaluate") return { result: { value: await evaluate(params.expression) } };
            return {};
        }
    };
}
