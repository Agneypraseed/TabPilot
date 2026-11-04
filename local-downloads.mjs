import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { isAbsolute, join, dirname, basename, extname, relative } from "node:path";
import { mkdir, realpath, lstat, open, link, copyFile, unlink, readFile, rename } from "node:fs/promises";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function httpUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("Use an absolute HTTP(S) URL without credentials."); }
    if (typeof value !== "string" || !/^https?:\/\//i.test(value) || !/^https?:$/.test(url.protocol)
        || url.username || url.password || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) throw new Error("Use an absolute HTTP(S) URL without credentials.");
    return url.href;
}
function safeFilename(value) {
    if (typeof value !== "string" || !value || value.length > 1000 || /[\u0000-\u001f\u007f-\u009f<>:"|?*\\]/.test(value)
        || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
            || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Use a safe relative filename with forward slashes.");
    return value;
}
function suggestedFilename(url) {
    try {
        const name = decodeURIComponent(new URL(url).pathname.split("/").at(-1) || "download");
        if (name.includes("/")) throw new Error("Encoded separator");
        return safeFilename(name);
    }
    catch { throw new Error("This URL needs an explicit safe filename."); }
}

// Explicit public-file backend. It never reads browser cookies or falls back from Chrome.
export class LocalDownloads {
    constructor({ directory, permitted, fetchImpl = globalThis.fetch, maxBytes = 25 * 1024 * 1024, timeoutMs = 20000, metadataFile } = {}) {
        if (typeof directory !== "function" || typeof permitted !== "function" || typeof fetchImpl !== "function") throw new Error("directory, permitted and fetchImpl callbacks are required.");
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid download limits.");
        if (metadataFile !== undefined && (typeof metadataFile !== "string" || !isAbsolute(metadataFile))) throw new Error("metadataFile must be absolute.");
        Object.assign(this, { directory, permitted, fetchImpl, maxBytes, timeoutMs, metadataFile });
        this.jobs = new Map();
        this.closed = false;
        this.persistence = Promise.resolve();
        this.ready = this.load();
    }

    async load() {
        if (!this.metadataFile) return;
        let records;
        try { records = JSON.parse(await readFile(this.metadataFile, "utf8")); }
        catch (error) { if (error.code === "ENOENT") return; throw new Error("Download metadata could not be loaded."); }
        if (!Array.isArray(records)) throw new Error("Invalid download metadata.");
        for (const value of records) {
            if (!uuid(value?.id) || !uuid(value.scope) || !Number.isSafeInteger(value.tabId) || value.tabId < 0
                || !["in_progress", "complete", "interrupted", "cancelled"].includes(value.state)
                || !Number.isSafeInteger(value.bytesReceived) || value.bytesReceived < 0) throw new Error("Invalid download metadata.");
            const job = { id: value.id, scope: value.scope, tabId: value.tabId, url: httpUrl(value.url), state: value.state,
                bytesReceived: value.bytesReceived };
            if (typeof value.filename === "string") job.filename = safeFilename(value.filename);
            if (typeof value.path === "string" && isAbsolute(value.path)) job.path = value.path;
            if (value.state === "in_progress") { job.state = "interrupted"; job.error = "Bridge restarted; transfer was not resumed."; }
            else if (typeof value.error === "string") job.error = value.error;
            job.done = Promise.resolve();
            this.jobs.set(job.id, job);
        }
        await this.persist();
    }

    persist() {
        if (!this.metadataFile) return Promise.resolve();
        const records = [...this.jobs.values()].map(job => ({ scope: job.scope, ...this.metadata(job) }));
        const operation = this.persistence.then(async () => {
            await mkdir(dirname(this.metadataFile), { recursive: true });
            const temporary = `${this.metadataFile}.${randomUUID()}.tmp`;
            let created = false;
            try {
                const file = await open(temporary, "wx"); created = true;
                try { await file.writeFile(JSON.stringify(records)); } finally { await file.close(); }
                await rename(temporary, this.metadataFile);
            } finally { if (created) await unlink(temporary).catch(() => {}); }
        });
        this.persistence = operation.catch(() => {});
        return operation;
    }

    metadata(job) {
        const result = { id: job.id, tabId: job.tabId, url: job.url, state: job.state, bytesReceived: job.bytesReceived };
        for (const key of ["path", "filename", "error", "trackingWarning"]) if (job[key] !== undefined) result[key] = job[key];
        return result;
    }

    async check({ scope, tabId }) {
        if (!uuid(scope) || !Number.isSafeInteger(tabId) || tabId < 0) throw new Error("Invalid browser scope or tab ID.");
        if (await this.permitted({ scope, tabId }) === false) throw new Error("Access disabled for this tab.");
    }

    async owner(input) {
        await this.ready;
        await this.check(input);
        if (!uuid(input.downloadId)) throw new Error("Invalid download ID.");
        const job = this.jobs.get(input.downloadId);
        if (!job || job.scope !== input.scope || job.tabId !== input.tabId) throw new Error("Download is not tracked for this browser tab.");
        return job;
    }

    async folder(root, parts) {
        let current = root;
        for (const part of parts) {
            current = join(current, part);
            try { await mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
            const info = await lstat(current);
            if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Download subdirectories must be real directories, not symbolic links.");
            if (relative(current, await realpath(current)) !== "") throw new Error("Download directory escaped its configured location.");
        }
        return current;
    }

    async start(input) {
        await this.ready;
        if (this.closed) throw new Error("Local downloads are closed.");
        const url = httpUrl(input?.url);
        await this.check({ ...input, url });
        const filename = input.filename === undefined ? suggestedFilename(url) : safeFilename(input.filename);
        const configured = await this.directory();
        if (typeof configured !== "string" || !isAbsolute(configured)) throw new Error("Choose an absolute local download folder in Settings first.");
        await mkdir(configured, { recursive: true });
        const root = await realpath(configured);
        const parts = filename.split("/");
        const folder = await this.folder(root, parts.slice(0, -1));
        await this.check({ ...input, url });
        if (this.closed) throw new Error("Local downloads are closed.");
        const job = { id: randomUUID(), scope: input.scope, tabId: input.tabId, url, state: "in_progress", bytesReceived: 0,
            filename, controller: new AbortController() };
        this.jobs.set(job.id, job);
        // Register completion before returning: cancellation/close can always await cleanup.
        job.done = this.transfer(job, root, folder, parts.at(-1));
        return this.metadata(job);
    }

    async transfer(job, root, folder, name) {
        let partial, handle, response;
        const timer = setTimeout(() => { job.timeout = true; job.controller.abort(); }, this.timeoutMs);
        const active = async () => {
            if (job.controller.signal.aborted) throw new Error(job.timeout ? "Download timed out." : "Download cancelled.");
            await this.check(job);
            if (job.controller.signal.aborted) throw new Error("Download cancelled.");
        };
        try {
            try { await this.persist(); } catch { job.trackingWarning = "Download metadata could not be saved."; }
            let url = job.url;
            for (let redirects = 0; ; redirects++) {
                await active();
                response = await this.fetchImpl(url, { redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal: job.controller.signal });
                if (![301, 302, 303, 307, 308].includes(response.status)) break;
                const location = response.headers.get("location");
                await response.body?.cancel();
                if (!location || redirects >= 5) throw new Error("Download redirect limit exceeded or redirect target missing.");
                if (/[\u0000-\u0020\u007f-\u009f\\]/.test(location)) throw new Error("Invalid HTTP(S) redirect target.");
                url = httpUrl(new URL(location, url).href);
            }
            if (!response.ok) throw new Error(`Download server returned HTTP ${response.status}.`);
            const length = response.headers.get("content-length");
            if (length && Number(length) > this.maxBytes) throw new Error("Download exceeds the configured byte limit.");
            await active();
            await this.folder(root, job.filename.split("/").slice(0, -1));
            const temporary = join(folder, `.tabpilot-${job.id}.part`);
            handle = await open(temporary, "wx");
            partial = temporary;
            if (response.body) for await (const chunk of response.body) {
                await active();
                if (job.bytesReceived + chunk.byteLength > this.maxBytes) throw new Error("Download exceeds the configured byte limit.");
                let offset = 0;
                while (offset < chunk.byteLength) {
                    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
                    if (!bytesWritten) throw new Error("Download file write failed.");
                    offset += bytesWritten;
                }
                job.bytesReceived += chunk.byteLength;
            }
            await handle.close(); handle = null;
            await active();
            await this.folder(root, job.filename.split("/").slice(0, -1));
            const extension = extname(name), stem = basename(name, extension);
            for (let index = 0; ; index++) {
                await active();
                await this.folder(root, job.filename.split("/").slice(0, -1));
                if (index > 9999) throw new Error("Too many existing files with this name.");
                const unique = index ? `${stem} (${index})${extension}` : name;
                const target = join(folder, unique);
                try {
                    try { await link(partial, target); }
                    catch (error) {
                        if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(error.code)) throw error;
                        // FAT/exFAT and restricted hosts may lack hardlinks. Exclusive copy
                        // preserves existing files; its destination becomes visible while copying.
                        await copyFile(partial, target, constants.COPYFILE_EXCL);
                    }
                    job.path = target;
                    job.filename = [...job.filename.split("/").slice(0, -1), unique].join("/");
                    break;
                }
                catch (error) { if (error.code !== "EEXIST") throw error; }
            }
            job.state = "complete";
        } catch (error) {
            job.state = job.cancelRequested ? "cancelled" : "interrupted";
            job.error = job.timeout ? "Download timed out." : job.cancelRequested ? "Download cancelled." : error.message;
        } finally {
            clearTimeout(timer);
            await handle?.close().catch(() => {});
            if (partial) await unlink(partial).catch(() => {});
            // Abort also stops an unconsumed HTTP error/oversized response body.
            job.controller.abort();
            try { await response?.body?.cancel(); } catch {}
            try { await this.persist(); } catch { job.trackingWarning = "Download metadata could not be saved."; }
        }
    }

    async status(input) { return this.metadata(await this.owner(input)); }

    async cancel(input) {
        const job = await this.owner(input);
        if (job.state === "in_progress") { job.cancelRequested = true; job.controller.abort(); await job.done; }
        return this.metadata(job);
    }

    async close() {
        this.closed = true;
        await this.ready;
        for (const job of this.jobs.values()) if (job.state === "in_progress") { job.cancelRequested = true; job.controller.abort(); }
        await Promise.all([...this.jobs.values()].map(job => job.done));
        await this.persistence;
    }
}
