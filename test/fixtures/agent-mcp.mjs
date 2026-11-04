import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTabPilotMcp } from "../../mcp.mjs";

const snapshot = {
    title: "Test page", url: "https://example.com/",
    text: "The page says the museum opens at 10 AM.", truncated: false
};
await createTabPilotMcp({
    request: async method => method === "tabs"
        ? [{ id: 12, title: snapshot.title, url: snapshot.url }]
        : method === "screenshot" ? { screenshotId: "test-shot", mimeType: "image/png", width: 1, height: 1,
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=" }
        : method === "snapshot" ? snapshot : { action: method, snapshot }
}).connect(new StdioServerTransport());
