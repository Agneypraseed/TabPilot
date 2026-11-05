import { MCPServerStdio } from "@openai/agents";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createConfiguredModel, DEFAULT_OPENAI_MODEL, formatAgentError } from "./agent-models.mjs";
import { parseAgentArguments, agentUsage } from "./agent-options.mjs";
import { runBrowserAgent as runPortableBrowserAgent } from "./agent-runner.mjs";

export async function runBrowserAgent(prompt, options = {}) {
    const server = options.server ?? new MCPServerStdio({
        name: "TabPilot", command: process.execPath,
        args: [fileURLToPath(new URL("./mcp.mjs", import.meta.url))],
        cacheToolsList: true, useStructuredContent: false, clientSessionTimeoutSeconds: 30,
        ...(options.traceContext ? { env: { ...process.env, TABPILOT_RUN_ID: options.traceContext.runId } } : {})
    });
    return runPortableBrowserAgent(prompt, { ...options, server });
}

async function main() {
    if (process.argv.slice(2).includes("--help")) { console.log(agentUsage); return; }
    const envFile = new URL("./.env.local", import.meta.url);
    if (existsSync(envFile)) loadEnvFile(fileURLToPath(envFile));
    const options = parseAgentArguments(process.argv.slice(2));
    const configured = await createConfiguredModel({ ...process.env, AGENT_PROVIDER: options.provider, AGENT_MODEL: options.model });
    console.error(`[model] ${configured.provider}/${configured.modelId}`);
    try {
        const result = await runBrowserAgent(options.prompt, {
            model: configured.model,
            modelSettings: configured.modelSettings,
            maxTurns: options.maxTurns,
            signal: AbortSignal.timeout(options.timeoutMs),
            onToolCall: (name) => console.error(`[tool] ${name}`)
        });
        console.log(result.answer);
    } finally {
        await configured.close();
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(formatAgentError(error));
        process.exitCode = 1;
    });
}
