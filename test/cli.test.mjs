import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);

test("CLI validates arguments and local configuration without exposing a token to another host", async (t) => {
    const fixtureRoot = fileURLToPath(new URL("../.tabpilot/", import.meta.url));
    await mkdir(fixtureRoot, { recursive: true });
    const directory = await mkdtemp(join(fixtureRoot, "tabpilot-cli-test-"));
    // Remove only the fresh directory returned by mkdtemp for this test.
    t.after(async () => {
        assert.equal(resolve(dirname(directory)), resolve(fixtureRoot));
        assert.ok(basename(directory).startsWith("tabpilot-cli-test-"));
        await rm(directory, { recursive: true, force: true });
    });
    const script = join(directory, "cli.mjs");
    await copyFile(new URL("../cli.mjs", import.meta.url), script);
    await copyFile(new URL("../bridge-client.mjs", import.meta.url), join(directory, "bridge-client.mjs"));
    await copyFile(new URL("../commands.mjs", import.meta.url), join(directory, "commands.mjs"));
    await assert.rejects(execute(process.execPath, [script, "unknown"]), error => {
        assert.match(error.stderr, /Usage/);
        assert.equal(error.code, 1);
        return true;
    });
    await assert.rejects(execute(process.execPath, [script, "tabs"]), /Start the local bridge/);
    await mkdir(join(directory, ".tabpilot"));
    const config = join(directory, ".tabpilot", "bridge.json");
    await writeFile(config, JSON.stringify({ url: "https://example.com", token: "test-secret" }));
    await assert.rejects(execute(process.execPath, [script, "pair"]), /Invalid bridge configuration/);
    await writeFile(config, JSON.stringify({ url: "http://127.0.0.1:4311", token: "test-secret" }));
    const result = await execute(process.execPath, [script, "pair"]);
    assert.equal(result.stdout.trim(), "test-secret");
    assert.equal(result.stderr, "");
    await assert.rejects(execute(process.execPath, [script, "snapshot", "oops"]), /Usage/);
});
