import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import vm from "node:vm";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import { backgroundSource, mockDebugger } from "./background-source.mjs";

test("research access uses a private paired channel, checks source access and the approved URL", async t => {
    const token = "b".repeat(64), origin = `chrome-extension://${"b".repeat(32)}`;
    const bridge = createBridge({ token });
    await new Promise(resolve => bridge.server.listen(0, "127.0.0.1", resolve));
    const port = bridge.server.address().port;
    t.after(() => bridge.close());
    const stored = { "tab:12": true }, tabs = new Map([[12, { id: 12, url: "https://example.com/" }], [34, { id: 34, url: "https://example.com/research" }]]);
    const chrome = { runtime: { id: "b".repeat(32), onMessage: { addListener() {} } },
        tabs: { get: async id => tabs.get(id), onRemoved: { addListener() {} } },
        storage: { session: { get: async key => key === null ? stored : ({ [key]: stored[key] }), set: async value => Object.assign(stored, value), remove: async key => { delete stored[key]; } } } };
    mockDebugger(chrome, async () => ({}));
    class LocalSocket extends WebSocket {
        constructor() { super(`ws://127.0.0.1:${port}/extension`, { origin }); }
    }
    const context = vm.createContext({ chrome, WebSocket: LocalSocket, URL, crypto: globalThis.crypto, setTimeout, clearTimeout });
    vm.runInContext(backgroundSource, context);
    await context.connectBridge(token);
    await assert.rejects(bridge.approveResearchTab({ tabId: 34, sourceTabId: 12, url: "https://wrong.example/" }), /changed after approval/);
    assert.equal(stored["tab:34"], undefined);
    stored["tab:12"] = false;
    await assert.rejects(bridge.approveResearchTab({ tabId: 34, sourceTabId: 12, url: tabs.get(34).url }), /Access disabled/);
    stored["tab:12"] = true;
    await bridge.approveResearchTab({ tabId: 34, sourceTabId: 12, url: tabs.get(34).url });
    assert.equal(stored["tab:34"], true);
    const response = await fetch(`http://127.0.0.1:${port}/command`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method: "approved-research", tabId: 34, params: { sourceTabId: 12, url: tabs.get(34).url } }) });
    assert.equal(response.status, 400, "CLI/MCP API cannot grant tab access");
});
