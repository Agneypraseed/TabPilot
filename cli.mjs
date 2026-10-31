import { readFile } from "node:fs/promises";

async function main() {
    const [command, tabId, ...extra] = process.argv.slice(2);
    if (!['pair', 'tabs', 'snapshot'].includes(command) || extra.length ||
        (command === 'snapshot' ? !/^\d+$/.test(tabId ?? '') : tabId !== undefined)) {
        throw new Error("Usage: node cli.mjs pair | tabs | snapshot <tab-id>");
    }
    let config;
    try {
        config = JSON.parse(await readFile(new URL(".tabpilot/bridge.json", import.meta.url), "utf8"));
    } catch {
        throw new Error("Start the local bridge with npm start first.");
    }
    // Do not send the token to a URL supplied by a modified configuration file.
    if (config.url !== "http://127.0.0.1:4311" || typeof config.token !== "string") {
        throw new Error("Invalid bridge configuration. Restart the bridge.");
    }
    if (command === "pair") {
        console.log(config.token);
        return;
    }
    const path = command === "tabs" ? "/tabs" : `/snapshot/${tabId}`;
    const response = await fetch(config.url + path, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(12000),
        redirect: "error"
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error ?? "Bridge request failed.");
    console.log(JSON.stringify(result.data, null, 2));
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
});
