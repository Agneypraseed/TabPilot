import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./practice.html", import.meta.url));
const state = { orders: [], visualCompleted: false };
const server = createServer(async (request, response) => {
    if (request.headers.host !== "127.0.0.1:4322") { response.writeHead(403); response.end(); return; }
    if (request.method === "GET" && request.url === "/api/state") {
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(state)); return;
    }
    if (request.method === "POST" && request.url === "/api/visual") {
        state.visualCompleted = true; response.end("ok"); return;
    }
    if (request.method === "POST" && request.url === "/api/order") {
        try {
            let body = "";
            for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error(); }
            const order = JSON.parse(body);
            if (typeof order.name !== "string" || !["standard", "express"].includes(order.delivery) || typeof order.gift !== "boolean") throw new Error();
            const record = { ...order, id: `PRACTICE-${String(state.orders.length + 1).padStart(3, "0")}` };
            state.orders.push(record); response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(record));
        } catch { response.writeHead(400); response.end("Invalid practice order"); }
        return;
    }
    if (request.method === "GET" && ["/", "/second"].includes(request.url)) {
        response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return;
    }
    response.writeHead(404); response.end("Not found");
});
server.listen(4322, "127.0.0.1", () => console.log("Practice page: http://127.0.0.1:4322/"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
