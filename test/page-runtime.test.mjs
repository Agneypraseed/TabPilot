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
        Event: window.Event, Map });
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
