// Serve only the panel's public source assets and a simulated Chrome API for
// visual review. No bridge API, filesystem browsing, credentials, or model calls.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const files = { "/": ["../sidepanel.html", "text/html"], "/sidepanel.css": ["../sidepanel.css", "text/css"], "/sidepanel.js": ["../sidepanel.js", "text/javascript"], "/fixture.js": ["ui-fixture.js", "text/javascript"] };
createServer(async (req, res) => {
    if (req.headers.host !== "127.0.0.1:4380" || !files[req.url]) { res.writeHead(404); res.end(); return; }
    const [path, type] = files[req.url];
    let data = await readFile(new URL(path, import.meta.url), "utf8");
    if (req.url === "/") data = data.replace('<script src="sidepanel.js">', '<script src="/fixture.js"></script><script src="sidepanel.js">');
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(data);
}).listen(4380, "127.0.0.1", () => console.log("Panel visual preview (simulated Chrome): http://127.0.0.1:4380"));
