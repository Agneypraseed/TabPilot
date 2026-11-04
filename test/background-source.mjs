import { readFile } from "node:fs/promises";

export const backgroundSource = (await readFile(new URL("../page-runtime.js", import.meta.url), "utf8")) + "\n" +
    (await readFile(new URL("../background.js", import.meta.url), "utf8")).replace('importScripts("page-runtime.js");', "");
