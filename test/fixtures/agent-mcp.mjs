import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTabPilotMcp } from "../../mcp.mjs";

const snapshot = {
    title: "Test page", url: "https://example.com/",
    text: "The page says the museum opens at 10 AM.", truncated: false
};
await createTabPilotMcp({
    request: async method => method === "tabs"
        ? [{ id: 12, title: snapshot.title, url: snapshot.url }]
        : snapshot
}).connect(new StdioServerTransport());
