import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentArguments } from "../agent-options.mjs";

test("agent CLI flags select Meta without modifying the saved model configuration", () => {
    const env = { AGENT_MODEL: "gpt-6-luna" };
    const parsed = parseAgentArguments(["--provider", "meta", "--model", "muse-spark-1.3", "--max-turns", "12", "Fill the practice form"], env);
    assert.equal(parsed.provider, "meta");
    assert.equal(parsed.model, "muse-spark-1.3");
    assert.equal(parsed.maxTurns, 12);
    assert.equal(parsed.prompt, "Fill the practice form");
    assert.equal(env.AGENT_MODEL, "gpt-6-luna");
    assert.throws(() => parseAgentArguments(["--provider", "meta", "task"], env), /Specify --model/);
    assert.throws(() => parseAgentArguments(["--max-turns", "0", "task"], env), /1–100/);
    assert.throws(() => parseAgentArguments(["--timeout-ms", "99999999", "task"], env), /1000–900000/);
});
