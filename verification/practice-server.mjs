import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./practice.html", import.meta.url));
const state = { orders: [], visualCompleted: false };
const server = createServer(async (request, response) => {
    if (request.headers.host !== "127.0.0.1:4322") { response.writeHead(403); response.end(); return; }
    if (request.method === "GET" && request.url === "/sample-report.txt") {
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": 'attachment; filename="tabpilot-practice-report.txt"' });
        response.end("TabPilot practice report\nStandard delivery: 5 days\nExpress delivery: 2 days\nReturns: 30 days\n"); return;
    }
    if (request.method === "GET" && ["/delivery", "/returns"].includes(request.url)) {
        const delivery = request.url === "/delivery";
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><title>${delivery ? "Delivery policy" : "Returns policy"}</title><style>body{font:18px system-ui;max-width:700px;margin:40px auto;padding:20px}a{display:block;margin-top:20px}</style><h1>${delivery ? "Delivery policy" : "Returns policy"}</h1><p>${delivery ? "Standard delivery takes 5 business days. Express delivery takes 2 business days. Both include tracking." : "Unused items can be returned within 30 days. Keep the practice order reference. Returns are free."}</p><a href="/">Back to practice page</a>`); return;
    }
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
