import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const source = await readFile(new URL("../page-runtime.js", import.meta.url), "utf8");
export function page(html) {
    const { window, document } = parseHTML(`<!doctype html><html><head><title>Fixture</title></head><body>${html}</body></html>`);
    window.getComputedStyle = () => ({ display: "block", visibility: "visible" });
    window.Element.prototype.getBoundingClientRect = function () {
        return { x: 10, y: 20, width: this.hidden ? 0 : 100, height: 30 };
    };
    window.Element.prototype.scrollIntoView = () => {};
    const context = vm.createContext({ document, window, location: { href: "https://example.com/" },
        crypto: globalThis.crypto, innerWidth: 1000, innerHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
        Event: window.Event, Map, setTimeout, clearTimeout, MutationObserver: window.MutationObserver });
    vm.runInContext(source, context);
    return { document, run: (operation, args = {}) => context.tabPilotPage(operation, args) };
}

test("snapshot exposes named visible targets and redacts password values", () => {
    const fixture = page('<button aria-label="Save changes">Save</button><input type="password" value="secret"><button hidden>Hidden</button><a href="/next">Next</a>');
    const snapshot = fixture.run("snapshot");
    assert.equal(snapshot.elements.length, 3);
    assert.equal(snapshot.elements[0].name, "Save changes");
    assert.equal(snapshot.elements[1].value, "[redacted]");
    assert.equal(snapshot.elements[2].role, "link");
    assert.ok(snapshot.elements.every(element => element.ref.startsWith(snapshot.snapshotId)));
});

test("snapshot traverses open shadow roots and rejects stale or replaced targets", () => {
    const fixture = page('<div id="host"></div><button>Old</button>');
    fixture.document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<button>Shadow control</button>";
    const snapshot = fixture.run("snapshot");
    assert.ok(snapshot.elements.some(element => element.name === "Shadow control"));
    const old = snapshot.elements.find(element => element.name === "Old");
    fixture.document.querySelector("body > button").textContent = "Changed";
    assert.throws(() => fixture.run("resolve", { ref: old.ref }), /STALE_REF/);
    const fresh = fixture.run("snapshot");
    assert.throws(() => fixture.run("resolve", { ref: snapshot.elements[0].ref }), /STALE_REF/);
    fixture.document.querySelector("body > button").remove();
    assert.throws(() => fixture.run("resolve", { ref: fresh.elements.find(e => e.name === "Changed").ref }), /STALE_REF/);
});

test("typing status follows the original editable target and detects focus, visibility, or identity changes", () => {
    const fixture = page('<input id="name" aria-label="Visitor name"><input id="other">');
    const input = fixture.document.getElementById("name");
    Object.defineProperty(fixture.document, "activeElement", { configurable: true, writable: true, value: input });
    const ref = fixture.run("snapshot").elements.find(e => e.name === "Visitor name").ref;
    assert.equal(fixture.run("typing-status", { ref }).focused, true);
    input.value = "Partially typed";
    assert.equal(fixture.run("typing-status", { ref }).focused, true);
    fixture.document.activeElement = fixture.document.getElementById("other");
    assert.equal(fixture.run("typing-status", { ref }).focused, false);
    fixture.document.activeElement = input;
    input.hidden = true;
    assert.equal(fixture.run("typing-status", { ref }).focused, false);
    input.hidden = false;
    input.setAttribute("aria-label", "Different purpose");
    assert.equal(fixture.run("typing-status", { ref }).focused, false);
});

test("closed-shadow cursor stays out of observations and does not stale screenshots, while real page changes still do", async () => {
    const fixture = page('<button>Save</button>');
    const initial = fixture.run("snapshot");
    const before = fixture.run("fingerprint");
    fixture.run("pointer", { x: 100, y: 80 });
    await new Promise(resolve => setImmediate(resolve));
    const host = fixture.document.querySelector("tabpilot-pointer");
    assert.ok(host);
    assert.equal(host.shadowRoot, null);
    assert.equal(fixture.run("fingerprint").revision, before.revision);
    assert.equal(fixture.run("snapshot").elements.length, initial.elements.length);
    fixture.document.querySelector("button").textContent = "Changed";
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(fixture.run("fingerprint").revision > before.revision);
    const revision = fixture.run("fingerprint").revision;
    fixture.run("pointer", { visible: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.run("fingerprint").revision, revision);
    assert.equal(host.isConnected, false);
});
