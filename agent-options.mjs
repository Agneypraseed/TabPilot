export const agentUsage = 'Usage: npm run agent -- [--provider NAME --model ID] [--max-turns N] [--timeout-ms N] "browser task"';

export function parseAgentArguments(argv, env = process.env) {
    const options = {};
    let index = 0;
    while (index < argv.length && argv[index].startsWith("--")) {
        const flag = argv[index++];
        if (flag === "--") break;
        if (flag === "--help") return { help: true };
        const field = { "--provider": "provider", "--model": "model", "--max-turns": "maxTurns", "--timeout-ms": "timeoutMs" }[flag];
        if (!field || !argv[index] || argv[index].startsWith("--")) throw new Error(agentUsage);
        options[field] = argv[index++];
    }
    const prompt = argv.slice(index).join(" ").trim();
    if (!prompt) throw new Error(agentUsage);
    if (options.provider && options.provider !== (env.AGENT_PROVIDER || "openai") && !options.model) {
        throw new Error("Specify --model when overriding the provider, to avoid sending another provider's model ID.");
    }
    const maxTurns = Number(options.maxTurns ?? env.AGENT_MAX_TURNS ?? 30);
    const timeoutMs = Number(options.timeoutMs ?? env.AGENT_TIMEOUT_MS ?? 300000);
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) {
        throw new Error("AGENT_MAX_TURNS/--max-turns must be 1–100; AGENT_TIMEOUT_MS/--timeout-ms must be 1000–900000.");
    }
    return { prompt, maxTurns, timeoutMs, provider: options.provider ?? env.AGENT_PROVIDER, model: options.model ?? env.AGENT_MODEL };
}
