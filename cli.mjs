import { loadBridgeConfig, requestBridge } from "./bridge-client.mjs";

async function main() {
    const [command, tabId, ...extra] = process.argv.slice(2);
    if (!['pair', 'tabs', 'snapshot'].includes(command) || extra.length ||
        (command === 'snapshot' ? !/^\d+$/.test(tabId ?? '') : tabId !== undefined)) {
        throw new Error("Usage: node cli.mjs pair | tabs | snapshot <tab-id>");
    }
    if (command === "pair") {
        const config = await loadBridgeConfig();
        console.log(config.token);
        return;
    }
    const data = await requestBridge(command, command === "snapshot" ? Number(tabId) : undefined);
    console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
});
