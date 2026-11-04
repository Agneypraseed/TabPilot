import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { parseBrowserCommand } from "./commands.mjs";
import { AgentService } from "./agent-service.mjs";

async function readCommand(request) {
    const text = await new Promise((resolve, reject) => {
        let chunks = [], bytes = 0, rejected = false;
        request.on("data", chunk => {
            bytes += chunk.length;
            if (bytes > 65536) { rejected = true; chunks = []; reject(new Error("Request exceeds 64 KB.")); }
            else if (!rejected) chunks.push(chunk);
        });
        request.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks).toString("utf8")); });
        request.on("error", reject);
    });
    return parseBrowserCommand(JSON.parse(text));
}

export function createBridge({ token, timeoutMs = 20000, agentService } = {}) {
    if (!token) throw new Error("A pairing token is required.");
    let extension = null;
    const pending = new Map();
    const sockets = new Set();
    const unsubscribe = agentService?.subscribe(state => {
        if (extension?.readyState === WebSocket.OPEN) extension.send(JSON.stringify({ type: "agent-state", state }));
    });
    const authenticate = (candidate) => {
        const actual = Buffer.from(candidate ?? "");
        const expected = Buffer.from(token);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    };
    const reply = (response, status, body) => {
        response.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
        });
        response.end(JSON.stringify(body));
    };
    const server = createServer(async (request, response) => {
        // Browser pages must not be able to use this local API.
        const expectedHost = `127.0.0.1:${server.address().port}`;
        if (request.headers.host !== expectedHost || request.headers.origin !== undefined) {
            return reply(response, 403, { ok: false, error: "Browser-origin requests are not allowed." });
        }
        if (!authenticate(request.headers.authorization?.replace(/^Bearer /, ""))) {
            return reply(response, 401, { ok: false, error: "Invalid local API token." });
        }
        if (request.method !== "POST") {
            return reply(response, 405, { ok: false, error: "Use POST." });
        }
        let command;
        if (request.url === "/command") {
            try { command = await readCommand(request); }
            catch { return reply(response, 400, { ok: false, error: "Invalid browser command or arguments (maximum 64 KB)." }); }
        }
        if (request.url === "/tabs") command = { method: "tabs" };
        const match = /^\/snapshot\/(\d+)$/.exec(request.url);
        if (match && Number.isSafeInteger(Number(match[1]))) {
            command = { method: "snapshot", tabId: Number(match[1]) };
        }
        if (!command) return reply(response, 404, { ok: false, error: "Unknown command." });
        if (extension?.readyState !== WebSocket.OPEN) {
            return reply(response, 503, { ok: false, error: "Open TabPilot and connect the local bridge." });
        }
        if (pending.size >= 16) return reply(response, 429, { ok: false, error: "Too many pending requests." });

        const id = randomUUID();
        const timer = setTimeout(() => {
            pending.delete(id);
            reply(response, 504, { ok: false, error: "Extension request timed out." });
        }, timeoutMs);
        pending.set(id, { response, timer });
        response.on("close", () => {
            clearTimeout(timer);
            pending.delete(id);
        });
        extension.send(JSON.stringify({ type: "request", id, ...command }));
    });
    const webSockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    server.on("upgrade", (request, socket, head) => {
        if (request.url !== "/extension" ||
            request.headers.host !== `127.0.0.1:${server.address().port}` ||
            !/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin ?? "")) {
            socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            return;
        }
        webSockets.handleUpgrade(request, socket, head, (client) => {
            sockets.add(client);
            let authenticated = false;
            const authTimer = setTimeout(() => client.close(1008, "Pairing timed out"), 3000);
            client.on("error", () => {});
            client.on("message", (data) => {
                let message;
                try { message = JSON.parse(data.toString()); }
                catch { client.close(1008, "Invalid JSON"); return; }
                if (!authenticated) {
                    if (message?.type !== "authenticate" || typeof message.token !== "string" ||
                        !authenticate(message.token) || extension) {
                        client.close(1008, "Pairing failed or another extension is connected");
                        return;
                    }
                    clearTimeout(authTimer);
                    authenticated = true;
                    extension = client;
                    client.send(JSON.stringify({ type: "ready" }));
                    if (agentService) client.send(JSON.stringify({ type: "agent-state", state: agentService.snapshot() }));
                    return;
                }
                if (message?.type === "agent-request" && typeof message.id === "string" && message.id.length <= 100) {
                    if (!agentService) {
                        client.send(JSON.stringify({ type: "agent-response", id: message.id, ok: false, error: "Restart the bridge to enable the agent interface." }));
                        return;
                    }
                    Promise.resolve().then(() => agentService.command(message.method, message.payload)).then(
                        state => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "agent-response", id: message.id, ok: true, state })); },
                        error => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "agent-response", id: message.id, ok: false, error: error instanceof Error && error.name === "ZodError" ? "Invalid agent settings or task." : String(error.message ?? "Agent command failed.") })); }
                    );
                    return;
                }
                if (message?.type !== "response" || typeof message.id !== "string") return;
                const entry = pending.get(message.id);
                if (!entry) return;
                pending.delete(message.id);
                clearTimeout(entry.timer);
                reply(entry.response, message.ok === true ? 200 : 409,
                    message.ok === true
                        ? { ok: true, data: message.data }
                        : { ok: false, error: String(message.error ?? "Extension request failed.") });
            });
            client.on("close", () => {
                clearTimeout(authTimer);
                sockets.delete(client);
                if (extension !== client) return;
                extension = null;
                agentService?.disconnect();
                for (const { response, timer } of pending.values()) {
                    clearTimeout(timer);
                    reply(response, 503, { ok: false, error: "Extension disconnected." });
                }
                pending.clear();
            });
        });
    });
    // Application messages keep a connected Chrome 116+ worker responsive.
    const heartbeat = setInterval(() => {
        if (extension?.readyState === WebSocket.OPEN) {
            extension.send(JSON.stringify({ type: "ping" }));
        }
    }, 20000);
    heartbeat.unref();

    return {
        server,
        async close() {
            unsubscribe?.();
            agentService?.disconnect();
            clearInterval(heartbeat);
            for (const client of sockets) client.terminate();
            await new Promise((done) => server.close(done));
            webSockets.close();
        }
    };
}

async function main() {
    const envFile = new URL(".env.local", import.meta.url);
    if (existsSync(envFile)) loadEnvFile(fileURLToPath(envFile));
    const settingsFile = new URL(".tabpilot/agent-settings.json", import.meta.url);
    let settings;
    try { settings = JSON.parse(await readFile(settingsFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("Invalid local agent settings. Check .tabpilot/agent-settings.json."); }
    const agentService = new AgentService({ settings, saveSettings: async next => {
        await writeFile(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 });
    } });
    const token = randomBytes(32).toString("hex");
    const bridge = createBridge({ token, agentService });
    await new Promise((done, reject) => {
        bridge.server.once("error", reject);
        bridge.server.listen(4311, "127.0.0.1", done);
    });
    await mkdir(new URL(".tabpilot/", import.meta.url), { recursive: true });
    await writeFile(new URL(".tabpilot/bridge.json", import.meta.url),
        JSON.stringify({ url: "http://127.0.0.1:4311", token }), { mode: 0o600 });
    console.log("TabPilot bridge listening on http://127.0.0.1:4311");
    console.log("Run npm run cli -- pair to get the token, then connect in TabPilot Settings.");
    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => { void bridge.close(); });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
