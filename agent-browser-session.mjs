// Adapt the existing MCP client for a visible, interruptible, single-tab run.
// CLI/MCP callers that do not opt in keep their existing behavior.
export function observedBrowserServer(server, {
    signal, targetTabId, mode = "browser", checkpoint = async () => {},
    hasSteering = () => false, onActivity = () => {}, onObservation = () => {}
} = {}) {
    const execute = async (name, args, meta, options) => {
        await checkpoint();
        signal?.throwIfAborted();
        if (hasSteering()) return { isError: true, content: [{ type: "text", text: "The user sent new guidance. Reconsider this action using their latest message before calling another tool." }] };
        if (targetTabId !== undefined && name !== "browser_tabs" && args?.tabId !== targetTabId) {
            return { isError: true, content: [{ type: "text", text: "This run is restricted to the user-selected tab." }] };
        }
        onActivity({ tool: name, phase: "running" });
        const result = await server.callToolResult(name, args, meta, { ...options, signal });
        if (name === "browser_tabs" && targetTabId !== undefined && result.structuredContent?.tabs) {
            const tabs = result.structuredContent.tabs.filter(tab => tab.id === targetTabId);
            result.structuredContent = { tabs };
            result.content = [{ type: "text", text: JSON.stringify({ tabs }) }];
        }
        onActivity({ tool: name, phase: result.isError ? "error" : "complete" });
        const image = result.content?.find(item => item.type === "image");
        if (image) onObservation({ ...image, tabId: args?.tabId });
        // Capture only between actions, so observing does not invalidate the image
        // coordinates of a pointer operation that has not executed yet.
        if (mode === "computer" && !result.isError && args?.tabId !== undefined &&
            !["browser_screenshot", "browser_close", "browser_open"].includes(name)) {
            signal?.throwIfAborted();
            const visual = await server.callToolResult("browser_screenshot", { tabId: args.tabId }, null, { signal });
            const shot = visual.content?.find(item => item.type === "image");
            if (shot) {
                onObservation({ ...shot, tabId: args.tabId });
                return { ...result, content: [...result.content, ...visual.content] };
            }
        }
        return result;
    };
    return new Proxy(server, {
        get(target, property) {
            if (property === "callToolResult") return execute;
            if (property === "callTool") return async (...args) => (await execute(...args)).content;
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        }
    });
}
