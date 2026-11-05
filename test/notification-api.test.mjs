import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../server.mjs";

test("notification API is authenticated, rejects browser origins and fixes recipients locally", async t => {
    const sent = [];
    const token = "notification-token-fixture";
    const bridge = createBridge({ token, notifications: {
        status: () => ({ telegram: { configured: true } }),
        send: async input => { sent.push(input); return { accepted: true, results: [{ channel: "telegram", accepted: true }] }; }
    } });
    await new Promise(resolve => bridge.server.listen(0, "127.0.0.1", resolve));
    t.after(() => bridge.close());
    const url = `http://127.0.0.1:${bridge.server.address().port}/notifications`;
    const request = (body, headers = {}) => fetch(url, { method: "POST", headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers
    }, body: JSON.stringify(body) });
    assert.equal((await request({ method: "status" }, { Authorization: "Bearer wrong" })).status, 401);
    assert.equal((await request({ method: "status" }, { Origin: "https://example.com" })).status, 403);
    const status = await (await request({ method: "status" })).json();
    assert.equal(status.data.telegram.configured, true, "Notifications work without the Chrome connection");
    const input = { subject: "Task completed", message: "Verified the result", channels: ["telegram"] };
    assert.equal((await request({ method: "send", payload: { ...input, recipient: "another-user" } })).status, 400);
    assert.equal((await request({ method: "send", payload: { ...input, subject: "Injected\r\nHeader" } })).status, 400);
    assert.equal((await request({ method: "human-response", payload: {} })).status, 400);
    assert.equal((await request({ method: "send", payload: { ...input, message: "x".repeat(70000) } })).status, 400);
    const result = await (await request({ method: "send", payload: input })).json();
    assert.equal(result.data.accepted, true);
    assert.deepEqual(sent, [input]);
});
