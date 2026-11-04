import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runBrowserAgent } from "./agent.mjs";
import { createConfiguredModel, DEFAULT_OPENAI_MODEL, formatAgentError } from "./agent-models.mjs";
import { historyQuery } from "./trace-history.mjs";

const providers = { openai: "OPENAI_API_KEY", meta: "META_API_KEY", gemini: "GOOGLE_GENERATIVE_AI_API_KEY", claude: "ANTHROPIC_API_KEY", "openai-compatible": "COMPATIBLE_API_KEY" };
const settingsSchema = z.object({
    provider: z.enum(Object.keys(providers)), model: z.string().trim().min(1).max(150),
    maxTurns: z.number().int().min(1).max(100), timeoutMs: z.number().int().min(1000).max(900000)
}).strict();
const startSchema = z.object({ prompt: z.string().trim().min(1).max(12000),
    tabId: z.number().int().nonnegative(), mode: z.enum(["browser", "computer"]), scope: z.string().uuid().optional(), tabTitle: z.string().max(500).optional() }).strict();

export class AgentService {
    constructor({ env = process.env, settings, saveSettings = async () => {}, run = runBrowserAgent, configure = createConfiguredModel, traceStore } = {}) {
        this.env = { ...env };
        this.settings = settingsSchema.parse(settings ?? {
            provider: env.AGENT_PROVIDER || "openai", model: env.AGENT_MODEL || DEFAULT_OPENAI_MODEL,
            maxTurns: Number(env.AGENT_MAX_TURNS || 30), timeoutMs: Number(env.AGENT_TIMEOUT_MS || 300000)
        });
        this.saveSettings = saveSettings;
        this.runAgent = run;
        this.configureModel = configure;
        this.listeners = new Set();
        this.sessionId = randomUUID();
        this.traceStore = traceStore;
        this.historyListeners = new Set();
        if (traceStore) { traceStore.bridgeSessionId = this.sessionId; traceStore.onChange = () => {
            for (const listener of this.historyListeners) listener(traceStore.revision);
        }; }
        this.revision = 0;
        this.history = [];
        this.conversationTab = null;
        this.state = { status: "idle", runId: null, events: [], screenshot: null };
    }
    get active() { return ["running", "pausing", "paused", "stopping"].includes(this.state.status); }
    snapshot() {
        return { ...this.state, historyRevision: this.traceStore?.revision ?? 0, historyAvailable: !!this.traceStore, historyWarning: this.historyWarning, sessionId: this.sessionId, revision: this.revision, settings: { ...this.settings }, providers: Object.entries(providers).map(([id, key]) => ({ id, configured: Boolean(this.env[key]?.trim()) })) };
    }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    subscribeHistory(listener) { this.historyListeners.add(listener); return () => this.historyListeners.delete(listener); }
    emit() { this.revision++; const state = this.snapshot(); for (const listener of this.listeners) listener(state); }
    event(kind, text, extra = {}) {
        const event = { id: randomUUID(), kind, text, time: Date.now(), ...extra };
        this.state.events.push(event);
        if (this.traceContext && kind !== "tool") this.traceStore.append(this.traceContext, event).catch(error => this.traceFailure(error));
        this.state.events = this.state.events.slice(-160);
        this.emit();
    }
    traceFailure(error) {
        this.historyWarning = `History could not be saved: ${formatAgentError(error, this.env)}`;
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
        if (["history-list", "history-events", "history-image"].includes(method)) {
            const query = historyQuery.parse(payload);
            if (!this.traceStore) throw new Error("Restart the bridge to enable History.");
            const operation = { "history-list": "list", "history-events": "events", "history-image": "artifact" }[method];
            return { history: await this.traceStore[operation](query) };
        }
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
            this.traceContext = null;
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
            this.traceContext = this.traceStore && input.scope ? { scope: input.scope, tabId: input.tabId, runId: this.state.runId } : null;
            this.traceReady = this.traceContext ? this.traceStore.start({ ...this.traceContext,
                bridgeSessionId: this.sessionId, source: "workspace", task: input.prompt, title: input.tabTitle,
                provider: this.settings.provider, model: this.settings.model, mode: input.mode }).catch(error => this.traceFailure(error)) : Promise.resolve();
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
            this.event("status", "Pause requested");
        } else if (method === "resume") {
            if (["paused", "pausing"].includes(this.state.status)) { this.state.status = "running"; this.wake?.(); this.event("status", "Run resumed"); }
        } else if (method === "stop") {
            this.state.status = "stopping";
            this.controller.abort(new Error("Stopped by user."));
            this.event("status", "Stop requested");
        } else throw new Error("Unknown agent command.");
        return this.snapshot();
    }
    async execute(input) {
        let configured;
        const traceContext = this.traceContext;
        const timer = setTimeout(() => this.controller.abort(new Error("Run time limit reached.")), this.settings.timeoutMs);
        try {
            await this.traceReady;
            configured = await this.configureModel({ ...this.env, AGENT_PROVIDER: this.settings.provider, AGENT_MODEL: this.settings.model });
            this.controller.signal.throwIfAborted();
            const result = await this.runAgent(input.prompt, {
                model: configured.model, modelSettings: configured.modelSettings, targetTabId: input.tabId, mode: input.mode,
                maxTurns: this.settings.maxTurns, signal: this.controller.signal, history: this.history,
                traceContext,
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
            const finalStatus = this.state.status;
            clearTimeout(timer);
            try { await configured?.close(); } catch { /* Runtime outcome already reported. */ }
            if (traceContext) await this.traceStore.finish(traceContext, finalStatus).catch(error => this.traceFailure(error));
            this.emit();
        }
    }
    disconnect() {
        if (this.active) { this.state.status = "stopping"; this.controller.abort(new Error("Extension disconnected. Reconnect before starting another task.")); this.emit(); }
    }
}
