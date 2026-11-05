import OpenAI from "openai";
import { OpenAIProvider } from "@openai/agents";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";

export async function createConfiguredModel(env = globalThis.process?.env ?? {}, { fetch: fetchImplementation, browser = false } = {}) {
    const provider = env.AGENT_PROVIDER?.trim().toLowerCase() || "openai";
    const keys = {
        openai: "OPENAI_API_KEY",
        meta: "META_API_KEY",
        gemini: "GOOGLE_GENERATIVE_AI_API_KEY",
        claude: "ANTHROPIC_API_KEY",
        "openai-compatible": "COMPATIBLE_API_KEY"
    };
    if (!Object.hasOwn(keys, provider)) {
        throw new Error("AGENT_PROVIDER must be openai, meta, gemini, claude, or openai-compatible.");
    }
    const modelId = env.AGENT_MODEL?.trim() || (provider === "openai" ? DEFAULT_OPENAI_MODEL : "");
    if (!modelId) throw new Error(`Set AGENT_MODEL for ${provider}; use a tool-capable model ID from that provider.`);
    const apiKey = env[keys[provider]]?.trim();
    if (!apiKey) throw new Error(browser ? `Add your ${provider} API key in Settings before starting a task.` : `Set ${keys[provider]} in .env.local for ${provider}.`);

    if (provider === "openai" || provider === "meta") {
        // Each native Responses endpoint uses only its matching provider key.
        const baseURL = provider === "meta" ? "https://api.meta.ai/v1" : "https://api.openai.com/v1";
        const client = new OpenAIProvider({ useResponses: true,
            ...(browser ? { openAIClient: new OpenAI({ apiKey, baseURL, dangerouslyAllowBrowser: true, ...(fetchImplementation ? { fetch: fetchImplementation } : {}) }) } : { apiKey, baseURL }) });
        return { provider, modelId, model: await client.getModel(modelId),
            modelSettings: { maxTokens: 2000, store: false }, close: () => client.close() };
    }

    const options = { apiKey, fetch: fetchImplementation };
    let languageModel;
    if (provider === "gemini") languageModel = createGoogleGenerativeAI(options)(modelId);
    if (provider === "claude") languageModel = createAnthropic({ ...options, ...(browser ? { headers: { "anthropic-dangerous-direct-browser-access": "true" } } : {}) })(modelId);
    if (provider === "openai-compatible") {
        let baseURL;
        try { baseURL = new URL(env.COMPATIBLE_BASE_URL); }
        catch { throw new Error("Set COMPATIBLE_BASE_URL to the provider's API base URL."); }
        const local = ["localhost", "127.0.0.1", "[::1]"].includes(baseURL.hostname);
        if ((baseURL.protocol !== "https:" && !(local && baseURL.protocol === "http:")) ||
            baseURL.username || baseURL.password || baseURL.search || baseURL.hash) {
            throw new Error("COMPATIBLE_BASE_URL must use HTTPS (or HTTP loopback) without embedded credentials, query, or fragment.");
        }
        languageModel = createOpenAICompatible({ ...options, name: "tabpilot-compatible",
            baseURL: baseURL.href.replace(/\/$/, "") })(modelId);
    }
    return { provider, modelId, model: aisdk(languageModel), modelSettings: { maxTokens: 2000 }, close: async () => {} };
}

export function formatAgentError(error, env = globalThis.process?.env ?? {}) {
    let message = String(error.message ?? "Agent request failed.");
    // Provider errors may echo credentials or authenticated request URLs.
    for (const [name, value] of Object.entries(env)) {
        if (/(?:API_KEY|TOKEN|SECRET)$/.test(name) && typeof value === "string" && value.trim().length >= 8) {
            message = message.replaceAll(value.trim(), "[redacted]");
        }
    }
    return message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
        .replace(/([?&](?:key|api_key|access_token)=)[^&\s"']+/gi, "$1[redacted]");
}
