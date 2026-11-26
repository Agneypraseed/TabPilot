import { MCPServerStdio } from "@openai/agents";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createConfiguredModel, DEFAULT_OPENAI_MODEL, formatAgentError } from "./agent-models.mjs";
import { parseAgentArguments, agentUsage } from "./agent-options.mjs";
import { runBrowserAgent as runPortableBrowserAgent } from "./agent-runner.mjs";
import { requestBridge } from "./bridge-client.mjs";
import { actionParameters, mcpActionName } from "./commands.mjs";

export async function runBrowserAgent(prompt, options = {}) {
    const server = options.server ?? new MCPServerStdio({
        name: "TabPilot", command: process.execPath,
        args: [fileURLToPath(new URL("./mcp.mjs", import.meta.url))],
        cacheToolsList: true, useStructuredContent: false, clientSessionTimeoutSeconds: 30,
        ...(options.traceContext ? { env: { ...process.env, TABPILOT_RUN_ID: options.traceContext.runId } } : {})
    });
    if (!options.server && options.requestHuman) {
        const methods = new Map(Object.keys(actionParameters).map(method => [mcpActionName(method), method]));
        const bridgeOptions = { source: "mcp", runId: options.traceContext?.runId };
        const callToolResult = server.callToolResult.bind(server);
        server.inspectApproval = (name, { tabId, ...params }, { signal } = {}) => requestBridge("approval-context", tabId,
            { action: { method: methods.get(name), params } }, { ...bridgeOptions, signal });
        server.callToolResult = async (name, args, meta, callOptions = {}) => {
            if (!callOptions.approval) return callToolResult(name, args, meta, callOptions);
            const { tabId, ...params } = args;
            try {
                callOptions.signal?.throwIfAborted();
                const data = await requestBridge(methods.get(name), tabId, params,
                    { ...bridgeOptions, approval: callOptions.approval, signal: callOptions.signal });
                return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
            } catch (error) {
                callOptions.signal?.throwIfAborted();
                return { isError: true, content: [{ type: "text", text: error.message }] };
            }
        };
    }
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
