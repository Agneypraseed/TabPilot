// Local task controls; all model execution and persistence live in the bridge.
class TabPilotTaskView {
    constructor({ document, command, selected, notice, viewAgent, mode }) {
        this.document = document;
        this.command = command;
        this.selected = selected;
        this.notice = notice;
        this.viewAgent = viewAgent;
        this.mode = mode;
        this.$ = id => document.getElementById(id);
        this.$("schedule-form").addEventListener("submit", event => void this.schedule(event));
    }
    async schedule(event) {
        event.preventDefault();
        const tab = this.selected();
        if (!tab || this.$("schedule-submit").disabled) return;
        this.$("schedule-submit").disabled = true;
        try {
            const at = this.$("schedule-at").value;
            const notBefore = at ? new Date(at).getTime() : Date.now();
            if (!Number.isSafeInteger(notBefore) || notBefore < 0) throw new Error("Choose a valid start time.");
            await this.command("task-create", { tabId: tab.id, tabTitle: tab.title, mode: this.mode(),
                prompt: this.$("schedule-prompt").value.trim(), notBefore,
                repeatEveryMs: Number(this.$("schedule-repeat").value) || null,
                maxStages: Number(this.$("schedule-stages").value), allowResearch: this.$("schedule-research").checked });
            this.$("schedule-prompt").value = "";
            this.notice("Task added. It will wait if tab access is disabled.", true);
        } catch (error) { this.notice(error.message); }
        finally { this.$("schedule-submit").disabled = false; }
    }
    element(tag, text, className) {
        const item = this.document.createElement(tag);
        if (text !== undefined) item.textContent = text;
        if (className) item.className = className;
        return item;
    }
    action(row, text, operation) {
        const button = this.element("button", text);
        button.type = "button";
        button.addEventListener("click", async () => {
            button.disabled = true;
            try { await operation(); } catch (error) { this.notice(error.message); }
            finally { button.disabled = false; }
        });
        row.append(button);
    }
    row(job, child = false) {
        const article = this.element("article", undefined, `task-row${child ? " task-worker" : ""}`);
        const heading = this.element("div", undefined, "task-heading");
        heading.append(this.element("strong", job.prompt.split("\n")[0]));
        const status = job.needsRebind && !["completed", "cancelled"].includes(job.status) ? "Choose a tab" : {
            running: "Working", "waiting-for-worker": "Waiting for specialists", "needs-input": "Needs help",
            scheduled: "Scheduled", queued: "Queued", "waiting-for-tab": "Enable tab", completed: "Completed",
            interrupted: "Interrupted", failed: "Failed", paused: "Review to continue", cancelled: "Cancelled", continuing: "Continuing"
        }[job.status] || job.status;
        heading.append(this.element("span", status, `task-status ${job.status === "needs-input" ? "attention" : ""}`));
        article.append(heading);
        const when = job.notBefore > Date.now() ? new Date(job.notBefore).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "";
        if (!child) article.append(this.element("p", `${job.role === "research" ? "Research specialist" : "Coordinator"} · Stage ${job.stage || 0} of ${job.maxStages || 20}${when ? ` · ${when}` : ""}${job.repeatEveryMs ? ` · Every ${job.repeatEveryMs / 60000} minutes` : ""}`, "help"));
        const activity = job.status === "needs-input" ? "Waiting for your reply" : job.status === "waiting-for-worker" ? "Waiting for research findings" : ["completed", "failed", "interrupted", "paused"].includes(job.status) ? job.summary : job.activity || job.summary;
        if (activity) article.append(this.element("p", activity.replace(/^browser_/, "").replaceAll("_", " "), "task-activity"));
        const actions = this.element("div", undefined, "task-actions");
        if (!job.needsRebind && !["queued", "scheduled", "waiting-for-tab"].includes(job.status)) this.action(actions, child ? "View" : "View agent", () => this.viewAgent(job));
        if (job.needsRebind && !["completed", "cancelled"].includes(job.status) || ["interrupted", "failed", "paused"].includes(job.status))
            this.action(actions, job.needsRebind ? "Use selected tab" : "Review and resume", () => {
                const tab = this.selected();
                if (!tab) throw new Error("Choose a tab above first.");
                return this.command("task-resume", { taskId: job.id, tabId: tab.id });
            });
        if (!child && !["completed", "failed", "cancelled", "interrupted"].includes(job.status))
            this.action(actions, ["queued", "scheduled", "waiting-for-tab"].includes(job.status) ? "Cancel" : "Stop", () => this.command("task-cancel", { taskId: job.id }));
        article.append(actions);
        return article;
    }
    render(state, connected) {
        this.$("schedule-submit").disabled = !connected || !this.selected() || !state?.jobs;
        const all = state?.jobs || [];
        const roots = all.filter(job => job.tabId === this.selected()?.id || (!job.parentTaskId && job.needsRebind)).sort((a,b) => b.createdAt - a.createdAt);
        const relevant = all.filter(job => roots.some(root => root.id === job.id || root.id === job.parentTaskId));
        const working = relevant.filter(job => ["running", "continuing", "waiting-for-worker"].includes(job.status)).length;
        const waiting = relevant.filter(job => job.status === "needs-input").length;
        this.$("tasks-summary").textContent = state?.schedulerWarning || state?.notificationWarning || (!connected ? "Connect the local bridge to manage tasks." : !state?.jobs ? "Restart the bridge to enable Tasks." : relevant.length ? `${working} working · ${waiting} need help` : "No tasks for this tab yet.");
        this.$("tasks-list").replaceChildren();
        for (const root of roots.slice(0, 50)) {
            this.$("tasks-list").append(this.row(root));
            const workers = all.filter(job => job.parentTaskId === root.id);
            if (workers.length) {
                const group = this.element("div", undefined, "task-workers");
                for (const worker of workers) group.append(this.row(worker, true));
                this.$("tasks-list").append(group);
            }
        }
    }
}
globalThis.TabPilotTaskView = TabPilotTaskView;
