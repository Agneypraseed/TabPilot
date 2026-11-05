import { copyFile, mkdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
await mkdir(new URL("vendor/", root), { recursive: true });
for (const [source, target] of [
    ["marked/lib/marked.umd.js", "marked.js"],
    ["marked/LICENSE", "marked.LICENSE"],
    ["dompurify/dist/purify.min.js", "purify.js"],
    ["dompurify/LICENSE", "dompurify.LICENSE"],
    ["dompurify/LICENSE-MPL", "dompurify.LICENSE-MPL"],
]) await copyFile(new URL(`node_modules/${source}`, root), new URL(`vendor/${target}`, root));
