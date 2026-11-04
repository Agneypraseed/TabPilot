import { readFile } from "node:fs/promises";
import { parseBrowserCommand } from "./commands.mjs";
import { randomUUID } from "node:crypto";
import { taskCommandSchema } from "./task-commands.mjs";
const clientSession = randomUUID();

export async function requestTask(command) {
    const input = taskCommandSchema.parse(command);
    const config = await loadBridgeConfig();
    const response = await fetch(config.url + "/tasks", { method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(input), signal: AbortSignal.timeout(25000) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error ?? "Task command failed.");
    return result.data;
}

export async function loadBridgeConfig() {
    let config;
    try {
        config = JSON.parse(await readFile(new URL(".tabpilot/bridge.json", import.meta.url), "utf8"));
    } catch {
        throw new Error("Start the local bridge with npm start first.");
    }
    // Never send the token to a different host from a modified configuration file.
    if (config?.url !== "http://127.0.0.1:4311" || typeof config.token !== "string") {
        throw new Error("Invalid bridge configuration. Restart the bridge.");
    }
    return config;
}

export async function requestBridge(command, tabId, params = {}, { source = "cli" } = {}) {
    const action = command !== "tabs" && command !== "snapshot" ? parseBrowserCommand({ method: command, tabId, params }) : null;
    if (command === "snapshot" && (!Number.isSafeInteger(tabId) || tabId < 0)) {
        throw new Error("Invalid tab ID.");
    }
    // Reload for each call so an MCP process picks up tokens after server restarts.
    const config = await loadBridgeConfig();
    const path = action ? "/command" : command === "tabs" ? "/tabs" : `/snapshot/${tabId}`;
    let response;
    try {
        response = await fetch(config.url + path, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.token}`, "X-TabPilot-Source": source, "X-TabPilot-Client": clientSession,
                ...(process.env.TABPILOT_RUN_ID ? { "X-TabPilot-Run": process.env.TABPILOT_RUN_ID } : {}), ...(action ? { "Content-Type": "application/json" } : {}) },
            ...(action ? { body: JSON.stringify(action) } : {}),
            signal: AbortSignal.timeout(25000),
            redirect: "error"
        });
    } catch {
        throw new Error("Cannot reach the local bridge. Check npm start and reconnect the extension.");
    }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error ?? "Bridge request failed.");
    return result.data;
}
