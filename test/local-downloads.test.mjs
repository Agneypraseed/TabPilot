import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { LocalDownloads } from "../local-downloads.mjs";

const scope = randomUUID(), tabId = 12, url = "https://example.com/report.txt";
const input = { scope, tabId, url };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), "tabpilot-local-download-"));
    const downloads = new LocalDownloads({ directory: () => directory, permitted: async () => true,
        fetchImpl: async () => new Response("public file bytes"), ...options });
    t.after(async () => { await downloads.close(); await rm(directory, { recursive: true, force: true }); });
    return { directory, downloads };
}
const finish = async (downloads, started) => { await downloads.jobs.get(started.id).done; return downloads.status({ scope, tabId, downloadId: started.id }); };

test("public file streams to the configured folder, preserves existing bytes, and reports completion", async t => {
    const calls = [];
    const { directory, downloads } = await fixture(t, { fetchImpl: async (target, options) => {
        calls.push({ target, options }); return new Response("public file bytes");
    } });
    await writeFile(join(directory, "report.txt"), "original");
    const started = await downloads.start(input);
    assert.equal(started.state, "in_progress");
    assert.match(started.id, /^[a-f0-9-]{36}$/);
    const result = await finish(downloads, started);
    assert.equal(result.state, "complete");
    assert.equal(result.filename, "report (1).txt");
    assert.equal(result.bytesReceived, 17);
    assert.equal(result.path, join(directory, "report (1).txt"));
    assert.equal(await readFile(result.path, "utf8"), "public file bytes");
    assert.equal(await readFile(join(directory, "report.txt"), "utf8"), "original");
    assert.equal(calls[0].options.credentials, "omit");
    assert.equal(calls[0].options.redirect, "manual");
    assert.equal(calls[0].options.headers, undefined);
    assert.deepEqual((await readdir(directory)).sort(), ["report (1).txt", "report.txt"]);
});

test("safe nested relative filenames are created under the user setting, not caller paths", async t => {
    const { directory, downloads } = await fixture(t);
    const result = await finish(downloads, await downloads.start({ ...input, filename: "research/資料.txt", directory: "ignored" }));
    assert.equal(result.state, "complete");
    assert.equal(result.path, join(directory, "research", "資料.txt"));
});

test("concurrent downloads publish unique files without overwriting each other", async t => {
    const { directory, downloads } = await fixture(t);
    const jobs = await Promise.all([downloads.start(input), downloads.start(input), downloads.start(input)]);
    const results = await Promise.all(jobs.map(job => finish(downloads, job)));
    assert.ok(results.every(result => result.state === "complete"));
    assert.equal(new Set(results.map(result => result.path)).size, 3);
    assert.deepEqual((await readdir(directory)).sort(), ["report (1).txt", "report (2).txt", "report.txt"]);
    for (const result of results) assert.equal(await readFile(result.path, "utf8"), "public file bytes");
});

test("mid-stream cancel cleans the exclusive partial and does not publish a destination", async t => {
    const firstWritten = deferred(), release = deferred();
    const { directory, downloads } = await fixture(t, { fetchImpl: async (_url, { signal }) => {
        signal.addEventListener("abort", () => release.resolve(), { once: true });
        return { ok: true, status: 200, headers: new Headers(), body: {
            async *[Symbol.asyncIterator]() { yield Buffer.from("one"); firstWritten.resolve(); await release.promise; yield Buffer.from("two"); },
            async cancel() {}
        } };
    } });
    const started = await downloads.start(input);
    await firstWritten.promise;
    assert.equal((await downloads.status({ scope, tabId, downloadId: started.id })).bytesReceived, 3);
    assert.ok((await readdir(directory)).some(name => name.endsWith(".part")));
    const canceled = await downloads.cancel({ scope, tabId, downloadId: started.id });
    assert.equal(canceled.state, "cancelled");
    assert.equal(canceled.path, undefined);
    assert.deepEqual(await readdir(directory), []);
});

test("validation rejects credentials, non-HTTP URLs, unsafe names and invalid ownership inputs before fetching", async t => {
    let calls = 0;
    const { downloads } = await fixture(t, { fetchImpl: async () => { calls++; return new Response("x"); } });
    for (const url of ["file:///etc/passwd", "data:text/plain,x", "/relative", "https://user:pass@example.com/a", "https:example.com", "https://example.com/\na"]) {
        await assert.rejects(downloads.start({ ...input, url }));
    }
    for (const filename of ["", "../a", "a/../b", "/abs", "C:/a", "a:stream", "a\\b", "a//b", "./a", "a/", "NUL.txt", "COM1", "a.", "a ", "a\n", "a\u0085b"]) {
        await assert.rejects(downloads.start({ ...input, filename }), /relative filename/);
    }
    await assert.rejects(downloads.start({ ...input, scope: "bad" }), /scope/);
    await assert.rejects(downloads.start({ ...input, tabId: -1 }), /scope/);
    await assert.rejects(downloads.start({ ...input, url: "https://example.com/a%2Fb" }), /explicit safe filename/);
    assert.equal(calls, 0);
});

test("redirects are manually bounded, validated and requested without credentials", async t => {
    const calls = [];
    const { downloads } = await fixture(t, { fetchImpl: async (target, options) => {
        calls.push({ target, options });
        return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "/final.txt" } }) : new Response("ok");
    } });
    assert.equal((await finish(downloads, await downloads.start(input))).state, "complete");
    assert.equal(calls[1].target, "https://example.com/final.txt");
    for (const call of calls) assert.equal(call.options.credentials, "omit");
    for (const location of ["file:///private", "https://user:pass@example.com/a"]) {
        downloads.fetchImpl = async () => new Response(null, { status: 302, headers: { location } });
        const result = await finish(downloads, await downloads.start(input));
        assert.equal(result.state, "interrupted");
        assert.match(result.error, /HTTP/);
    }
    let redirects = 0;
    downloads.fetchImpl = async () => { redirects++; return new Response(null, { status: 302, headers: { location: "/again" } }); };
    assert.match((await finish(downloads, await downloads.start(input))).error, /redirect limit/);
    assert.equal(redirects, 6);
});

test("byte caps, HTTP errors and stream failures clean partial files without publishing", async t => {
    const { directory, downloads } = await fixture(t, { maxBytes: 3 });
    for (const response of [new Response("four", { headers: { "content-length": "4" } }), new Response("four"),
        new Response("no", { status: 403 }), new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array([1])); controller.error(new Error("stream failed"));
        } }))]) {
        downloads.fetchImpl = async () => response;
        const result = await finish(downloads, await downloads.start(input));
        assert.equal(result.state, "interrupted");
        assert.equal(result.path, undefined);
        assert.deepEqual(await readdir(directory), []);
    }
});

test("status and cancellation enforce exact browser/tab ownership and fresh permissions", async t => {
    let enabled = true;
    const fetching = deferred();
    const { downloads, directory } = await fixture(t, { permitted: async () => enabled,
        fetchImpl: async (_url, { signal }) => { fetching.resolve(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } });
    const started = await downloads.start(input);
    await fetching.promise;
    const request = { scope, tabId, downloadId: started.id };
    for (const other of [{ ...request, scope: randomUUID() }, { ...request, tabId: 13 }]) {
        await assert.rejects(downloads.status(other), /not tracked/);
        await assert.rejects(downloads.cancel(other), /not tracked/);
    }
    enabled = false;
    await assert.rejects(downloads.status(request), /Access disabled/);
    await assert.rejects(downloads.cancel(request), /Access disabled/);
    enabled = true;
    assert.equal((await downloads.cancel(request)).state, "cancelled");
    assert.deepEqual(await readdir(directory), []);
});

test("revoked permission during transfer prevents file publication", async t => {
    let enabled = true;
    const { directory, downloads } = await fixture(t, { permitted: async () => enabled, fetchImpl: async () => {
        enabled = false; return new Response("private now");
    } });
    const started = await downloads.start(input);
    await downloads.jobs.get(started.id).done;
    enabled = true;
    const result = await downloads.status({ scope, tabId, downloadId: started.id });
    assert.equal(result.state, "interrupted");
    assert.match(result.error, /Access disabled/);
    assert.deepEqual(await readdir(directory), []);
});

test("timeout aborts fetch and close cancels pending jobs without retrying", async t => {
    const { downloads, directory } = await fixture(t, { timeoutMs: 10, fetchImpl: async (_url, { signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
    const result = await finish(downloads, await downloads.start(input));
    assert.equal(result.state, "interrupted");
    assert.match(result.error, /timed out/);
    const started = await downloads.start(input);
    await downloads.close();
    assert.equal((await downloads.status({ scope, tabId, downloadId: started.id })).state, "cancelled");
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(downloads.start(input), /closed/);
});

test("symlinked intermediate folders cannot escape the configured directory", async t => {
    const { directory, downloads } = await fixture(t);
    const outside = await mkdtemp(join(tmpdir(), "tabpilot-download-outside-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await symlink(outside, join(directory, "escape"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(downloads.start({ ...input, filename: "escape/report.txt" }), /symbolic links|escaped/);
    assert.deepEqual(await readdir(outside), []);
});

test("metadata restart restores scoped results and interrupts old jobs without restarting or deleting paths", async t => {
    const directory = await mkdtemp(join(tmpdir(), "tabpilot-download-persist-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const metadataFile = join(directory, "metadata.json"), output = join(directory, "files");
    const first = new LocalDownloads({ directory: () => output, permitted: async () => true, fetchImpl: async () => new Response("saved"), metadataFile });
    const completed = await finish(first, await first.start(input));
    await first.close();
    const records = JSON.parse(await readFile(metadataFile, "utf8"));
    const interruptedId = randomUUID();
    records.push({ scope, id: interruptedId, tabId, url, state: "in_progress", bytesReceived: 1, path: completed.path, filename: "report.txt" });
    await writeFile(metadataFile, JSON.stringify(records));
    let calls = 0;
    const second = new LocalDownloads({ directory: () => output, permitted: async () => true,
        fetchImpl: async () => { calls++; throw new Error("must not restart"); }, metadataFile });
    t.after(() => second.close());
    const recovered = await second.status({ scope, tabId, downloadId: interruptedId });
    assert.equal(recovered.state, "interrupted");
    assert.match(recovered.error, /not resumed/);
    assert.equal((await second.status({ scope, tabId, downloadId: completed.id })).state, "complete");
    assert.equal(await readFile(completed.path, "utf8"), "saved");
    assert.equal(calls, 0);
});
