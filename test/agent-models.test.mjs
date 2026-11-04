import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MCPServerStdio } from "@openai/agents";
import { createConfiguredModel, DEFAULT_OPENAI_MODEL, formatAgentError } from "../agent-models.mjs";
import { runBrowserAgent } from "../agent.mjs";

const keyNames = { gemini: "GOOGLE_GENERATIVE_AI_API_KEY", claude: "ANTHROPIC_API_KEY", "openai-compatible": "COMPATIBLE_API_KEY" };

function providerResponse(provider, turn) {
    const name = turn === 1 ? "browser_tabs" : "browser_snapshot";
    const args = turn === 1 ? {} : { tabId: 12 };
    const text = "The museum opens at 10 AM.";
    if (provider === "gemini") return {
        candidates: [{ content: { role: "model", parts: turn < 3
            ? [{ functionCall: { name, args } }] : [{ text }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        modelVersion: "test-model", responseId: `response-${turn}`
    };
    if (provider === "claude") return {
        id: `msg-${turn}`, type: "message", role: "assistant", model: "test-model",
        content: turn < 3 ? [{ type: "tool_use", id: `call-${turn}`, name, input: args }] : [{ type: "text", text }],
        stop_reason: turn < 3 ? "tool_use" : "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
    };
    return {
        id: `chatcmpl-${turn}`, object: "chat.completion", created: 0, model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: turn < 3 ? null : text,
            ...(turn < 3 ? { tool_calls: [{ id: `call-${turn}`, type: "function",
                function: { name, arguments: JSON.stringify(args) } }] } : {}) },
            finish_reason: turn < 3 ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    };
}

for (const provider of Object.keys(keyNames)) {
    test(`${provider} adapter authenticates and completes a real SDK/MCP tool loop with simulated HTTP`, async () => {
        let requests = 0;
        const env = { AGENT_PROVIDER: provider, AGENT_MODEL: "test-model", [keyNames[provider]]: "test-provider-secret",
            OPENAI_API_KEY: "unused-openai-secret", COMPATIBLE_BASE_URL: "https://models.example/v1" };
        const configured = await createConfiguredModel(env, { fetch: async (url, init) => {
            requests++;
            const headers = new Headers(init.headers);
            const expectedHeader = provider === "gemini" ? "x-goog-api-key" : provider === "claude" ? "x-api-key" : "authorization";
            assert.equal(headers.get(expectedHeader), provider === "openai-compatible" ? "Bearer test-provider-secret" : "test-provider-secret");
            assert.ok(!JSON.stringify(init).includes(env.OPENAI_API_KEY));
            const body = JSON.parse(init.body);
            assert.match(JSON.stringify(body), /browser_tabs/);
            if (requests === 2) assert.match(JSON.stringify(body), /Test page/);
            if (requests === 3) assert.match(JSON.stringify(body), /museum opens at 10 AM/);
            const endpoint = new URL(url);
            assert.equal(endpoint.hostname, provider === "gemini" ? "generativelanguage.googleapis.com"
                : provider === "claude" ? "api.anthropic.com" : "models.example");
            return new Response(JSON.stringify(providerResponse(provider, requests)), {
                headers: { "Content-Type": "application/json" }
            });
        } });
        const server = new MCPServerStdio({ name: "provider-test", command: process.execPath,
            args: [fileURLToPath(new URL("./fixtures/agent-mcp.mjs", import.meta.url))], useStructuredContent: true });
        try {
            const result = await runBrowserAgent("Read my museum tab", {
                model: configured.model, modelSettings: configured.modelSettings, server
            });
            assert.equal(result.answer, "The museum opens at 10 AM.");
            assert.deepEqual(result.toolCalls, ["browser_tabs", "browser_snapshot"]);
            assert.equal(requests, 3);
        } finally { await configured.close(); }
    });
}

test("native OpenAI defaults to Luna and explicit models override it", async () => {
    for (const modelId of [undefined, "gpt-5-mini"]) {
        const configured = await createConfiguredModel({ OPENAI_API_KEY: "unused-test-key", AGENT_MODEL: modelId });
        assert.equal(configured.provider, "openai");
        assert.equal(configured.modelId, modelId ?? DEFAULT_OPENAI_MODEL);
        assert.equal(configured.modelSettings.store, false);
        assert.equal(typeof configured.model.getResponse, "function");
        await configured.close();
    }
});

test("unavailable provider models fail clearly without retrying or switching providers", async () => {
    for (const provider of Object.keys(keyNames)) {
        let requests = 0;
        const configured = await createConfiguredModel({ AGENT_PROVIDER: provider, AGENT_MODEL: "missing-model",
            [keyNames[provider]]: "test-provider-secret", COMPATIBLE_BASE_URL: "https://models.example/v1" }, {
            fetch: async () => {
                requests++;
                const message = "Requested model unavailable";
                const body = provider === "gemini" ? { error: { code: 404, status: "NOT_FOUND", message } }
                    : provider === "claude" ? { type: "error", error: { type: "not_found_error", message } }
                    : { error: { message, type: "invalid_request_error", code: "model_not_found" } };
                return new Response(JSON.stringify(body), { status: 404, headers: { "Content-Type": "application/json" } });
            }
        });
        const server = new MCPServerStdio({ name: "provider-error-test", command: process.execPath,
            args: [fileURLToPath(new URL("./fixtures/agent-mcp.mjs", import.meta.url))] });
        try {
            await assert.rejects(runBrowserAgent("Read my tab", { model: configured.model,
                modelSettings: configured.modelSettings, server }), /Requested model unavailable/);
            assert.equal(requests, 1);
        } finally { await configured.close(); }
    }
});

test("missing provider configuration fails without falling back to OpenAI", async () => {
    await assert.rejects(createConfiguredModel({ AGENT_PROVIDER: "unknown" }), /AGENT_PROVIDER/);
    await assert.rejects(createConfiguredModel({}), /OPENAI_API_KEY/);
    for (const [provider, key] of Object.entries(keyNames)) {
        await assert.rejects(createConfiguredModel({ AGENT_PROVIDER: provider }), /AGENT_MODEL/);
        await assert.rejects(createConfiguredModel({ AGENT_PROVIDER: provider, AGENT_MODEL: "test", OPENAI_API_KEY: "wrong-provider-key" }), new RegExp(key));
    }
});

test("custom endpoints reject insecure remote URLs and embedded credentials", async () => {
    const base = { AGENT_PROVIDER: "openai-compatible", AGENT_MODEL: "test", COMPATIBLE_API_KEY: "test-secret" };
    for (const url of [undefined, "bad url", "http://example.com/v1", "https://user:password@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#fragment"]) {
        await assert.rejects(createConfiguredModel({ ...base, COMPATIBLE_BASE_URL: url }), /COMPATIBLE_BASE_URL/);
    }
    const local = await createConfiguredModel({ ...base, COMPATIBLE_BASE_URL: "http://127.0.0.1:1234/v1" });
    assert.equal(local.provider, "openai-compatible");
    await local.close();
});

test("provider errors redact each provider's key and query credentials", () => {
    const env = { OPENAI_API_KEY: "sk-test-openai-key", GOOGLE_GENERATIVE_AI_API_KEY: "AIza-test-google-key", ANTHROPIC_API_KEY: "anthropic-test-secret" };
    const formatted = formatAgentError(new Error(`Failed: ${Object.values(env).join(" ")} https://example.com?key=url-secret`), env);
    for (const secret of [...Object.values(env), "url-secret"]) assert.ok(!formatted.includes(secret));
    assert.match(formatted, /Failed/);
});
