// Classic script loaded by the extension worker with importScripts.
class TabPilotDownloads {
    constructor(chromeApi, { permitted }) {
        if (typeof permitted !== "function") throw new Error("A tab permission check is required.");
        this.chrome = chromeApi;
        this.permitted = permitted;
        this.owners = new Map();
    }

    async check(tabId) {
        if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error("Invalid tab ID.");
        if (await this.permitted(tabId) === false) throw new Error("Access disabled for this tab.");
    }

    options(input) {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Download options are required.");
        if (typeof input.url !== "string" || /[\u0000-\u0020\u007f-\u009f]/.test(input.url)) throw new Error("Use an absolute HTTP or HTTPS download URL.");
        let url;
        try { url = new URL(input.url); } catch { throw new Error("Use an absolute HTTP or HTTPS download URL."); }
        if (!/^https?:$/.test(url.protocol) || !/^https?:\/\//i.test(input.url) || url.username || url.password) {
            throw new Error("Use an absolute HTTP or HTTPS download URL without embedded credentials.");
        }
        if (input.saveAs !== undefined && typeof input.saveAs !== "boolean") throw new Error("saveAs must be a boolean.");
        const result = { url: url.href, conflictAction: "uniquify", saveAs: input.saveAs === true };
        if (input.filename !== undefined) {
            const name = input.filename;
            if (typeof name !== "string" || !name || /[\u0000-\u001f\u007f-\u009f<>:"|?*\\]/.test(name)
                || name.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
                    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
                throw new Error("filename must be a safe relative Downloads path using forward slashes; use saveAs for another location.");
            }
            result.filename = name;
        }
        return result;
    }

    key(id) { return `tabpilot:download:${id}`; }

    async remember(id, owner) {
        // Session storage survives MV3 worker suspension, but resets with the browser session.
        this.owners.set(id, owner);
        if (this.chrome.storage?.session) await this.chrome.storage.session.set({ [this.key(id)]: owner });
    }

    async owner(tabId, id) {
        if (!Number.isSafeInteger(id) || id < 0) throw new Error("Invalid download ID.");
        const storage = this.chrome.storage?.session;
        let owner = this.owners.get(id);
        if (!owner && storage) owner = (await storage.get(this.key(id)))[this.key(id)];
        if (!owner || owner.tabId !== tabId) throw new Error("Download is not tracked for this tab.");
        return owner;
    }

    metadata(tabId, id, owner, item) {
        const result = { id, tabId, url: owner.url, destination: owner.destination };
        if (owner.requestedFilename !== undefined) result.requestedFilename = owner.requestedFilename;
        for (const key of ["filename", "state", "danger", "bytesReceived", "totalBytes", "fileSize", "error", "exists", "paused", "startTime", "endTime"]) {
            if (item?.[key] !== undefined) result[key] = item[key];
        }
        return result;
    }

    async start(tabId, input) {
        await this.check(tabId);
        const options = this.options(input);
        if (!this.chrome.downloads?.download) throw new Error("Chrome downloads permission/API is unavailable.");
        await this.check(tabId);
        const id = await this.chrome.downloads.download(options);
        if (!Number.isSafeInteger(id) || id < 0) throw new Error("Chrome did not return a download ID.");
        const owner = { tabId, url: options.url, destination: options.saveAs ? "saveAs" : "downloads" };
        if (options.filename !== undefined) owner.requestedFilename = options.filename;
        const warnings = [];
        try { await this.remember(id, owner); }
        catch { warnings.push("Download started, but ownership could not be persisted across extension worker restarts."); }
        let result = this.metadata(tabId, id, owner);
        try { result = await this.status(tabId, id); }
        catch { warnings.push("Download started, but current status is unavailable. Check this download ID; do not start it again."); }
        // Once Chrome supplies an ID, never report a retryable start failure.
        result.started = true;
        if (warnings.length) result.trackingWarning = warnings.join(" ");
        return result;
    }

    async status(tabId, downloadId) {
        await this.check(tabId);
        const owner = await this.owner(tabId, downloadId);
        await this.check(tabId);
        const items = await this.chrome.downloads.search({ id: downloadId });
        const item = items.find(item => item.id === downloadId);
        if (!item) throw new Error("Tracked download is no longer available in Chrome's download history.");
        await this.check(tabId);
        return this.metadata(tabId, downloadId, owner, item);
    }

    async cancel(tabId, downloadId) {
        await this.check(tabId);
        await this.owner(tabId, downloadId);
        await this.check(tabId);
        await this.chrome.downloads.cancel(downloadId);
        return this.status(tabId, downloadId);
    }
}
