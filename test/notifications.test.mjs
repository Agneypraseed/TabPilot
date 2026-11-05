import test from "node:test";
import assert from "node:assert/strict";
import { Notifications, notificationCommandSchema } from "../notifications.mjs";

const env = { RESEND_API_KEY: "email-secret-fixture", TABPILOT_EMAIL_FROM: "TabPilot <agent@example.com>",
    TABPILOT_EMAIL_TO: "user@example.com", TELEGRAM_BOT_TOKEN: "123456:telegram-secret-fixture", TABPILOT_TELEGRAM_CHAT_ID: "-100123456789" };
const input = { subject: "TabPilot completed", message: "Observed the requested result." };
const accepted = url => Response.json(url.includes("telegram") ? { ok: true, result: { message_id: 123 } } : { id: "email-fixture" });

test("disabled, partial and invalid notification configuration cannot send or expose values", async () => {
    const disabled = new Notifications({ env: {}, fetch: () => assert.fail("Disabled notifications cannot send") });
    assert.equal((await disabled.send(input)).accepted, false);
    for (const config of [{ RESEND_API_KEY: env.RESEND_API_KEY }, { ...env, TABPILOT_EMAIL_TO: "a@example.com,b@example.com" },
        { ...env, TELEGRAM_BOT_TOKEN: "123:token/redirect" }, { ...env, TABPILOT_TELEGRAM_CHAT_ID: "@other-recipient" }]) {
        const service = new Notifications({ env: config });
        const state = service.status();
        const channel = config.RESEND_API_KEY && !config.TELEGRAM_BOT_TOKEN || config.TABPILOT_EMAIL_TO?.includes(",") ? "email" : "telegram";
        assert.equal(state[channel].configured, false);
        assert.ok(!JSON.stringify(state).includes(env.RESEND_API_KEY));
        assert.ok(!JSON.stringify(state).includes(env.TELEGRAM_BOT_TOKEN));
    }
    assert.throws(() => notificationCommandSchema.parse({ method: "send", payload: { ...input, to: "attacker@example.com" } }));
    assert.throws(() => notificationCommandSchema.parse({ method: "approve", payload: {} }));
});

test("email and Telegram use configured destinations, plain text and bounded requests", async () => {
    const calls = [];
    const service = new Notifications({ env, sanitize: text => text.replaceAll("secret", "[redacted]"), fetch: async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return accepted(url);
    } });
    const result = await service.send({ ...input, message: "secret <b>not HTML</b>" });
    assert.equal(result.accepted, true);
    assert.equal(calls.length, 2);
    const email = calls.find(call => call.url.includes("resend")), telegram = calls.find(call => call.url.includes("telegram"));
    assert.equal(email.url, "https://api.resend.com/emails");
    assert.deepEqual(email.body.to, [env.TABPILOT_EMAIL_TO]);
    assert.equal(email.options.headers.Authorization, `Bearer ${env.RESEND_API_KEY}`);
    assert.equal(email.body.text, "[redacted] <b>not HTML</b>");
    assert.equal(email.body.html, undefined);
    assert.equal(telegram.url, `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`);
    assert.equal(telegram.body.chat_id, env.TABPILOT_TELEGRAM_CHAT_ID);
    assert.equal(telegram.body.text, `${input.subject}\n\n[redacted] <b>not HTML</b>`);
    assert.equal(telegram.body.parse_mode, undefined);
    assert.deepEqual(telegram.body.link_preview_options, { is_disabled: true });
    for (const { options } of calls) {
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
    }
});

test("channels fail independently, errors do not echo secrets, sends are never retried", async () => {
    let calls = 0;
    const service = new Notifications({ env, fetch: async url => {
        calls++;
        if (url.includes("telegram")) throw new Error(`network failure ${url}`);
        return accepted(url);
    } });
    const result = await service.send(input);
    assert.equal(result.accepted, false);
    assert.equal(result.results.find(item => item.channel === "email").accepted, true);
    assert.match(result.results.find(item => item.channel === "telegram").error, /unknown/);
    assert.ok(!JSON.stringify(result).includes(env.TELEGRAM_BOT_TOKEN));
    assert.equal(calls, 2);
    const limited = await service.send({ ...input, channels: ["email", "email"] });
    assert.equal(limited.accepted, true);
    assert.equal(calls, 3);
});

test("provider rejections and malformed successes cannot be reported as accepted", async () => {
    for (const response of [new Response("secret provider body", { status: 429 }), Response.json({ ok: false }), new Response("not JSON")]) {
        const service = new Notifications({ env, fetch: async () => response });
        const result = await service.send({ ...input, channels: ["telegram"] });
        assert.equal(result.accepted, false);
        assert.equal(result.results[0].accepted, false);
        assert.ok(!JSON.stringify(result).includes("secret provider body"));
    }
});


test("notification transport invokes native-compatible fetch with the global receiver", async () => {
    let calls = 0;
    const browserFetch = function () {
        if (this !== globalThis) throw new TypeError("Failed to execute 'fetch': Illegal invocation");
        calls++;
        return Promise.resolve(Response.json({ ok: true, result: { message_id: 123 } }));
    };
    const service = new Notifications({ env, fetch: browserFetch });
    const result = await service.send({ ...input, channels: ["telegram"] });
    assert.equal(result.accepted, true);
    assert.equal(calls, 1);
});
