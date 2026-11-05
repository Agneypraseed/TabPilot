import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RunContext } from "@openai/agents";
import { TaskManager } from "../task-manager.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
test("repeat schedules only after successful completion and canceling the next occurrence prevents execution", async () => {
    let calls = 0;
    const ui = setup(async (_prompt, options) => { calls++; return complete(options); });
    await ui.manager.connected({ scope: ui.scope });
    await ui.create({ repeatEveryMs: 60000 });
    await until(() => !ui.manager.active && ui.records.size === 2);
    const first = [...ui.records.values()].find(record => record.status === "completed");
    const next = [...ui.records.values()].find(record => record.status === "scheduled");
    assert.equal(next.seriesId, first.id);
    assert.equal(next.notBefore, 61000);
    await ui.manager.tick();
    assert.equal(calls, 1);
    await ui.manager.command("task-cancel", { taskId: next.id, scope: ui.scope });
    ui.advance(60000);
    await ui.manager.tick();
    assert.equal(calls, 1);
    assert.equal(ui.records.get(next.id).status, "cancelled");
    await ui.manager.close();
});
test("stopping coordinator during child persistence cannot launch the new specialist", async () => {
    let release, blocked = false, childCalls = 0;
    const barrier = new Promise(resolve => { release = resolve; });
    const ui = setup(async (_prompt, options) => {
        if (options.targetTabId !== 12) { childCalls++; return complete(options); }
        await options.extraTools.find(tool => tool.name === "delegate_research").invoke(new RunContext(), JSON.stringify({ url: "https://example.com/research", task: "Read source" }));
        return complete(options);
    }, { browser: async method => method === "tabs" ? [{ id: 12 }, { id: 90 }] : { tabId: 90, url: "https://example.com/research", enabled: true } });
    const save = ui.manager.store.upsert;
    ui.manager.store.upsert = async record => {
        if (record.role === "research" && record.status === "queued" && !blocked) { blocked = true; await barrier; }
        return save(record);
    };
    await ui.manager.connected({ scope: ui.scope });
    await ui.create();
    await until(() => blocked);
    const parent = [...ui.manager.records.values()].find(record => !record.parentTaskId);
    await ui.manager.command("task-cancel", { taskId: parent.id, scope: ui.scope });
    release();
    await until(() => !ui.manager.active);
    assert.equal(childCalls, 0);
    assert.equal([...ui.manager.records.values()].find(record => record.role === "research").status, "cancelled");
    await ui.manager.close();
});
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await flush(); } assert.fail("Task did not settle"); }
function setup(run, options = {}) {
    const records = new Map();
    const scope = randomUUID(), profileId = randomUUID();
    let clock = 1000, tabs = [{ id: 12 }, { id: 34 }];
    const manager = new TaskManager({ store: { load: async () => [], upsert: async record => { records.set(record.id, structuredClone(record)); return structuredClone(record); } },
        browser: async () => ({ tabs }), now: () => clock, autoTick: false,
        serviceOptions: { env: { META_API_KEY: "fixture", AGENT_PROVIDER: "meta", AGENT_MODEL: "fixture" }, run,
            configure: async () => ({ model: {}, modelSettings: {}, close: async () => {} }) }, ...options });
    const create = input => manager.command("task-create", { prompt: "Read the page", mode: "browser", scope, tabId: 12, ...input });
    return { manager, records, scope, profileId, create, advance: ms => { clock += ms; }, disable: () => { tabs = []; } };
}
async function complete(options) {
    await options.extraTools.find(tool => tool.name === "complete_task").invoke(new RunContext(), JSON.stringify({ summary: "Read page", evidence: "Observed current title and content" }));
    return { answer: "Read page", history: [{ role: "assistant", content: "Read page" }] };
}

test("permission alerts are sent once and cannot answer or bypass the pending approval", async t => {
    const messages = [], responses = [];
    let blocked = true;
    const ui = setup(async (_prompt, options) => {
        responses.push(await options.requestHuman({ kind: "approval", question: "Send the prepared report?", detail: "This sends an email." }));
        blocked = false;
        return complete(options);
    }, { notifications: { status: () => ({ telegram: { configured: true } }), send: async input => {
        messages.push(input); return { accepted: true };
    } } });
    t.after(() => ui.manager.close());
    await ui.manager.connected({ scope: ui.scope });
    await ui.create();
    await until(() => messages.length === 1);
    const request = ui.manager.snapshot().requests[0];
    assert.equal(blocked, true);
    assert.match(messages[0].subject, /permission/);
    assert.match(messages[0].message, /Send the prepared report/);
    assert.ok(!messages[0].message.includes(request.id), "Internal request IDs do not replace the action description");
    assert.deepEqual(responses, []);
    const session = [...ui.manager.sessions.values()][0];
    session.emit(); session.emit();
    await flush();
    assert.equal(messages.length, 1, "Repeated state updates must not send duplicate alerts");
    await ui.manager.command("human-response", { id: request.id, runId: request.runId, scope: ui.scope, decision: "approve" });
    await until(() => !ui.manager.active && messages.length === 2);
    assert.equal(responses[0].decision, "approve");
    assert.equal(blocked, false);
    assert.equal(ui.manager.snapshot().requests.length, 0);
    assert.match(messages[1].subject, /completed/);
    assert.match(messages[1].message, /Read page/);
});

test("repeating tasks notify once for each verified occurrence", async t => {
    const messages = [];
    const ui = setup(async (_prompt, options) => complete(options), { notifications: {
        status: () => ({ email: { configured: true } }), send: async input => { messages.push(input); return { accepted: true }; }
    } });
    t.after(() => ui.manager.close());
    await ui.manager.connected({ scope: ui.scope });
    await ui.create({ repeatEveryMs: 60000 });
    await until(() => !ui.manager.active && ui.records.size === 2);
    ui.advance(60000);
    await ui.manager.tick();
    await until(() => !ui.manager.active && ui.records.size === 3);
    await ui.manager.tick();
    assert.equal(messages.length, 2);
    assert.notEqual(messages[0].message, messages[1].message, "Each occurrence identifies its own task");
});

test("a continuation limit or failed run never sends a completion alert", async t => {
    for (const run of [async () => ({ answer: "Not finished", history: [] }), async () => { throw new Error("Model failed"); }]) {
        const messages = [];
        const ui = setup(run, { notifications: { status: () => ({ email: { configured: true } }), send: async input => {
            messages.push(input); return { accepted: true };
        } } });
        t.after(() => ui.manager.close());
        await ui.manager.connected({ scope: ui.scope });
        await ui.create({ maxStages: 2 });
        await until(() => !ui.manager.active);
        assert.deepEqual(messages, []);
        assert.notEqual([...ui.records.values()][0].status, "completed");
    }
});

test("notification failures cannot fail a completed task or suppress its repeat", async t => {
    const ui = setup(async (_prompt, options) => complete(options), { notifications: {
        status: () => ({ email: { configured: true } }), send: async () => { throw new Error("private provider failure"); }
    } });
    t.after(() => ui.manager.close());
    await ui.manager.connected({ scope: ui.scope });
    await ui.create({ repeatEveryMs: 60000 });
    await until(() => !ui.manager.active && ui.records.size === 2 && ui.manager.snapshot().notificationWarning);
    assert.equal([...ui.records.values()].filter(record => record.status === "completed").length, 1);
    assert.equal([...ui.records.values()].filter(record => record.status === "scheduled").length, 1);
    assert.ok(!ui.manager.snapshot().notificationWarning.includes("private provider failure"));
});

test("scheduler waits without model calls, enforces enabled tab and records explicit completion", async () => {
    let calls = 0;
    const ui = setup(async (_prompt, options) => { calls++; return complete(options); });
    await ui.manager.connected({ scope: ui.scope, profileId: ui.profileId });
    await ui.create({ notBefore: 2000 });
    assert.equal(calls, 0);
    ui.advance(1000); ui.disable();
    await ui.manager.tick();
    assert.equal(calls, 0);
    assert.equal([...ui.records.values()][0].status, "waiting-for-tab");
    await ui.manager.close();

    const live = setup(async (_prompt, options) => complete(options));
    await live.manager.connected({ scope: live.scope });
    await live.create();
    await until(() => [...live.records.values()][0]?.status === "completed");
    const job = [...live.records.values()][0];
    assert.equal(job.evidence, "Observed current title and content");
    assert.equal(live.manager.snapshot().status, "completed");
    await live.manager.close();
});

test("concurrent tabs run independently while same-tab tasks queue and cancellation is durable", async () => {
    const releases = new Map(), starts = [];
    const ui = setup(async (_prompt, options) => {
        starts.push(options.targetTabId);
        await new Promise(resolve => releases.set(options.targetTabId, resolve));
        return complete(options);
    });
    await ui.manager.connected({ scope: ui.scope });
    await ui.create(); await ui.create(); await ui.create({ tabId: 34 });
    await until(() => starts.length === 2);
    assert.deepEqual(starts, [12, 34]);
    const queued = [...ui.records.values()].find(record => record.status === "queued");
    await ui.manager.command("task-cancel", { taskId: queued.id, scope: ui.scope });
    releases.get(12)(); releases.get(34)();
    await until(() => !ui.manager.active);
    await ui.manager.tick();
    assert.equal(starts.length, 2);
    assert.equal(ui.records.get(queued.id).status, "cancelled");
    await ui.manager.close();
});

test("turn/final-answer limits continue with tool history and never claim completion", async () => {
    const histories = [];
    const ui = setup(async (_prompt, options) => {
        histories.push(options.history);
        return { answer: "Still working", continuation: true, history: [{ role: "assistant", content: "Observed step" }] };
    });
    await ui.manager.connected({ scope: ui.scope });
    await ui.create({ maxStages: 2 });
    await until(() => !ui.manager.active);
    assert.equal(histories.length, 2);
    assert.equal(histories[1][0].content, "Observed step");
    assert.equal([...ui.records.values()][0].status, "paused");
    await ui.manager.close();
});

test("rotated tab namespace requires explicit rebind and isolates other browser profiles", async () => {
    const ui = setup(async (_prompt, options) => complete(options));
    await ui.manager.connected({ scope: ui.scope, profileId: ui.profileId });
    await ui.create({ notBefore: 9000 });
    const old = [...ui.records.values()][0];
    await ui.manager.connected({ scope: randomUUID(), profileId: ui.profileId });
    assert.equal(ui.manager.snapshot().jobs[0].needsRebind, true);
    await ui.manager.command("task-resume", { taskId: old.id, tabId: 34 });
    await until(() => !ui.manager.active);
    const rebound = [...ui.records.values()].find(record => record.resumedFrom === old.id);
    assert.equal(rebound.tabId, 34);
    assert.notEqual(rebound.scope, old.scope);
    assert.equal(ui.records.get(old.id).status, "cancelled");
    await ui.manager.connected({ scope: randomUUID(), profileId: randomUUID() });
    assert.equal(ui.manager.snapshot().jobs.length, 0);
    await ui.manager.close();
});

test("coordinator opens accessible research tabs without approval and collects real worker results", async () => {
    const opened = [], grants = [], results = [], requests = [];
    const invoke = (options, name, args) => options.extraTools.find(tool => tool.name === name).invoke(new RunContext(), JSON.stringify(args));
    const ui = setup(async (_prompt, options) => {
        if (options.targetTabId !== 12) {
            assert.equal(options.extraTools.some(tool => tool.name === "delegate_research"), false);
            return complete(options);
        }
        const ids = [];
        for (const url of ["https://example.com/a", "https://example.com/b"]) {
            const worker = JSON.parse(await invoke(options, "delegate_research", { url, task: "Read source and report evidence" }));
            ids.push(worker.workerId);
        }
        for (const workerId of ids) results.push(JSON.parse(await invoke(options, "collect_worker_result", { workerId })));
        return complete(options);
    }, { browser: async (method, _tabId, params) => {
        if (method === "tabs") return [{ id: 12 }, ...opened.map(tab => ({ id: tab.tabId }))];
        assert.equal(method, "open");
        const result = { tabId: 90 + opened.length, url: params.url, enabled: true };
        opened.push(result); return result;
    } });
    ui.manager.approveResearchTab = async input => { grants.push(input); };
    ui.manager.subscribe(state => requests.push(...state.requests));
    await ui.manager.connected({ scope: ui.scope });
    await ui.create();
    await until(() => !ui.manager.active);
    assert.equal(opened.length, 2);
    assert.deepEqual(grants, [], "Research must not use the obsolete private grant route");
    assert.deepEqual(requests, [], "Default tab access must not request human approval");
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.status === "completed" && result.evidence.includes("Observed")));
    assert.equal([...ui.records.values()].filter(record => record.role === "research").length, 2);
    await ui.manager.close();
});

test("a newly revoked research tab cannot start a specialist or restore its own access", async () => {
    const calls = [], grants = [], requests = [], results = [];
    let childCalls = 0;
    const ui = setup(async (_prompt, options) => {
        if (options.targetTabId !== 12) { childCalls++; return complete(options); }
        results.push(await options.extraTools.find(tool => tool.name === "delegate_research").invoke(new RunContext(),
            JSON.stringify({ url: "https://example.com/revoked", task: "Read source" })));
        return complete(options);
    }, { browser: async method => {
        calls.push(method);
        if (method === "tabs") return [{ id: 12 }];
        assert.equal(method, "open", "Delegation must never issue an access-restoration command");
        return { tabId: 90, url: "https://example.com/revoked", enabled: false };
    } });
    ui.manager.approveResearchTab = async input => { grants.push(input); };
    ui.manager.subscribe(state => requests.push(...state.requests));
    await ui.manager.connected({ scope: ui.scope });
    await ui.create();
    await until(() => !ui.manager.active);
    assert.equal(childCalls, 0);
    assert.equal([...ui.records.values()].filter(record => record.role === "research").length, 0);
    assert.match(results[0], /revoked|protected/i);
    assert.deepEqual(grants, []);
    assert.deepEqual(requests, []);
    assert.equal(calls.filter(method => method === "open").length, 1);
    assert.equal(calls.at(-1), "tabs", "Access must be rechecked after opening the tab");
    await ui.manager.close();
});


for (const kind of ["approval", "information", "handoff"]) test(`denying ${kind} pauses the task without another stage, repeated prompt or repeat schedule`, async t => {
    let calls = 0, afterDenial = 0;
    const messages = [];
    const ui = setup(async (_prompt, options) => {
        calls++;
        await options.requestHuman({kind, question: "May I continue?", detail: "Controlled denial regression"});
        afterDenial++;
        return {answer:"Unable to finish",history:[]};
    }, {notifications:{status:()=>({telegram:{configured:true}}),send:async input=>{messages.push(input);return {accepted:true};}}});
    t.after(()=>ui.manager.close());
    await ui.manager.connected({scope:ui.scope});await ui.create({maxStages:4,repeatEveryMs:60000});
    await until(()=>ui.manager.snapshot().requests.length===1);
    const request=ui.manager.snapshot().requests[0];
    await ui.manager.command("human-response",{id:request.id,runId:request.runId,scope:ui.scope,decision:"deny"});
    await until(()=>!ui.manager.active || calls>1);
    assert.equal(calls,1,"Deny cannot relaunch the model in another stage");
    assert.equal(afterDenial,0,"No work may proceed after Deny");
    assert.equal(ui.records.size,1,"No repeating occurrence may be scheduled");
    const record=[...ui.records.values()][0];assert.equal(record.status,"paused");assert.match(record.summary,/declined/i);
    assert.equal(ui.manager.snapshot().requests.length,0);
    await ui.manager.tick();assert.equal(calls,1);
    assert.equal(messages.filter(message=>/completed/.test(message.subject)).length,0);
});


test("denying a specialist pauses its coordinator tree while unrelated tasks can continue", async t => {
    let rootContinued=0,workerContinued=0;
    const ui=setup(async(_prompt,options)=>{
        if(options.targetTabId===34){await options.requestHuman({kind:"information",question:"Unrelated task question",detail:"Other task"});return complete(options);}
        if(options.targetTabId===90){await options.requestHuman({kind:"handoff",question:"Specialist needs manual help",detail:"Worker task"});workerContinued++;return complete(options);}
        const worker=JSON.parse(await options.extraTools.find(tool=>tool.name==="delegate_research").invoke(new RunContext(),JSON.stringify({url:"https://example.com/research",task:"Read a source"})));
        await options.extraTools.find(tool=>tool.name==="collect_worker_result").invoke(new RunContext(),JSON.stringify({workerId:worker.workerId}));
        rootContinued++;return complete(options);
    },{browser:async method=>method==="tabs"?[{id:12},{id:34},{id:90}]:{tabId:90,url:"https://example.com/research",enabled:true}});
    t.after(()=>ui.manager.close());
    await ui.manager.connected({scope:ui.scope});await ui.create();
    await until(()=>ui.manager.snapshot().requests.some(request=>request.tabId===90));
    await ui.create({tabId:34});await until(()=>ui.manager.snapshot().requests.length===2);
    const denied=ui.manager.snapshot().requests.find(request=>request.tabId===90);
    await ui.manager.command("human-response",{id:denied.id,runId:denied.runId,scope:ui.scope,decision:"deny"});
    await until(()=>[...ui.manager.records.values()].filter(record=>record.tabId!==34).every(record=>record.status==="paused")&&ui.manager.executing.size===1);
    assert.equal(workerContinued,0);assert.equal(rootContinued,0);
    const other=ui.manager.snapshot().requests[0];assert.equal(other.tabId,34);
    await ui.manager.command("human-response",{id:other.id,runId:other.runId,scope:ui.scope,decision:"answer",text:"Proceed"});
    await until(()=>!ui.manager.active);
    assert.equal([...ui.records.values()].find(record=>record.tabId===34).status,"completed");
});


test("a denial also prevents a related worker from starting after a pending stage save", async t => {
    let release,blocked=false,workerCalls=0;
    const barrier=new Promise(resolve=>{release=resolve;});
    const ui=setup(async(_prompt,options)=>{
        if(options.targetTabId===90){workerCalls++;return complete(options);}
        await options.extraTools.find(tool=>tool.name==="delegate_research").invoke(new RunContext(),JSON.stringify({url:"https://example.com/research",task:"Read a source"}));
        await options.requestHuman({kind:"approval",question:"Continue with the report?",detail:"Test a paused worker"});
        return complete(options);
    },{browser:async method=>method==="tabs"?[{id:12},{id:90}]:{tabId:90,url:"https://example.com/research",enabled:true}});
    t.after(async()=>{release();await ui.manager.close();});
    const save=ui.manager.store.upsert;
    ui.manager.store.upsert=async record=>{
        if(record.role==="research"&&record.stage===1&&!blocked){blocked=true;await barrier;}
        return save(record);
    };
    await ui.manager.connected({scope:ui.scope});await ui.create();
    await until(()=>blocked&&ui.manager.snapshot().requests.length===1);
    const request=ui.manager.snapshot().requests[0];
    await ui.manager.command("human-response",{id:request.id,runId:request.runId,scope:ui.scope,decision:"deny"});
    release();await until(()=>!ui.manager.active);
    assert.equal(workerCalls,0);
    assert.ok([...ui.records.values()].every(record=>record.status==="paused"));
});

test("a task denied by the user restarts only on an explicit resume",async t=>{
    let calls=0;
    const ui=setup(async(_prompt,options)=>{
        if(++calls===1)await options.requestHuman({kind:"information",question:"Choose a report",detail:"Test denial"});
        return complete(options);
    });t.after(()=>ui.manager.close());
    await ui.manager.connected({scope:ui.scope});await ui.create();
    await until(()=>ui.manager.snapshot().requests.length===1);
    const request=ui.manager.snapshot().requests[0];
    await ui.manager.command("human-response",{id:request.id,runId:request.runId,scope:ui.scope,decision:"deny"});
    await until(()=>!ui.manager.active);await ui.manager.tick();assert.equal(calls,1);
    const original=[...ui.records.values()][0];ui.advance(1);
    await ui.manager.command("task-resume",{taskId:original.id,tabId:12,scope:ui.scope});
    await until(()=>!ui.manager.active);
    assert.equal(calls,2);assert.equal(ui.records.get(original.id).status,"cancelled");
    assert.equal([...ui.records.values()].find(record=>record.resumedFrom===original.id).status,"completed");
});
