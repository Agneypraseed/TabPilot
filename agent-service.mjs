import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runBrowserAgent } from "./agent.mjs";
import { createConfiguredModel, DEFAULT_OPENAI_MODEL, formatAgentError } from "./agent-models.mjs";

const providers = { openai: "OPENAI_API_KEY", meta: "META_API_KEY", gemini: "GOOGLE_GENERATIVE_AI_API_KEY", claude: "ANTHROPIC_API_KEY", "openai-compatible": "COMPATIBLE_API_KEY" };
const settingsSchema = z.object({
    provider: z.enum(Object.keys(providers)), model: z.string().trim().min(1).max(150),
    maxTurns: z.number().int().min(1).max(100), timeoutMs: z.number().int().min(1000).max(900000)
}).strict();
const startSchema = z.object({ prompt: z.string().trim().min(1).max(12000),
    tabId: z.number().int().nonnegative(), mode: z.enum(["browser", "computer"]) }).strict();

export class AgentService {
    constructor({ env = process.env, settings, saveSettings = async () => {}, run = runBrowserAgent, configure = createConfiguredModel } = {}) {
        this.env = { ...env };
        this.settings = settingsSchema.parse(settings ?? {
            provider: env.AGENT_PROVIDER || "openai", model: env.AGENT_MODEL || DEFAULT_OPENAI_MODEL,
            maxTurns: Number(env.AGENT_MAX_TURNS || 30), timeoutMs: Number(env.AGENT_TIMEOUT_MS || 300000)
        });
        this.saveSettings = saveSettings;
        this.runAgent = run;
        this.configureModel = configure;
        this.listeners = new Set();
        this.revision = 0;
        this.history = [];
        this.conversationTab = null;
        this.state = { status: "idle", runId: null, events: [], screenshot: null };
    }
    get active() { return ["running", "pausing", "paused", "stopping"].includes(this.state.status); }
    snapshot() {
        return { ...this.state, revision: this.revision, settings: { ...this.settings }, providers: Object.entries(providers).map(([id, key]) => ({ id, configured: Boolean(this.env[key]?.trim()) })) };
    }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    emit() { this.revision++; const state = this.snapshot(); for (const listener of this.listeners) listener(state); }
    event(kind, text, extra = {}) {
        this.state.events.push({ id: randomUUID(), kind, text, time: Date.now(), ...extra });
        this.state.events = this.state.events.slice(-160);
        this.emit();
    }
    async checkpoint() {
        this.controller.signal.throwIfAborted();
        if (this.state.status === "pausing") { this.state.status = "paused"; this.emit(); }
        if (this.state.status === "paused") {
            await new Promise((resolve, reject) => {
                const abort = () => { this.wake = null; reject(this.controller.signal.reason); };
                this.wake = () => { this.controller.signal.removeEventListener("abort", abort); this.wake = null; resolve(); };
                this.controller.signal.addEventListener("abort", abort, { once: true });
            });
        }
        this.controller.signal.throwIfAborted();
    }
    async command(method, payload = {}) {
        if (method === "state") return this.snapshot();
        if (method === "settings") {
            if (this.active) throw new Error("Stop the current run before changing model settings.");
            const next = settingsSchema.parse(payload);
            if (!this.env[providers[next.provider]]?.trim()) throw new Error(`Add ${providers[next.provider]} to .env.local and restart the bridge.`);
            await this.saveSettings(next);
            this.settings = next;
            this.history = [];
            this.emit();
            return this.snapshot();
        }
        if (method === "clear") {
            if (this.active) throw new Error("Stop the current run before starting a new chat.");
            this.history = [];
            this.conversationTab = null;
            this.state = { status: "idle", runId: null, events: [], screenshot: null };
            this.emit();
            return this.snapshot();
        }
        if (method === "start") {
            if (this.active) throw new Error("An agent task is already running.");
            const input = startSchema.parse(payload);
            if (this.conversationTab !== input.tabId) { this.history = []; this.state.events = []; }
            this.conversationTab = input.tabId;
            this.controller = new AbortController();
            this.steering = [];
            this.state = { ...this.state, status: "running", runId: randomUUID(), tabId: input.tabId, mode: input.mode, screenshot: null };
            this.event("user", input.prompt);
            // Own the promise: returning immediately lets the panel receive progress
            // and send stop/steering while the model is working.
            this.running = this.execute(input);
            return this.snapshot();
        }
        if (!this.active) throw new Error("No agent task is running.");
        if (payload.runId !== this.state.runId) throw new Error("This control belongs to a previous run. Refresh the panel.");
        if (method === "steer") {
            const text = z.string().trim().min(1).max(12000).parse(payload.text);
            if (this.steering.length >= 10) throw new Error("Wait for the agent to read your queued guidance.");
            this.steering.push(text);
            this.event("user", text, { queued: true });
        } else if (method === "pause") {
            if (this.state.status === "running") this.state.status = "pausing";
            this.emit();
        } else if (method === "resume") {
            if (["paused", "pausing"].includes(this.state.status)) { this.state.status = "running"; this.wake?.(); this.emit(); }
        } else if (method === "stop") {
            this.state.status = "stopping";
            this.controller.abort(new Error("Stopped by user."));
            this.emit();
        } else throw new Error("Unknown agent command.");
        return this.snapshot();
    }
    async execute(input) {
        let configured;
        const timer = setTimeout(() => this.controller.abort(new Error("Run time limit reached.")), this.settings.timeoutMs);
        try {
            configured = await this.configureModel({ ...this.env, AGENT_PROVIDER: this.settings.provider, AGENT_MODEL: this.settings.model });
            this.controller.signal.throwIfAborted();
            const result = await this.runAgent(input.prompt, {
                model: configured.model, modelSettings: configured.modelSettings, targetTabId: input.tabId, mode: input.mode,
                maxTurns: this.settings.maxTurns, signal: this.controller.signal, history: this.history,
                checkpoint: () => this.checkpoint(), hasSteering: () => this.steering.length > 0,
                getSteering: () => {
                    const messages = this.steering.splice(0);
                    if (messages.length) this.event("status", "New guidance received");
                    return messages;
                },
                onActivity: activity => this.event("tool", activity.tool, activity),
                onObservation: image => { this.state.screenshot = image; this.emit(); }
            });
            this.controller.signal.throwIfAborted();
            this.history = result.history ?? [];
            this.state.status = "completed";
            this.event("assistant", result.answer);
            if (this.steering.length) this.event("status", "The run finished before reading your last guidance. Send it as a new task.");
        } catch (error) {
            this.state.status = this.controller.signal.aborted ? "stopped" : "error";
            // A cancelled operation may have reached Chrome. Do not replay its old
            // tool calls; a follow-up starts from a fresh page observation.
            this.history = [];
            this.event(this.state.status === "error" ? "error" : "status", formatAgentError(this.controller.signal.reason ?? error, this.env));
        } finally {
            clearTimeout(timer);
            try { await configured?.close(); } catch { /* Runtime outcome already reported. */ }
            this.emit();
        }
    }
    disconnect() {
        if (this.active) { this.state.status = "stopping"; this.controller.abort(new Error("Extension disconnected. Reconnect before starting another task.")); this.emit(); }
    }
}
