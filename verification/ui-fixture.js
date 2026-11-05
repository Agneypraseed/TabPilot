// Visual QA fixture only. Never included in the extension manifest or its pages.
(() => {
    let listener;
    const event = { addListener() {} };
    const state = { revision: 1, status: "idle", runId: null, events: [], historyAvailable: true, historyRevision: 1, settings: { provider: "meta", model: "muse-spark-1.3", maxTurns: 30, timeoutMs: 300000 }, providers: [{ id: "meta", configured: true }, { id: "openai", configured: true }] };
    let connected = true;
    if (new URLSearchParams(location.search).has("formatted")) {
        state.events = [{ kind: "user", text: "Show the match results with sources." },
            { kind: "assistant", text: "## Match results\n\nSample results for a **formatting preview**:\n\n- **Fenerbahçe 3–2 Liverpool** — match summary\n- **Lens 1–9 Como** — match summary\n- **AEK 2–3 Real Madrid** — match summary\n\n### At a glance\n\n| Team | Goals |\n| --- | --- |\n| Liverpool | 2 |\n| Como | 9 |\n\nSource: [Example source](https://example.com/)\n\n> Illustrative data for visual testing only." }];
    }
    const access = {};
    if (new URLSearchParams(location.search).has("tasks")) {
        state.jobs = [
            { id: "coordinator", tabId: 12, prompt: "Compare delivery options", role: "coordinator", status: "waiting-for-worker", stage: 2, maxStages: 20, createdAt: 3, activity: "Waiting for research findings" },
            { id: "worker-a", parentTaskId: "coordinator", tabId: 34, prompt: "Read delivery policy", role: "research", status: "running", stage: 1, maxStages: 10, createdAt: 4, activity: "Reading the page" },
            { id: "worker-b", parentTaskId: "coordinator", tabId: 35, prompt: "Check returns policy", role: "research", status: "needs-input", stage: 1, maxStages: 10, createdAt: 5 },
            { id: "scheduled", tabId: 12, prompt: "Summarize page changes", role: "coordinator", status: "scheduled", stage: 0, maxStages: 20, createdAt: 1, notBefore: Date.now() + 3600000, repeatEveryMs: 1800000 }
        ];
        state.selectedTabId = 12;
    }
    if (new URLSearchParams(location.search).has("attention")) {
        Object.assign(state, { status: "needs-input", runId: "preview-run", tabId: 12, mode: "browser",
            requests: [{ id: "preview-request", runId: "preview-run", kind: "information", question: "Which city should I research?", detail: "I’ll wait for your answer before continuing.", tabId: 12 }] });
    }
    globalThis.chrome = {
        tabs: { query: async () => [{ id: 12, windowId: 1, title: "Google", url: "https://www.google.com/", active: true }, ...(new URLSearchParams(location.search).has("tabs") ? [{ id: 34, windowId: 2, title: "Delivery policy", url: "http://127.0.0.1:4322/delivery" }, { id: 56, windowId: 2, title: "Returns policy", url: "http://127.0.0.1:4322/returns" }] : [])], update: async () => ({}), onActivated: event, onUpdated: event, onRemoved: event },
        storage: { session: { get: async () => ({ ...access }) }, onChanged: event },
        runtime: { onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async message => {
            if (message.type === "tabpilot:ui-state") return { connected, agent: state };
            if (message.type === "tabpilot:access") { if (message.enabled) delete access[`tab:${message.tabId}`]; else access[`tab:${message.tabId}`] = false; return { ok: true, enabled: message.enabled }; }
            if (message.type === "tabpilot:connect") { connected = true; return { ok: true }; }
            if (message.type === "tabpilot:disconnect") { connected = false; return { ok: true }; }
            if (message.type === "tabpilot:test-alert") return { ok: true, played: false };
            if (message.type === "tabpilot:agent") {
                const { method, payload } = message;
                if (method === "select-tab") state.selectedTabId = payload.tabId;
                if (method === "task-create") state.jobs.push({ ...payload, id: crypto.randomUUID(), createdAt: Date.now(), stage: 0, status: "scheduled" });
                if (method === "task-cancel") state.jobs.find(job => job.id === payload.taskId).status = "cancelled";
                if (method === "human-response") { state.requests = []; state.status = "idle"; }
                if (method === "history-list") return { ok: true, history: { runs: [
                    { runId: "fixture-history-1", task: "Search Google for testing my agent", source: "workspace", model: "muse-spark-1.3", status: "completed", startedAt: Date.now() - 120000 },
                    { runId: "fixture-history-2", task: "CLI · snapshot", source: "cli", status: "completed", startedAt: Date.now() - 300000 }
                ], nextOffset: null } };
                if (method === "history-events") return { ok: true, history: { events: [
                    { kind: "user", text: "Search Google for testing my agent", time: Date.now() - 120000 },
                    { kind: "tool", tool: "fill", phase: "running", arguments: { ref: "snapshot:e3", text: "[typed value omitted; inspect resulting page state]" }, time: Date.now() - 115000 },
                    { kind: "tool", tool: "fill", phase: "complete", result: { action: "fill", snapshot: { title: "Google", text: "testing my agent" } }, time: Date.now() - 114000 },
                    { kind: "assistant", text: "Google results are ready.", time: Date.now() - 110000 }
                ], nextOffset: null } };
                if (method === "settings") state.settings = payload;
                if (method === "clear") { state.events = []; state.status = "idle"; }
                if (method === "start") {
                    Object.assign(state, { status: "running", runId: "preview-run", tabId: 12, mode: payload.mode });
                    state.events.push({ id: crypto.randomUUID(), kind: "user", text: payload.prompt });
                    for (const [index, tool] of ["browser_snapshot", "browser_fill", "browser_press"].entries()) {
                        setTimeout(() => {
                            if (state.status === "stopped") return;
                            state.events.push({ id: crypto.randomUUID(), kind: "tool", text: tool, tool, phase: "complete", time: Date.now() });
                            if (index === 2) { state.status = "completed"; state.events.push({ id: crypto.randomUUID(), kind: "assistant", text: "Google results are ready." }); }
                            state.revision++; listener?.({ type: "tabpilot:agent-event", state });
                        }, 500 * (index + 1));
                    }
                }
                if (method === "pause") state.status = "paused";
                if (method === "resume") state.status = "running";
                if (method === "stop") state.status = "stopped";
                if (method === "steer") state.events.push({ id: crypto.randomUUID(), kind: "user", text: payload.text });
                state.revision++; return { ok: true, state };
            }
        } }
    };
})();
