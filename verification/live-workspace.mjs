// Opt-in acceptance check: schedules one real agent task and saves one PUBLIC
// practice file. Requires a paired bridge, enabled practice tab, and API access.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { requestBridge, requestTask } from "../bridge-client.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pause = () => new Promise(resolve => setTimeout(resolve, 1000));
const tabs = await requestBridge("tabs");
const tab = tabs.find(tab => tab.url === "http://127.0.0.1:4322/");
assert.ok(tab, "Enable the practice tab before running this check.");
const taskPrompt = `Read this page and report its title without changing anything. Verification ${randomUUID()}.`;
const notBefore = Date.now() + 60000;
const initial = await requestTask({ method: "task-create", payload: { tabId: tab.id, tabTitle: tab.title,
    prompt: taskPrompt, mode: "browser", notBefore, maxStages: 3, allowResearch: false } });
const scheduled = initial.tasks.find(task => task.prompt === taskPrompt);
assert.equal(scheduled.status, "scheduled");
assert.equal(scheduled.stage, 0);
console.log(JSON.stringify({ taskId: scheduled.id, state: "scheduled", dueAt: new Date(notBefore).toISOString() }));

// The explicit local option is independent of Chrome's native download chooser.
const sourceUrl = "http://127.0.0.1:4322/sample-report.txt";
const expected = Buffer.from(await (await fetch(sourceUrl)).arrayBuffer());
const download = await requestBridge("download-local", tab.id, { url: sourceUrl, filename: `verification/report-${randomUUID()}.txt` });
let file;
const deadline = Date.now() + 240000;
let task = scheduled, previous = task.status;
while (Date.now() < deadline) {
    const listed = await requestTask({ method: "task-list", payload: { tabId: tab.id } });
    task = listed.tasks.find(task => task.id === scheduled.id);
    assert.ok(task);
    if (Date.now() < notBefore) assert.equal(task.stage, 0, "Task started before its scheduled time");
    if (task.status !== previous) { console.log(JSON.stringify({ taskId: task.id, state: task.status })); previous = task.status; }
    if (!file) {
        const status = await requestBridge("download-local-status", tab.id, { downloadId: download.id });
        if (status.state === "complete") {
            const saved = await readFile(status.path);
            assert.deepEqual(saved, expected);
            file = { id: status.id, path: status.path, bytes: saved.length, sha256: createHash("sha256").update(saved).digest("hex") };
            console.log(JSON.stringify({ download: "verified", bytes: saved.length, path: status.path }));
        } else assert.equal(status.state, "in_progress", status.error);
    }
    if (task.status === "completed" && file) break;
    assert.ok(!["failed", "interrupted", "cancelled", "paused", "needs-input"].includes(task.status), task.summary || task.status);
    await pause();
}
assert.equal(task.status, "completed", "Scheduled task did not complete in time");
assert.ok(file);
const directory = new URL("../.tabpilot/verification/", import.meta.url);
const historyRoot = new URL("../.tabpilot/history/", import.meta.url);
const folder = join(fileURLToPath(historyRoot), task.scope, `tab-${tab.id}`, task.runId);
const meta = JSON.parse(await readFile(join(folder, "meta.json"), "utf8"));
assert.ok(meta.startedAt >= notBefore, "Archived run started before its scheduled time");
const events = (await readFile(join(folder, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
assert.ok(events.some(event => event.kind === "tool" && event.tool === "complete_task" && event.phase === "complete"), "Completion tool trace missing");
const orders = await (await fetch("http://127.0.0.1:4322/api/state")).json();
assert.equal(orders.orders.length, 0);
const report = { checkedAt: new Date().toISOString(), tabId: tab.id, scheduled: { id: task.id, notBefore, startedAt: meta.startedAt,
    completedAt: meta.endedAt, status: task.status, summary: task.summary, evidence: task.evidence }, file, practiceOrders: 0 };
await mkdir(directory, { recursive: true });
await writeFile(new URL("workspace-live-report.json", directory), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ result: "passed", report: "workspace-live-report.json" }));
