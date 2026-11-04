import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("../attention-alerts.js", import.meta.url), "utf8");

test("attention alerts deduplicate, respect mute, clear resolved notifications, and keep private task text off the desktop", async () => {
    const created = [], cleared = [], badges = [], messages = [];
    const chrome = { runtime: { getURL: path => path, sendMessage: async message => messages.push(message) },
        action: { setBadgeText: async value => badges.push(value.text), setBadgeBackgroundColor: async () => {} },
        notifications: { onClicked: { addListener() {} }, create: async (id, options) => created.push({ id, options }), clear: async id => cleared.push(id) } };
    const context = vm.createContext({}); vm.runInContext(source, context);
    const Alerts = vm.runInContext("TabPilotAttentionAlerts", context), alerts = new Alerts(chrome);
    let sounds = 0; alerts.sound = async () => { sounds++; return true; };
    const request = { id: "request-1", question: "Private task detail", tabId: 12 };
    await alerts.update({ requests: [request], settings: { soundAlerts: true } });
    await alerts.update({ requests: [request], settings: { soundAlerts: true } });
    assert.equal(created.length, 1); assert.equal(sounds, 1);
    assert.ok(!created[0].options.message.includes("Private task detail"));
    await alerts.update({ requests: [], settings: { soundAlerts: true } });
    assert.deepEqual(cleared, ["request-1"]);
    assert.equal(badges.at(-1), "");
    await alerts.update({ requests: [{ ...request, id: "request-2" }], settings: { soundAlerts: false } });
    assert.equal(sounds, 1);
    assert.equal(created.at(-1).options.silent, true);
});
