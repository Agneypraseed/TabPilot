import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../downloads-controller.js", import.meta.url), "utf8");
function fixture() {
    const calls = [], stored = {}, items = new Map();
    let enabled = true, nextId = 40, gate = null;
    const chrome = {
        storage: { session: {
            get: async key => ({ [key]: stored[key] }),
            set: async values => Object.assign(stored, values)
        } },
        downloads: {
            download: async options => {
                calls.push({ method: "download", options });
                const id = nextId++;
                items.set(id, { id, filename: "C:/Users/Test/Downloads/report (1).pdf", state: "in_progress",
                    bytesReceived: 0, totalBytes: -1, danger: "safe", paused: false,
                    referrer: "private-referrer", byExtensionId: "private-extension" });
                return id;
            },
            search: async query => { calls.push({ method: "search", query }); return items.has(query.id) ? [items.get(query.id)] : []; },
            cancel: async id => {
                calls.push({ method: "cancel", id });
                Object.assign(items.get(id), { state: "interrupted", error: "USER_CANCELED" });
            }
        }
    };
    const context = vm.createContext({ URL });
    vm.runInContext(source, context);
    const Downloads = vm.runInContext("TabPilotDownloads", context);
    const permitted = async tabId => {
        if (gate) await gate(tabId);
        if (!enabled) throw new Error("Access disabled");
    };
    return { downloads: new Downloads(chrome, { permitted }), recreate: () => new Downloads(chrome, { permitted }), chrome,
        calls, items, stored, setEnabled(value) { enabled = value; }, setGate(value) { gate = value; } };
}
const plain = value => JSON.parse(JSON.stringify(value));

test("downloads use Chrome's relative location, uniquify, and return scoped metadata without claiming completion", async () => {
    const { downloads, calls, items } = fixture();
    const result = await downloads.start(12, { url: "https://example.com/report.pdf", filename: "research/report.pdf",
        conflictAction: "overwrite", headers: [{ name: "Cookie", value: "ignored" }], method: "POST" });
    assert.deepEqual(plain(calls[0]), { method: "download", options: {
        url: "https://example.com/report.pdf", filename: "research/report.pdf", saveAs: false, conflictAction: "uniquify"
    } });
    assert.equal(result.id, 40);
    assert.equal(result.tabId, 12);
    assert.equal(result.destination, "downloads");
    assert.equal(result.filename, "C:/Users/Test/Downloads/report (1).pdf");
    assert.equal(result.requestedFilename, "research/report.pdf");
    assert.equal(result.state, "in_progress");
    assert.equal(result.referrer, undefined);
    assert.equal(result.byExtensionId, undefined);
    Object.assign(items.get(40), { state: "complete", exists: true, bytesReceived: 123, totalBytes: 123 });
    assert.equal((await downloads.status(12, 40)).state, "complete");
});

test("Save As invokes the native chooser, with an optional relative suggested filename", async () => {
    const { downloads, calls } = fixture();
    assert.equal((await downloads.start(1, { url: "http://example.com/file", saveAs: true })).destination, "saveAs");
    assert.deepEqual(plain(calls[0].options), { url: "http://example.com/file", saveAs: true, conflictAction: "uniquify" });
    await downloads.start(1, { url: "https://example.com/file", saveAs: true, filename: "suggested.txt" });
    assert.equal(calls.findLast(call => call.method === "download").options.filename, "suggested.txt");
});

test("invalid URLs and credentials never reach Chrome downloads", async () => {
    const { downloads, calls } = fixture();
    for (const url of ["file:///etc/passwd", "data:text/plain,hello", "javascript:alert(1)", "blob:https://example.com/id",
        "/relative", "https:example.com", "https://user:pass@example.com/file", "https://user@example.com/file",
        "https://example.com/\nfile", " https://example.com/file", "not a URL", 4]) {
        await assert.rejects(downloads.start(1, { url }), /HTTP or HTTPS/);
    }
    assert.equal(calls.length, 0);
});

test("unsafe filename and location inputs are rejected even with Save As", async () => {
    const { downloads, calls } = fixture();
    for (const filename of ["", "/absolute.txt", "../secret", "folder/../secret", "./file", "folder//file", "C:/file",
        "C:\\file", "\\\\host\\file", "file:stream", "folder/file\u0000.txt", "file\n.txt", "file\u007f.txt",
        "folder/", "file.", "file ", "NUL.txt", "folder/CON", "COM1.txt", "a*b", "a?b", "file\u0085.txt", 5]) {
        await assert.rejects(downloads.start(1, { url: "https://example.com/file", filename, saveAs: true }), /relative Downloads path/);
    }
    await assert.rejects(downloads.start(1, { url: "https://example.com/file", saveAs: "true" }), /boolean/);
    assert.equal(calls.length, 0);
    await downloads.start(1, { url: "https://example.com/file", filename: "research/資料-v1.pdf" });
    assert.equal(calls[0].options.filename, "research/資料-v1.pdf");
});

test("every operation awaits tab permission; revocation also blocks status and cancel", async () => {
    const fixtureValue = fixture();
    const { downloads, calls, setEnabled, setGate } = fixtureValue;
    let release;
    setGate(() => new Promise(resolve => { release = resolve; }));
    const pending = downloads.start(1, { url: "https://example.com/file" });
    await Promise.resolve();
    assert.equal(calls.length, 0);
    setGate(null);
    release();
    const { id } = await pending;
    const before = calls.length;
    setEnabled(false);
    await assert.rejects(downloads.start(1, { url: "https://example.com/file" }), /Access disabled/);
    await assert.rejects(downloads.status(1, id), /Access disabled/);
    await assert.rejects(downloads.cancel(1, id), /Access disabled/);
    assert.equal(calls.length, before);
});

test("only originating tabs may inspect/cancel IDs, and ownership survives worker recreation", async () => {
    const { downloads, calls, recreate } = fixture();
    const { id } = await downloads.start(1, { url: "https://example.com/file" });
    const before = calls.length;
    await assert.rejects(downloads.status(2, id), /not tracked/);
    await assert.rejects(downloads.cancel(2, id), /not tracked/);
    await assert.rejects(downloads.status(1, 900), /not tracked/);
    await assert.rejects(downloads.status(1, -1), /Invalid download/);
    assert.equal(calls.length, before);
    assert.equal((await recreate().status(1, id)).tabId, 1);
    const canceled = await recreate().cancel(1, id);
    assert.equal(canceled.state, "interrupted");
    assert.equal(canceled.error, "USER_CANCELED");
});

test("Chrome danger prompts are reported unchanged and never accepted or opened", async () => {
    const { downloads, calls, items, chrome } = fixture();
    chrome.downloads.acceptDanger = () => assert.fail("Must not accept danger");
    chrome.downloads.open = () => assert.fail("Must not execute or open a download");
    const { id } = await downloads.start(1, { url: "https://example.com/file" });
    Object.assign(items.get(id), { danger: "content", state: "interrupted", error: "FILE_BLOCKED" });
    const status = await downloads.status(1, id);
    assert.equal(status.danger, "content");
    assert.equal(status.error, "FILE_BLOCKED");
    items.delete(id);
    await assert.rejects(downloads.status(1, id), /no longer available/);
    assert.ok(calls.every(call => ["download", "search"].includes(call.method)));
});

test("native chooser cancellation/API errors propagate without creating ownership", async () => {
    const { downloads, chrome, stored } = fixture();
    chrome.downloads.download = async () => { throw new Error("User canceled"); };
    await assert.rejects(downloads.start(1, { url: "https://example.com/file", saveAs: true }), /User canceled/);
    assert.deepEqual(stored, {});
    chrome.downloads.download = async () => undefined;
    await assert.rejects(downloads.start(1, { url: "https://example.com/file" }), /download ID/);
    assert.deepEqual(stored, {});
});

test("started downloads retain IDs and memory ownership after persistence/status errors", async () => {
    const { downloads, chrome, calls } = fixture();
    chrome.storage.session.set = async () => { throw new Error("Storage unavailable"); };
    chrome.downloads.search = async () => { throw new Error("Temporary search error"); };
    const started = await downloads.start(1, { url: "https://example.com/file" });
    assert.equal(started.id, 40);
    assert.equal(started.started, true);
    assert.match(started.trackingWarning, /persisted/);
    assert.match(started.trackingWarning, /do not start it again/);
    assert.equal(started.state, undefined);
    chrome.downloads.search = async () => [{ id: 40, state: "complete" }];
    assert.equal((await downloads.status(1, 40)).state, "complete");
    assert.equal(calls.filter(call => call.method === "download").length, 1);
});

test("permission revocation after Chrome starts returns the ID without exposing later status", async () => {
    const { downloads, chrome, setEnabled, calls } = fixture();
    const original = chrome.downloads.download;
    chrome.downloads.download = async options => { const id = await original(options); setEnabled(false); return id; };
    const started = await downloads.start(1, { url: "https://example.com/file" });
    assert.equal(started.id, 40);
    assert.equal(started.started, true);
    assert.match(started.trackingWarning, /status is unavailable/);
    assert.equal(started.filename, undefined);
    assert.equal(calls.filter(call => call.method === "search").length, 0);
});
