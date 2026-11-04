// Serve only the panel's public source assets and a simulated Chrome API for
// visual review. No bridge API, filesystem browsing, credentials, or model calls.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const files = { "/": ["../sidepanel.html", "text/html"], "/sidepanel.css": ["../sidepanel.css", "text/css"], "/sidepanel.js": ["../sidepanel.js", "text/javascript"], "/fixture.js": ["ui-fixture.js", "text/javascript"], "/page-runtime.js": ["../page-runtime.js", "text/javascript"] };
createServer(async (req, res) => {
    const route = new URL(req.url, "http://127.0.0.1:4380").pathname;
    if (req.headers.host === "127.0.0.1:4380" && route === "/cursor") {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
        res.end(`<!doctype html><html><head><title>TabPilot cursor preview</title><style>body{font:15px/1.6 system-ui;color:#202735;background:#f7f8fc;margin:60px}main{max-width:560px;padding:32px;background:white;border:1px solid #e3e6ef;border-radius:16px}h1{font-size:24px;margin:0 0 12px}p{color:#697080}label{display:block;margin-top:22px}input{display:block;font:inherit;padding:12px;border:1px solid #cbd1e0;border-radius:8px;width:85%}</style></head><body><main><h1>Agent pointer preview</h1><p>Local visual check of the real pointer renderer. No browser actions or model calls.</p><label>Visitor name<input value="UI Test"></label><label>Search query<input value="testing my agent"></label></main><script src="/page-runtime.js"></script><script>let step=0;function tick(){const el=document.querySelectorAll('input')[step++%2];const r=el.getBoundingClientRect();tabPilotPage('pointer',{x:r.x+80,y:r.y+22,pressed:true});}tick();setInterval(tick,950);</script></body></html>`);
        return;
    }
    if (req.headers.host !== "127.0.0.1:4380" || !Object.hasOwn(files, route)) { res.writeHead(404); res.end(); return; }
    const [path, type] = files[route];
    let data = await readFile(new URL(path, import.meta.url), "utf8");
    if (route === "/") data = data.replace('<script src="sidepanel.js">', '<script src="/fixture.js"></script><script src="sidepanel.js">');
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(data);
}).listen(4380, "127.0.0.1", () => console.log("Panel visual preview (simulated Chrome): http://127.0.0.1:4380"));
