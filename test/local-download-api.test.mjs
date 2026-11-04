import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createBridge, requireObservedDownload } from "../server.mjs";
import { LocalDownloads } from "../local-downloads.mjs";

test("explicit local download saves real bytes through the bridge; native cancellation never switches methods", async t => {
    const root = fileURLToPath(new URL("../.tabpilot/", import.meta.url));
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "local-api-test-"));
    t.after(async () => { assert.equal(resolve(dirname(directory)), resolve(root)); await rm(directory, { recursive: true, force: true }); });
    const token = "d".repeat(64), scope = randomUUID(), url = "https://example.com/report.txt";
    let fetches = 0;
    const downloads = new LocalDownloads({ directory: () => directory, permitted: async context => context.scope === scope && context.tabId === 12,
        fetchImpl: async () => { fetches++; return new Response("verified public report"); } });
    const bridge = createBridge({ token, localDownloads: downloads,
        validateLocalDownload: ({ url: target }) => requireObservedDownload({ url: "https://example.com/", elements: [{ href: url }] }, target) });
    await new Promise(resolve => bridge.server.listen(0, "127.0.0.1", resolve));
    t.after(() => bridge.close());
    const base = `http://127.0.0.1:${bridge.server.address().port}`;
    const socket = new WebSocket(base.replace("http:", "ws:") + "/extension", { origin: `chrome-extension://${"d".repeat(32)}` });
    await once(socket, "open");
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ type: "authenticate", token, historyScope: scope }));
    await ready;
    socket.on("message", data => {
        const message = JSON.parse(data);
        if (message.type === "request") socket.send(JSON.stringify({ type: "response", id: message.id, ok: false, error: "USER_CANCELED" }));
    });
    const command = async (method, tabId, params) => {
        const response = await fetch(base + "/command", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ method, tabId, params }) });
        return { status: response.status, body: await response.json() };
    };
    const native = await command("download", 12, { url });
    assert.equal(native.body.error, "USER_CANCELED");
    assert.equal(fetches, 0);
    assert.equal(downloads.jobs.size, 0);
    const invalid = await command("download-local", 12, { url: "https://example.com/unobserved" });
    assert.equal(invalid.status, 409);
    assert.equal(fetches, 0);
    const started = await command("download-local", 12, { url, filename: "reports/readme.txt" });
    assert.equal(started.status, 200);
    await downloads.jobs.get(started.body.data.id).done;
    const complete = await command("download-local-status", 12, { downloadId: started.body.data.id });
    assert.equal(complete.body.data.state, "complete");
    assert.equal(await readFile(complete.body.data.path, "utf8"), "verified public report");
    assert.equal(JSON.stringify(complete.body).includes("verified public report"), false, "file bytes stay out of model responses");
    assert.equal((await command("download-local-status", 34, { downloadId: started.body.data.id })).status, 409);
});
