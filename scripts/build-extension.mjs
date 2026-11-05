import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const result = await build({
    absWorkingDir: fileURLToPath(root), entryPoints: ["extension-runtime.mjs"],
    outfile: "vendor/extension-runtime.js", bundle: true, platform: "browser",
    format: "esm", target: ["chrome118"], conditions: ["browser"],
    // Escape multiline strings so generated assets remain safe to diff/check.
    supported: { "template-literal": false },
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true, legalComments: "linked", metafile: true,
    logLevel: "info"
});
await mkdir(new URL(".tabpilot/", root), { recursive: true });
await writeFile(new URL(".tabpilot/extension-build-meta.json", root), JSON.stringify(result.metafile, null, 2));

const notificationBuild = await build({
    absWorkingDir: fileURLToPath(root), entryPoints: ["extension-notification-network.mjs"],
    outfile: "vendor/notification-network.js", bundle: true, platform: "browser",
    format: "iife", target: ["chrome118"], conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    supported: { "template-literal": false }, minify: true, metafile: true, logLevel: "info"
});
for (const [path, data] of Object.entries(notificationBuild.metafile.inputs)) result.metafile.inputs[path] = data;

// Keep third-party license texts alongside the committed runtime bundle.
const packages = new Set(Object.keys(result.metafile.inputs).map(path =>
    /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1]).filter(Boolean));
const notices = [];
for (const name of [...packages].sort()) {
    const folder = new URL(`node_modules/${name}/`, root);
    const info = JSON.parse(await readFile(new URL("package.json", folder), "utf8"));
    const licenseFiles = (await readdir(folder)).filter(file => /^(?:licen[cs]e|notice)(?:\.|$)/i.test(file));
    const texts = await Promise.all(licenseFiles.map(file => readFile(new URL(file, folder), "utf8")));
    notices.push(`${name} ${info.version} (${info.license ?? "See upstream license"})\n${texts.join("\n") || "License: " + info.license}`);
}
await writeFile(new URL("vendor/extension-runtime.LICENSES.txt", root), notices.join("\n\n" + "=".repeat(72) + "\n\n").trimEnd() + "\n");
