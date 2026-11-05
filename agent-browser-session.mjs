// Adapt the existing MCP client for a visible, interruptible, single-tab run.
// CLI/MCP callers that do not opt in keep their existing behavior.
export function observedBrowserServer(server, {
    signal, targetTabId, checkpoint = async () => {},
    hasSteering = () => false, onActivity = () => {}, onObservation = () => {},
    beforeTool = async () => {}, afterTool = () => {}
} = {}) {
    const elements = new Map();
    const execute = async (name, args, meta, options) => {
        await checkpoint();
        signal?.throwIfAborted();
        if (hasSteering()) return { isError: true, content: [{ type: "text", text: "The user sent new guidance. Reconsider this action using their latest message before calling another tool." }] };
        if (targetTabId !== undefined && name !== "browser_tabs" && args?.tabId !== targetTabId) {
            return { isError: true, content: [{ type: "text", text: "This run is restricted to the user-selected tab." }] };
        }
        const decision = await beforeTool(name, args);
        await checkpoint(); signal?.throwIfAborted();
        if (decision) return decision;
        if (hasSteering()) return { isError: true, content: [{ type: "text", text: "The user sent new guidance while this action was waiting. Reconsider it before acting." }] };
        const activityId = globalThis.crypto.randomUUID();
        const targetName = elements.get(args?.tabId)?.find(element => element.ref === args?.ref)?.name;
        const activity = { tool: name, activityId, ...(targetName ? {targetName: targetName.slice(0,120)} : {}) };
        onActivity({ ...activity, phase: "running" });
        let result;
        try { result = await server.callToolResult(name, args, meta, { ...options, signal }); }
        catch(error) {
            onActivity({...activity,phase:signal?.aborted ? "stopped" : "error",error:String(error.message ?? "The browser step did not finish.").slice(0,1200)});
            throw error;
        }
        await afterTool(name, args, result);
        if (name === "browser_tabs" && targetTabId !== undefined && result.structuredContent?.tabs) {
            const tabs = result.structuredContent.tabs.filter(tab => tab.id === targetTabId);
            result.structuredContent = { tabs };
            result.content = [{ type: "text", text: JSON.stringify({ tabs }) }];
        }
        const snapshot = result.structuredContent?.snapshot ?? result.structuredContent;
        if(snapshot?.elements) elements.set(args?.tabId, snapshot.elements);
        let failure = result.structuredContent?.error;
        if(result.isError && !failure) failure = result.content?.filter(item=>item.type === "text").map(item=>item.text).join(" ");
        onActivity({ ...activity, phase: result.isError ? "error" : "complete", ...(failure ? {error:String(failure).slice(0,1200)} : {}) });
        const image = result.content?.find(item => item.type === "image");
        if (image) onObservation({ ...image, tabId: args?.tabId });
        return result;
    };
    let queue = Promise.resolve();
    const enqueue = (...args) => {
        const result = queue.then(() => execute(...args));
        queue = result.catch(() => {});
        return result;
    };
    return new Proxy(server, {
        get(target, property) {
            if (property === "callToolResult") return enqueue;
            if (property === "callTool") return async (...args) => (await enqueue(...args)).content;
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        }
    });
}
