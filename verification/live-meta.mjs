import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { createConfiguredModel, formatAgentError } from "../agent-models.mjs";
import { runBrowserAgent } from "../agent.mjs";
import { requestBridge } from "../bridge-client.mjs";

async function main() {
    loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
    const tab = (await requestBridge("tabs")).find(tab => tab.url.startsWith("http://127.0.0.1:4322/"));
    assert.ok(tab, "Open the practice server, pair the extension, and explicitly enable its tab first.");
    const state = async () => (await fetch("http://127.0.0.1:4322/api/state")).json();
    const baseline = await state();
    assert.equal(baseline.visualCompleted, false, "Restart npm run practice before repeating verification, to reset visual completion state.");
    const configured = await createConfiguredModel({ ...process.env, AGENT_PROVIDER: "meta", AGENT_MODEL: "muse-spark-1.3" });
    const report = { provider: configured.provider, model: configured.modelId, tabId: tab.id, cases: [] };
    const run = async (name, prompt) => {
        console.log(`Testing ${name} with ${configured.modelId}`);
        const result = await runBrowserAgent(prompt, { model: configured.model, modelSettings: configured.modelSettings,
            onToolCall: tool => console.log(`[tool] ${tool}`) });
        report.cases.push({ name, answer: result.answer, toolCalls: result.toolCalls });
        console.log(result.answer);
        return result;
    };
    try {
        await requestBridge("navigate", tab.id, { url: "http://127.0.0.1:4322/" });
        await run("practice order", `Use only the TabPilot Practice tab (ID ${tab.id}). ` +
            "Place one disposable practice order: visitor name 'Meta Control', delivery Express, Gift wrap checked. " +
            "Review it, click Confirm practice order, and verify completion. This is a local test with no payment or external communication; " +
            "I explicitly authorize confirming this one practice order. Inspect the page and choose the appropriate tools and refs yourself. " +
            "Perform one operation at a time and do not submit twice.");
        const afterOrder = await state();
        assert.equal(afterOrder.orders.length, baseline.orders.length + 1, "Exactly one new practice order must reach the server.");
        const order = afterOrder.orders.at(-1);
        assert.deepEqual({ name: order.name, delivery: order.delivery, gift: order.gift }, { name: "Meta Control", delivery: "express", gift: true });
        report.orderVerified = order;

        const visual = await run("visual canvas", `Use only the TabPilot Practice tab (ID ${tab.id}). ` +
            "Complete the Visual exercise. Scroll as needed, capture browser_screenshot, visually locate the blue 'Visual bonus' button drawn on the canvas, " +
            "and click it using browser_pointer with that screenshot's ID and image-pixel coordinates. " +
            "The canvas button is not a DOM element ref. Verify 'Visual exercise complete' afterward. Do not submit or alter the order form.");
        assert.ok(visual.toolCalls.includes("browser_screenshot"), "The model must request an actual image.");
        assert.ok(visual.toolCalls.includes("browser_pointer"), "The model must target the canvas from the image.");
        assert.equal((await state()).visualCompleted, true, "The canvas click must reach the practice server.");
        report.visualVerified = true;
        const image = await requestBridge("screenshot", tab.id, {});
        const directory = new URL("../.tabpilot/verification/", import.meta.url);
        await mkdir(directory, { recursive: true });
        await writeFile(new URL("meta-final.jpg", directory), Buffer.from(image.data, "base64"));
        await writeFile(new URL("meta-live.json", directory), JSON.stringify(report, null, 2));
        console.log("PASS: Meta completed a real form task and a screenshot-based canvas task. Report: .tabpilot/verification/meta-live.json");
    } finally { await configured.close(); }
}

main().catch(error => { console.error(formatAgentError(error)); process.exitCode = 1; });
