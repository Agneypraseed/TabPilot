const randomUUID = () => globalThis.crypto.randomUUID();
import { tool } from "@openai/agents";
import { z } from "zod";
import { AgentService } from "./agent-service.mjs";
import { taskInputSchema, taskResumeSchema } from "./task-schema.mjs";
import { taskRequestAlert } from "./task-alerts.mjs";
import { checkpointHistory } from "./task-checkpoint.mjs";
import { TaskBudget } from "./human-requests.mjs";

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const queueStatuses = new Set(["queued", "scheduled", "waiting-for-tab"]);
const uuid = z.string().uuid();
const tabIdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const viewSchema = z.object({ tabId: tabIdSchema.nullable(), taskId: uuid.optional() }).strict();
const noProgressStageLimit = 3;
const day = 24 * 60 * 60 * 1000;

function evidenceKey(tool, data) {
    const page = data?.snapshot ?? data;
    const elements = Array.isArray(page?.elements) ? page.elements : [];
    const content = typeof page?.text === "string" || elements.length ? [page.url, page.title, page.text?.slice(0, 16000),
        elements.slice(0, 150).map(({ name, role, value, checked, selected, disabled }) => [name, role, value, checked, selected, disabled])] :
        tool === "browser_screenshot" && typeof data === "string" ? data :
        ["browser_download_status", "browser_download_local_status", "collect_worker_result"].includes(tool) ? data : null;
    if (!content) return;
    const input = JSON.stringify(content);
    let hash = 2166136261;
    const stride = Math.max(1, Math.floor(input.length / 16384));
    for (let index = 0; index < input.length; index += stride) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
    return hash;
}

// The scheduler owns task lifetimes; each browser tab has its own AgentService.
// Model calls remain in AgentService, so waiting schedules spend no API tokens.
export class TaskManager {
    constructor({ store, browser, serviceOptions = {}, createSession = options => new AgentService(options), now = Date.now,
        maxConcurrent = 3, autoTick = true, notifications } = {}) {
        this.store = store;
        this.browser = browser;
        this.serviceOptions = serviceOptions;
        this.createSession = createSession;
        this.now = now;
        this.maxConcurrent = maxConcurrent;
        this.notifications = notifications;
        this.pendingNotifications = new Set();
        this.notificationDeliveries = new Map();
        this.telegramApprovals = new Map();
        this.sessionId = randomUUID();
        this.traceStore = serviceOptions.traceStore;
        this.listeners = new Set();
        this.historyListeners = new Set();
        this.records = new Map();
        this.sessions = new Map();
        this.executing = new Set();
        this.executions = new Map();
        this.reservations = new Set();
        this.resuming = new Set();
        this.schedulingRepeats = new Set();
        this.taskBudgets = new Map();
        this.selectedTab = null;
        this.revision = 0;
        this.nextHistoryCleanup = 0;
        this.preferences = new AgentService({ ...serviceOptions, sessionId: this.sessionId, manageTraceStore: false });
        if (this.traceStore) {
            this.traceStore.bridgeSessionId = this.sessionId;
            this.traceStore.onChange = () => {
                for (const listener of this.historyListeners) listener(this.traceStore.revision);
            };
        }
        this.ready = this.load();
        if (autoTick) { this.timer = setInterval(() => void this.tick().catch(error => { this.schedulerWarning = error.message; }), 1000); this.timer.unref?.(); }
    }
    async load() {
        for (const record of await this.store.load()) {
            if (record.parentTaskId && record.status === "queued") {
                // A worker that was queued before the runtime stopped needs
                // a fresh delegation from its coordinator.
                record.status = "interrupted";
                record.interruption = "runtime-restarted";
            }
            this.records.set(record.id, record);
        }
    }
    get active() { return this.executing.size > 0; }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    subscribeHistory(listener) { this.historyListeners.add(listener); return () => this.historyListeners.delete(listener); }
    traceFailure(error) { this.preferences.traceFailure(error); this.emit(); }
    traceContextFor(runId, tabId, scope) {
        return [...this.sessions.values()].find(session => session.active && session.traceContext?.runId === runId &&
            session.traceContext.tabId === tabId && session.traceContext.scope === scope)?.traceContext;
    }
    visible(record) {
        return this.connection && this.readyConnection === this.connection && (record.scope === this.connection.scope ||
            (record.profileId && record.profileId === this.connection.profileId));
    }
    async history(method, payload) {
        const { taskId, ...query } = payload;
        if (!this.connection || this.readyConnection !== this.connection || query.scope !== this.connection.scope) throw new Error("Reconnect the browser before managing History.");
        if (taskId !== undefined) {
            // Resolve older tab namespaces from the saved task and validate
            // that the requested trace belongs to it.
            const record = this.records.get(uuid.parse(taskId));
            if (!record || !this.visible(record) || record.tabId !== query.tabId || !this.taskRunIds(record).includes(query.runId) ||
                !["history-events", "history-image", "history-delete"].includes(method)) throw new Error("This trace is not available for the saved task.");
            query.scope = record.scope;
        }
        const result = await this.preferences.command(method, query);
        if (method === "history-list") result.history.runs = result.history.runs.map(run => this.historySpecialists(run, query));
        if (method === "history-events" && result.history.run) result.history.run = this.historySpecialists(result.history.run, query);
        return result;
    }
    async expireHistory(connection) {
        const days = this.preferences.settings.historyRetentionDays;
        const now = this.now();
        if (!days || this.readyConnection !== connection || !this.traceStore?.expire || this.cleaningHistory || this.nextHistoryCleanup > now) return;
        this.cleaningHistory = true;
        try {
            const scopes = new Set([connection.scope]);
            if (connection.profileId) {
                for (const scope of await this.traceStore.scopesForProfile?.(connection.profileId) ?? []) scopes.add(scope);
                for (const record of this.records.values()) if (record.profileId === connection.profileId) scopes.add(record.scope);
            }
            for (const scope of scopes) {
                if (this.connection !== connection || days !== this.preferences.settings.historyRetentionDays) return;
                await this.traceStore.expire({ scope, before: Math.max(0, now - days * day) });
            }
            this.nextHistoryCleanup = now + day;
        } catch (error) {
            this.nextHistoryCleanup = now + 5 * 60 * 1000;
            this.traceFailure(error);
        } finally { this.cleaningHistory = false; }
    }
    taskRunIds(record) {
        const latest = this.sessions.get(record.id)?.state.runId ?? record.runId;
        return [...new Set([...(record.runIds ?? []), latest].filter(Boolean))];
    }
    historySpecialists(run, { scope, tabId }) {
        const parent = [...this.records.values()].find(record => this.visible(record) && record.scope === scope &&
            record.tabId === tabId && this.taskRunIds(record).includes(run.runId));
        if (!parent || parent.parentTaskId) return run;
        const specialists = [...this.records.values()].filter(worker => worker.scope === scope && worker.parentTaskId === parent.id &&
            (worker.parentRunId ?? this.taskRunIds(parent).at(-1)) === run.runId)
            .flatMap(worker => {
                const runs = this.taskRunIds(worker);
                return runs.map((runId, index) => ({
                    id: worker.id, parentTaskId: parent.id, tabId: worker.tabId, runId, prompt: worker.prompt,
                    stage: runs.length > 1 ? index + 1 : undefined,
                    status: index === runs.length - 1 ? worker.status : undefined
                }));
            });
        return specialists.length ? { ...run, specialists } : run;
    }
    isChat(record) {
        return Boolean(record && !record.parentTaskId && (record.kind === "chat" ||
            (!record.kind && !record.seriesId && !record.repeatEveryMs && (record.notBefore ?? record.createdAt) <= record.createdAt)));
    }
    recordForView(view) {
        const tabId = view ? view.tabId : this.selectedTab;
        if (tabId === null || this.readyConnection !== this.connection) return;
        const matches = record => record?.scope === this.connection?.scope && record?.tabId === tabId;
        if (view?.taskId) {
            const pinned = this.records.get(view.taskId);
            return matches(pinned) ? pinned : undefined;
        }
        return [...this.records.values()].filter(record => matches(record) && !record.resumedAs &&
            (this.isChat(record) || (!view && this.sessions.has(record.id))))
            .sort((a, b) => Number(this.isChat(b)) - Number(this.isChat(a)) ||
                Number(this.sessions.get(b.id)?.active ?? false) - Number(this.sessions.get(a.id)?.active ?? false) || b.createdAt - a.createdAt)[0];
    }
    snapshot(view) {
        const selected = this.recordForView(view);
        const service = selected && this.sessions.get(selected.id);
        const preferences = this.preferences.snapshot();
        const base = service?.snapshot() ?? preferences;
        const continuations = new Map([...this.records.values()].filter(record => record.resumedFrom).map(record => [record.resumedFrom, record.id]));
        return { ...base, settings: preferences.settings, providers: preferences.providers, sessionId: this.sessionId, revision: this.revision,
            ...(selected?.status === "paused" && !service?.active ? { status: "needs-review" } : {}),
            scopedTaskView: true, ...(view ? { view } : {}), selectedTabId: view ? view.tabId : this.selectedTab,
            taskId: selected?.id, schedulerWarning: this.schedulerWarning, notificationWarning: this.notificationWarning, notificationDeliveries: [...this.notificationDeliveries.values()],
            requests: [...this.sessions].filter(([id]) => this.readyConnection === this.connection && this.records.get(id)?.scope === this.connection?.scope)
                .flatMap(([, session]) => session.snapshot().requests),
            jobs: [...this.records.values()].filter(record => this.visible(record)).map(({ checkpoint, ...record }) => ({ ...record,
                resumedAs: record.resumedAs ?? continuations.get(record.id),
                runId: this.sessions.get(record.id)?.state.runId ?? record.runId,
                activity: record.lastStep?.tool ?? this.sessions.get(record.id)?.state.events.findLast(event => event.kind === "tool" || event.kind === "status")?.text,
                executing: this.executing.has(record.id),
                needsRebind: record.scope !== this.connection.scope,
                pendingSchedule: this.isPendingSchedule(record),
                scheduleNeedsReview: Boolean(record.scheduleNeedsReview) || (record.scope !== this.connection.scope && this.isPendingSchedule(record)),
                repeatScheduleFailed: this.repeatNeedsSaving(record) && !this.executing.has(record.id) })) };
    }
    emit() { this.revision++; const state = this.snapshot(); for (const listener of this.listeners) listener(state); }
    notify(input, context = {}, request) {
        if (!this.notifications) return;
        const id = context.requestId ?? context.taskId ?? randomUUID();
        const update = results => {
            this.notificationDeliveries.set(id, { ...context, results, updatedAt: this.now() });
            while (this.notificationDeliveries.size > 100) this.notificationDeliveries.delete(this.notificationDeliveries.keys().next().value);
            this.emit();
        };
        const pending = Promise.resolve().then(async () => {
            const status = this.notifications.status();
            const channels = Object.keys(status).filter(name => status[name].configured);
            if (!channels.length) {
                const invalid = Object.keys(status).filter(name => status[name].invalid);
                if (!invalid.length) return;
                update(invalid.map(channel => ({ channel, accepted: false, error: 'Saved channel settings are invalid. Check the token and destination in Settings.' })));
                throw new Error('Invalid notification settings.');
            }
            update(channels.map(channel => ({ channel, status: 'sending' })));
            const telegramApproval = request?.kind === "approval" && request.question.trim().length <= 900 &&
                (request.detail?.trim().length ?? 0) <= 1400 && this.notifications.telegramApprovals;
            const result = await this.notifications.send(input, { telegramApproval, taskRequest: Boolean(request) });
            const results = result.results ?? channels.map(channel => ({ channel, accepted: result.accepted }));
            const messageId = results.find(item => item.channel === "telegram" && item.accepted)?.messageId;
            if (telegramApproval && Number.isSafeInteger(messageId) && this.connection?.scope === request.scope) {
                this.telegramApprovals.set(messageId, { id: request.id, runId: request.runId, scope: request.scope });
            }
            update(results.map(({ messageId: _, ...delivery }) => delivery));
            if (!result.accepted) throw new Error('Notification was not accepted.');
        }).catch(() => {
            const previous = this.notificationDeliveries.get(id);
            if (previous?.results.some(item => item.status === 'sending')) {
                update(previous.results.map(item => ({ channel: item.channel, accepted: false, error: 'Delivery is unknown. Check Telegram before retrying.' })));
            }
            this.notificationWarning = 'A task notification failed or its delivery is unknown. Check the alert status beside the request or use Send test alert in Settings.';
            this.emit();
        });
        this.pendingNotifications.add(pending);
        void pending.finally(() => this.pendingNotifications.delete(pending));
    }
    async pollTelegram() {
        const connection = this.connection;
        const live = new Set([...this.sessions.values()].flatMap(session => session.humanRequests.list())
            .filter(request => request.scope === connection.scope).map(request => request.id));
        for (const [messageId, approval] of this.telegramApprovals) {
            if (!live.has(approval.id)) this.telegramApprovals.delete(messageId);
        }
        if (!this.telegramApprovals.size || this.pollingTelegram || this.now() < (this.telegramPollAfter ?? 0)) return;
        this.pollingTelegram = true;
        this.telegramPollAfter = this.now() + 2000;
        try {
            const env = this.notifications.env;
            // Start from unacknowledged updates. Only a reply to a currently
            // pending alert can do anything, even if Telegram redelivers it.
            const result = await this.notifications.telegramReplies(this.telegramOffset);
            await Promise.allSettled([...this.pendingNotifications]);
            if (connection !== this.connection || env !== this.notifications.env) return;
            this.telegramOffset = result.offset;
            for (const { messageId, decision } of result.replies) {
                if (connection !== this.connection) break;
                const approval = this.telegramApprovals.get(messageId);
                if (!approval) continue;
                this.telegramApprovals.delete(messageId);
                await this.command("human-response", { ...approval, decision }).catch(() => {
                    // A local response, expiry, or stop may have won the race.
                });
            }
        } catch {
            this.telegramPollAfter = this.now() + 10000;
        } finally { this.pollingTelegram = false; }
    }
    async save(record) {
        record.updatedAt = this.now();
        const saved = await this.store.upsert(record);
        this.records.set(record.id, record);
        this.emit();
        return saved;
    }
    async connected(connection) {
        this.connection = connection;
        await this.ready;
        if (this.connection !== connection) return;
        if (connection.profileId) {
            try { await this.traceStore?.rememberScope?.(connection.scope, connection.profileId); }
            catch (error) {
                if (error.code === "HISTORY_SCOPE_CONFLICT") {
                    if (this.connection === connection) this.disconnect();
                    throw error;
                }
                this.traceFailure(error);
            }
        }
        if (this.connection !== connection) return;
        this.readyConnection = connection;
        this.nextHistoryCleanup = 0;
        this.emit();
        await this.tick();
    }
    disconnect() {
        this.connection = null;
        this.readyConnection = null;
        this.telegramApprovals.clear();
        this.telegramOffset = undefined;
        for (const session of this.sessions.values()) session.disconnect();
        this.emit();
    }
    async command(method, payload = {}) {
        await this.ready;
        const { view: requestedView, ...args } = payload;
        payload = args;
        const view = requestedView === undefined ? undefined : viewSchema.parse(requestedView);
        const state = () => this.snapshot(view);
        if (method === "state") return state();
        if (method.startsWith("history-")) return this.history(method, payload);
        if (method === "settings") {
            if (this.active) throw new Error("Stop active tasks before changing model settings.");
            const previousRetention = this.preferences.settings.historyRetentionDays;
            await this.preferences.command(method, payload);
            if (previousRetention !== this.preferences.settings.historyRetentionDays) {
                this.nextHistoryCleanup = 0;
                if (this.connection) void this.expireHistory(this.connection);
            }
            this.emit(); return state();
        }
        if (!this.connection || this.readyConnection !== this.connection || (payload.scope && payload.scope !== this.connection.scope)) throw new Error("Reconnect the browser before controlling tasks.");
        if (method === "task-list") {
            const tabId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().parse(payload.tabId);
            return { tasks: this.snapshot().jobs.filter(job => tabId === undefined || job.tabId === tabId) };
        }
        if (method === "select-tab") {
            const tabId = tabIdSchema.parse(payload.tabId);
            if (view) return this.snapshot({ ...view, tabId });
            this.selectedTab = tabId;
            this.emit(); return state();
        }
        if (method === "start" || method === "task-create") {
            const input = taskInputSchema.parse({ notBefore: this.now(), ...payload, scope: this.connection.scope, profileId: this.connection.profileId });
            if (!view && (method === "start" || this.selectedTab === null)) this.selectedTab = input.tabId;
            await this.create(input, { kind: method === "start" ? "chat" : "scheduled" });
            await this.tick();
            return state();
        }
        if (["task-cancel", "task-resume", "task-retry-repeat"].includes(method)) {
            const record = this.records.get(uuid.parse(payload.taskId));
            if (!record || !this.visible(record)) throw new Error("Task is not available in this browser.");
            const session = this.sessions.get(record.id);
            if (method === "task-cancel") {
                await this.cancel(record);
            } else if (method === "task-retry-repeat") {
                if (this.executing.has(record.id) || !this.repeatNeedsSaving(record)) throw new Error("There is no repeat to retry.");
                await this.scheduleRepeat(record, { retry: true });
            } else {
                const { scope, ...resume } = payload;
                const options = taskResumeSchema.parse(resume);
                const needsReview = record.scope !== this.connection.scope || record.scheduleNeedsReview;
                if (session?.active || !(needsReview && queueStatuses.has(record.status)) &&
                    !["interrupted", "failed", "paused", "waiting-for-tab"].includes(record.status)) throw new Error("This task cannot be resumed now.");
                const resumed = await this.resume(record, options, { selectTab: !view });
                await this.tick();
                return view && resumed && !this.isChat(resumed) && resumed.status !== "scheduled"
                    ? this.snapshot({ tabId: resumed.tabId, taskId: resumed.id }) : state();
            }
            await this.tick(); return state();
        }
        let session;
        if (method === "human-response") session = [...this.sessions.values()].find(item => item.humanRequests.list().some(request => request.id === payload.id && request.runId === payload.runId));
        else if (view) {
            const visibleTask = this.recordForView(view);
            session = visibleTask && this.sessions.get(visibleTask.id);
            if (payload.runId && session?.state.runId !== payload.runId) throw new Error("This run is no longer selected in this panel.");
        }
        else if (payload.runId) session = [...this.sessions.values()].find(item => item.state.runId === payload.runId);
        else {
            const record = this.recordForView();
            session = record && this.sessions.get(record.id);
        }
        if (!session) {
            if (method === "clear") return state();
            throw new Error("Select a task that is running.");
        }
        if (method === "stop") {
            const record = [...this.records.values()].find(item => this.sessions.get(item.id) === session);
            await this.cancel(record);
            return state();
        }
        await session.command(method, payload);
        if (method === "human-response" && payload.decision === "deny") await this.pauseDeclinedTask(session);
        this.emit(); return state();
    }
    isPendingSchedule(record) {
        return record.stage === 0 && queueStatuses.has(record.status) &&
            (record.kind === "scheduled" || Boolean(record.repeatEveryMs) || record.status === "scheduled" || record.notBefore > record.createdAt);
    }
    repeatNeedsSaving(record) {
        return record.status === "completed" && Boolean(record.nextOccurrenceId) && !this.records.has(record.nextOccurrenceId);
    }
    async scheduleRepeat(record, { retry = false } = {}) {
        if (!this.repeatNeedsSaving(record) || this.schedulingRepeats.has(record.id)) return;
        this.schedulingRepeats.add(record.id);
        try {
            await this.create({ ...this.input(record), notBefore: record.nextOccurrenceAt }, {
                id: record.nextOccurrenceId, kind: "scheduled", seriesId: record.seriesId ?? record.id,
                scheduleNeedsReview: retry && record.nextOccurrenceAt <= this.now(),
            });
        } finally { this.schedulingRepeats.delete(record.id); }
    }
    async resume(record, { tabId, scheduleAction, guidance }, { selectTab }) {
        if (this.executing.has(record.id) || this.resuming.has(record.id) ||
            [...this.records.values()].some(job => job.resumedFrom === record.id))
            throw new Error("This task is still stopping or already has a continuation.");
        if (record.parentTaskId) throw new Error("Continue the coordinator to recover its research.");
        const connection = this.connection;
        const scheduled = this.isPendingSchedule(record);
        const now = this.now();
        const missed = scheduled && record.notBefore <= now;
        if (missed && scheduleAction === "keep") throw new Error("This schedule is overdue. Choose Run now or Skip missed run.");
        if (!missed && scheduleAction === "skip") throw new Error("Only a missed occurrence can be skipped.");
        let notBefore = scheduled && scheduleAction === "keep" ? record.notBefore : now;
        if (scheduleAction === "skip" && record.repeatEveryMs) {
            notBefore = record.notBefore + (Math.floor((now - record.notBefore) / record.repeatEveryMs) + 1) * record.repeatEveryMs;
        }
        this.resuming.add(record.id);
        try {
            if (scheduleAction === "skip" && !record.repeatEveryMs) {
                await this.save({ ...record, status: "cancelled", cancelled: true, summary: "Missed occurrence skipped." });
                return;
            }
            if (tabId === undefined) throw new Error("Choose a web tab with access enabled before continuing.");
            const input = taskInputSchema.parse({ ...this.input(record), scope: connection.scope,
                profileId: connection.profileId, tabId, notBefore });
            const available = await this.browser("tabs");
            const tab = (Array.isArray(available) ? available : available.tabs).find(tab => tab.id === input.tabId);
            if (this.connection !== connection) throw new Error("Reconnect before continuing this task.");
            if (!tab) throw new Error("Choose a web tab with access enabled before continuing.");
            if (record.cancelled) throw new Error("This task was cancelled.");
            if (selectTab && (!scheduled || scheduleAction === "run-now")) this.selectedTab = tabId;
            const resumed = await this.create({ ...input, tabTitle: tab.title || (record.scope === input.scope && record.tabId === tabId ? record.tabTitle : undefined) },
                { resumedFrom: record.id, kind: this.isChat(record) ? "chat" : "scheduled",
                    seriesId: record.seriesId ?? (record.repeatEveryMs ? record.id : undefined),
                    recoveryGuidance: guidance || record.recoveryGuidance });
            await this.save({ ...record, status: "cancelled", cancelled: true, resumedAs: resumed.id });
            return resumed;
        } finally { this.resuming.delete(record.id); }
    }
    previousProgress(record) {
        const source = this.records.get(record.resumedFrom);
        if (!source) return null;
        const lineage = new Set();
        for (let task = source; task && !lineage.has(task.id); task = this.records.get(task.resumedFrom)) lineage.add(task.id);
        const findings = [...this.records.values()].filter(job => lineage.has(job.parentTaskId) && job.status === "completed")
            .slice(-5).map(job => ({ summary: job.summary?.slice(0, 1200), evidence: job.evidence?.slice(0, 1200) }));
        return { summary: source.summary?.slice(0, 1600), lastStep: source.lastStep, declined: Boolean(source.declinedRequest), findings };
    }
    input(record) {
        return Object.fromEntries(["scope", "profileId", "tabId", "tabTitle", "prompt", "mode", "notBefore", "repeatEveryMs", "maxStages", "allowResearch"].filter(key => record[key] !== undefined).map(key => [key, record[key]]));
    }
    async create(input, extra = {}) {
        return this.save({ ...input, role: "coordinator", id: randomUUID(), ...extra, createdAt: this.now(), stage: 0,
            status: input.notBefore > this.now() ? "scheduled" : "queued" });
    }
    async tick() {
        await this.ready;
        if (this.connection && this.telegramApprovals.size) void this.pollTelegram();
        if (this.connection) void this.expireHistory(this.connection);
        if (this.ticking || !this.connection || this.readyConnection !== this.connection) return;
        this.ticking = true;
        const connection = this.connection;
        try {
            const available = await this.browser("tabs");
            if (connection !== this.connection) return;
            const enabled = new Set((Array.isArray(available) ? available : available.tabs).map(tab => tab.id));
            const continued = new Set([...this.records.values()].map(record => record.resumedFrom).filter(Boolean));
            for (const record of [...this.records.values()]) {
                if (connection !== this.connection) return;
                if (record.scope !== connection.scope || record.cancelled || record.parentTaskId || this.resuming.has(record.id) ||
                    continued.has(record.id) || record.scheduleNeedsReview || !queueStatuses.has(record.status) || this.sessions.has(record.id)) continue;
                if (record.notBefore > this.now()) continue;
                if (!enabled.has(record.tabId)) {
                    if (record.status !== "waiting-for-tab") { record.status = "waiting-for-tab"; await this.save(record); }
                    continue;
                }
                const running = [...this.executing].map(id => this.records.get(id));
                if (running.length + this.reservations.size >= this.maxConcurrent || running.some(job => job.tabId === record.tabId)) continue;
                // Claim before yielding, so overlapping ticks cannot start the same task.
                await this.launch(record);
            }
        } catch (error) { this.schedulerWarning = error.message; }
        finally { this.ticking = false; }
    }
    async launch(record) {
        // Stores may return clones. Keep execution and UI controls on the same
        // in-memory record even while a checkpoint/stage save is pending.
        record = this.records.get(record.id) ?? record;
        const rootId = record.parentTaskId ?? record.id;
        let budget = this.taskBudgets.get(rootId);
        if (!budget) {
            const settings = this.preferences.settings;
            budget = new TaskBudget(settings.maxTaskTurns, settings.maxTaskActiveMs);
            this.taskBudgets.set(rootId, budget);
        }
        const evidence = new Set();
        const observe = (tool, data) => {
            const key = evidenceKey(tool, data);
            if (key !== undefined && evidence.size < 4096) evidence.add(key);
        };
        let completion;
        const finish = tool({ name: "complete_task", description: "Mark a task complete only after its requested outcome is verified in browser observations. Include the observed evidence.",
            parameters: z.object({ summary: z.string().min(1).max(6000), evidence: z.string().min(1).max(6000) }).strict(),
            execute: async input => {
                if ([...this.records.values()].some(child => child.parentTaskId === record.id && !terminal.has(child.status))) return "A specialist is still working or waiting. Collect its result or ask the user for help before completing this task.";
                completion = input; return "Completion recorded. Give the user a concise final response.";
            } });
        const recoveryProgress = this.previousProgress(record);
        const session = this.createSession({ ...this.serviceOptions, settings: this.preferences.settings,
            sessionId: this.sessionId, manageTraceStore: false, taskBudget: budget,
            runnerOptions: service => ({ continueOnLimit: true, requireFreshObservation: Boolean(record.resumedFrom),
                recoveryProgress: record.stage === 1 ? recoveryProgress : null,
                recoveryGuidance: record.stage === 1 ? record.recoveryGuidance : undefined,
                onBrowserEvidence: observe,
                extraTools: [finish, ...this.coordinatorTools(record, service, observe)], taskInstructions: "This is a persistent scheduled task. Use request_user_help for missing information or blockers. When the requested result is verified, call complete_task with evidence before your final answer. Do not claim completion from a plan or from reaching a turn limit. " +
                (record.role === "research" ? "You are a research specialist. Read sources in your assigned tab and report relevant evidence and source URLs. Do not submit forms or make account changes unless the assigned task explicitly requires them. " : "For research needing another page, delegate_research opens a separate web tab with access by default and starts a specialist; respect any per-tab revocation. You can start independent specialists, then collect_worker_result before synthesizing. Do not invent worker results. ") }),
            onCheckpoint: async result => { record.checkpoint = checkpointHistory(result.history ?? []); await this.save(record); } });
        for (const [id, previous] of this.sessions) {
            const prior = this.records.get(id);
            if (previous.active || prior?.scope !== record.scope || previous.state.tabId !== record.tabId || this.isChat(prior) !== this.isChat(record)) continue;
            if (this.isChat(record) && !record.resumedFrom && previous.state.status === "completed") {
                session.history = previous.history;
                session.conversationTab = record.tabId;
            }
            this.sessions.delete(id);
        }
        this.sessions.set(record.id, session);
        this.executing.add(record.id);
        const notifiedRequests = new Set();
        session.subscribe(state => {
            if (!session.active) return;
            if (state.runId && record.runId !== state.runId) {
                record.runIds = [...new Set([...(record.runIds ?? []), record.runId, state.runId].filter(Boolean))];
                record.runId = state.runId;
            }
            const step = state.events.findLast(event => event.kind === "tool" && event.tool?.startsWith("browser_"));
            if (step) record.lastStep = { tool: step.tool, phase: step.phase };
            for (const request of state.requests ?? []) {
                if (notifiedRequests.has(request.id)) continue;
                notifiedRequests.add(request.id);
                this.notify(taskRequestAlert(record, request), { requestId: request.id, taskId: record.id }, request);
            }
            record.status = ["needs-input", "waiting-for-worker"].includes(state.status) ? state.status : ["paused", "pausing"].includes(state.status) ? "paused" : "running";
            void this.save(record).catch(error => { this.schedulerWarning = error.message; });
        });
        record.status = "running";
        const connection = this.connection;
        const execution = this.execute(record, session, () => completion, connection, budget, evidence).catch(error => {
            record.status = "failed"; record.summary = error.message;
            return this.save(record).catch(() => {});
        });
        this.executions.set(record.id, execution);
        void execution.finally(() => {
            this.executions.delete(record.id);
            if (![...this.executing].some(id => id === rootId || this.records.get(id)?.parentTaskId === rootId)) {
                budget.close();
                this.taskBudgets.delete(rootId);
            }
        });
    }
    async pauseDeclinedTask(session) {
        let root = [...this.records.values()].find(record => this.sessions.get(record.id) === session);
        if (!root) return;
        while (root.parentTaskId) {
            const parent = this.records.get(root.parentTaskId);
            if (!parent || parent.scope !== root.scope) break;
            root = parent;
        }
        const ids = new Set([root.id]);
        let changed;
        do {
            changed = false;
            for (const record of this.records.values()) if (record.scope === root.scope && ids.has(record.parentTaskId) && !ids.has(record.id)) {
                ids.add(record.id); changed = true;
            }
        } while (changed);
        const affected = [...this.records.values()].filter(record => ids.has(record.id) && !terminal.has(record.status));
        // Mark the whole related task tree before yielding. A coordinator or
        // queued specialist must not continue around the user's decision.
        for (const record of affected) {
            record.declinedRequest = session.declinedRequest;
            record.status = "paused";
            record.summary = "Paused because you declined a request. Review the task and give new direction before resuming.";
            const worker = this.sessions.get(record.id);
            if (worker?.active) {
                worker.declinedRequest = session.declinedRequest;
                worker.controller.abort(new Error(record.summary));
            }
        }
        await Promise.all(affected.map(record => this.save(record)));
    }
    async cancel(record) {
        record.cancelled = true;
        const session = this.sessions.get(record.id);
        if (session?.active) await session.command("stop", { runId: session.state.runId });
        record.status = "cancelled";
        await this.save(record);
        for (const child of this.records.values()) if (child.parentTaskId === record.id && !terminal.has(child.status)) await this.cancel(child);
    }
    coordinatorTools(record, session, observe) {
        if (record.role === "research" || !record.allowResearch) return [];
        return [tool({ name: "delegate_research", description: "Open a new web tab and start an independent research specialist. Web tabs have access by default; never override a user revocation. Returns a worker task ID. Collect its actual result before citing it.",
            parameters: z.object({ url: z.string().url().max(4000), task: z.string().min(1).max(10000) }).strict(), errorFunction: null,
            execute: async ({ url, task }) => {
                await session.checkpoint(); session.controller.signal.throwIfAborted();
                const parsed = new URL(url);
                if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("Research requires an HTTP(S) URL without credentials.");
                if (this.executing.size + this.reservations.size >= this.maxConcurrent) return "Worker capacity is full. Collect an existing worker result before delegating again, or ask the user to stop another task.";
                const reservation = randomUUID();
                this.reservations.add(reservation);
                try {
                const opened = await this.browser("open", record.tabId, { url: parsed.href, active: false });
                session.controller.signal.throwIfAborted();
                await session.checkpoint(); session.controller.signal.throwIfAborted();
                const available = await this.browser("tabs");
                if (!(Array.isArray(available) ? available : available.tabs).some(tab => tab.id === opened.tabId))
                    return "Access to the new research tab was revoked or the page is protected. Do not restore access yourself; ask the user for help in Settings.";
                const worker = await this.create({ ...this.input(record), tabId: opened.tabId, tabTitle: "Research specialist", prompt: task,
                    mode: "browser", notBefore: this.now(), repeatEveryMs: null, allowResearch: false, maxStages: Math.min(record.maxStages, 10) },
                    { parentTaskId: record.id, parentRunId: session.state.runId, role: "research" });
                if (session.controller.signal.aborted) {
                    await this.cancel(worker);
                    session.controller.signal.throwIfAborted();
                }
                await this.launch(worker);
                session.event("status", "Research specialist started", { workerId: worker.id, tabId: opened.tabId });
                return JSON.stringify({ workerId: worker.id, tabId: opened.tabId, instruction: "Use collect_worker_result with this worker ID to receive verified findings." });
                } finally { this.reservations.delete(reservation); }
            } }), tool({ name: "collect_worker_result", description: "Wait for one of this task's research specialists and return its actual outcome. Waiting makes no model calls.",
            parameters: z.object({ workerId: uuid }).strict(), errorFunction: null,
            execute: async ({ workerId }) => {
                const worker = this.records.get(workerId);
                if (!worker || worker.parentTaskId !== record.id || worker.scope !== record.scope) throw new Error("This worker does not belong to the current task.");
                return session.waitForWorker(() => new Promise((resolve, reject) => {
                    let unsubscribe = () => {};
                    const signal = session.controller.signal;
                    const cleanup = () => { unsubscribe(); signal.removeEventListener("abort", abort); };
                    const abort = () => { cleanup(); reject(signal.reason); };
                    const check = () => {
                        const current = this.records.get(workerId);
                        if (!terminal.has(current.status) && current.status !== "paused") return;
                        const result = { workerId, status: current.status, summary: current.summary, evidence: current.evidence, tabId: current.tabId };
                        if (current.status === "completed") observe("collect_worker_result", [current.summary, current.evidence]);
                        cleanup(); resolve(JSON.stringify(result));
                    };
                    unsubscribe = this.subscribe(check);
                    signal.addEventListener("abort", abort, { once: true });
                    if (signal.aborted) abort(); else check();
                }));
            } })];
    }
    async execute(record, session, completion, connection, budget, evidence) {
        let idleStages = 0;
        try {
            while (!record.cancelled && !record.declinedRequest && record.stage < record.maxStages) {
                if (budget.turns === 0) budget.exhaust("Task model turn limit reached.");
                if (budget.signal.aborted) break;
                const previousEvidence = evidence.size;
                record.stage++;
                await this.save(record);
                if (record.cancelled) { record.status = "cancelled"; break; }
                if (record.declinedRequest) { record.status = "paused"; break; }
                if (!connection || connection !== this.connection) { record.status = "interrupted"; record.interruption = "connection-lost"; break; }
                await session.command("start", { scope: record.scope, tabId: record.tabId, mode: record.mode, tabTitle: record.tabTitle,
                    prompt: record.stage === 1 ? record.prompt : "Continue the same task from your saved observations. Check the current page before acting. Call complete_task only after verifying the outcome." });
                await session.running;
                record.runId = session.state.runId;
                record.summary = session.state.events.findLast(event => event.kind === "assistant" || event.kind === "error")?.text ?? record.summary;
                if (record.cancelled) { record.status = "cancelled"; break; }
                if (record.declinedRequest || session.declinedRequest) {
                    record.declinedRequest ??= session.declinedRequest;
                    record.status = "paused";
                    record.summary = "Paused because you declined a request. Review the task and give new direction before resuming.";
                    break;
                }
                if (budget.signal.aborted) break;
                if (connection !== this.connection || session.state.status !== "completed") {
                    record.status = connection !== this.connection || session.state.status === "stopped" ? "interrupted" : "failed";
                    if (connection !== this.connection) record.interruption = "connection-lost";
                    break;
                }
                if (completion() && ![...this.records.values()].some(child => child.parentTaskId === record.id && !terminal.has(child.status))) { record.status = "completed"; record.summary = completion().summary; record.evidence = completion().evidence; break; }
                idleStages = evidence.size > previousEvidence ? 0 : idleStages + 1;
                if (idleStages >= noProgressStageLimit) {
                    const reason = "Three consecutive stages produced no new browser evidence. Review progress before continuing.";
                    if (!record.parentTaskId) budget.exhaust(reason);
                    record.status = "paused";
                    record.summary = reason;
                    break;
                }
                record.status = "continuing";
                await this.save(record);
            }
            if (!terminal.has(record.status) && !record.declinedRequest && (budget.signal.aborted || record.status !== "paused")) {
                record.status = "paused";
                record.summary = budget.signal.reason?.message ?? "Continuation limit reached. Review progress and resume explicitly.";
            }
            if (record.status === "completed" && record.repeatEveryMs && !record.cancelled) {
                record.nextOccurrenceId = randomUUID();
                record.nextOccurrenceAt = this.now() + record.repeatEveryMs;
            }
            await this.save(record);
            if (record.status === "completed" && !record.parentTaskId) this.notify({ subject: "TabPilot task completed",
                message: `Task: ${record.id}\nTab: ${record.tabId}\n\n${record.summary || "Verified completion recorded."}`.slice(0, 3000) }, { taskId: record.id });
            await this.scheduleRepeat(record).catch(() => {
                // The verified result and next occurrence intent are already saved.
                // Retry only the scheduling write, so no browser action is repeated.
            });
        } finally { this.executing.delete(record.id); this.emit(); }
    }
    async close() {
        clearInterval(this.timer);
        this.disconnect();
        await Promise.allSettled([...this.executions.values()]);
        await Promise.allSettled([...this.pendingNotifications]);
    }
}
