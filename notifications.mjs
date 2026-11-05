import { z } from "zod";

const channel = z.enum(["email", "telegram"]);
export const notificationInputSchema = z.object({
    subject: z.string().trim().min(1).max(200).refine(value => !/[\r\n]/.test(value), "Use a single-line subject."),
    message: z.string().trim().min(1).max(3000),
    channels: z.array(channel).min(1).max(2).optional()
}).strict();
export const notificationCommandSchema = z.discriminatedUnion("method", [
    z.object({ method: z.literal("status") }).strict(),
    z.object({ method: z.literal("send"), payload: notificationInputSchema }).strict()
]);

const fields = {
    email: ["RESEND_API_KEY", "TABPILOT_EMAIL_FROM", "TABPILOT_EMAIL_TO"],
    telegram: ["TELEGRAM_BOT_TOKEN", "TABPILOT_TELEGRAM_CHAT_ID"]
};

// Destinations belong to local configuration, never to a model or a web page.
// A successful HTTP response means provider acceptance, not confirmed delivery.
export class Notifications {
    constructor({ env = globalThis.process?.env ?? {}, fetch: fetcher = fetch, sanitize = value => value } = {}) {
        this.env = { ...env };
        this.fetch = fetcher;
        this.sanitize = sanitize;
    }
    status() {
        return Object.fromEntries(Object.entries(fields).map(([name, keys]) => {
            const missing = keys.filter(key => !this.env[key]?.trim());
            let invalid = false;
            if (!missing.length) {
                invalid = name === "email"
                    ? !z.email().safeParse(this.env.TABPILOT_EMAIL_TO).success || /[\r\n]/.test(this.env.TABPILOT_EMAIL_FROM)
                    : !/^\d+:[A-Za-z0-9_-]+$/.test(this.env.TELEGRAM_BOT_TOKEN) ||
                        !/^-?\d+$/.test(this.env.TABPILOT_TELEGRAM_CHAT_ID);
            }
            return [name, { configured: !missing.length && !invalid, missing, invalid }];
        }));
    }
    async send(input) {
        const { subject, message, channels } = notificationInputSchema.parse(input);
        const status = this.status();
        const selected = [...new Set(channels ?? Object.keys(status).filter(name => status[name].configured))];
        if (!selected.length) return { accepted: false, results: [], error: "No notification channel configured. Check notifications_status and .env.local." };
        const cleaned = { subject: this.sanitize(subject), message: this.sanitize(message) };
        const results = await Promise.all(selected.map(async name => {
            if (!status[name].configured) return { channel: name, accepted: false, error: "Channel is not configured. Check notifications_status." };
            try {
                const response = await this.deliver(name, cleaned);
                // Do not echo provider bodies: they may contain credentials or recipients.
                if (!response.ok) {
                    await response.body?.cancel();
                    return { channel: name, accepted: false, error: `Provider rejected the notification (HTTP ${response.status}).` };
                }
                const data = await response.json();
                const accepted = name === "telegram" ? data.ok === true && Number.isSafeInteger(data.result?.message_id)
                    : typeof data.id === "string" && data.id.length > 0;
                return accepted ? { channel: name, accepted: true }
                    : { channel: name, accepted: false, error: "Provider did not acknowledge the notification." };
            } catch (error) {
                // No automatic retries: a timed-out send may already have been accepted.
                const timeout = ["TimeoutError", "AbortError"].includes(error?.name);
                const invalidResponse = error instanceof SyntaxError;
                return { channel: name, accepted: false,
                    errorCode: timeout ? "TIMEOUT" : invalidResponse ? "INVALID_RESPONSE" : "NETWORK_ERROR",
                    error: timeout ? "The notification request timed out. Delivery is unknown; check the receiving app before retrying."
                        : invalidResponse ? "The provider returned an unreadable response. Delivery is unknown; check the receiving app before retrying."
                        : "The browser could not read a response from the notification provider. Check extension site access, your network or VPN, and whether the message arrived before retrying. Delivery is unknown." };
            }
        }));
        return { accepted: results.every(result => result.accepted), results };
    }
    deliver(name, { subject, message }) {
        const env = this.env;
        const common = { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000) };
        if (name === "email") return this.fetch("https://api.resend.com/emails", {
            ...common, headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: env.TABPILOT_EMAIL_FROM, to: [env.TABPILOT_EMAIL_TO], subject, text: message })
        });
        return this.fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            ...common, headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: env.TABPILOT_TELEGRAM_CHAT_ID, text: `${subject}\n\n${message}`,
                link_preview_options: { is_disabled: true } })
        });
    }
}
