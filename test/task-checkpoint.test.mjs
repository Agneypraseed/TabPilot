import test from "node:test";
import assert from "node:assert/strict";
import { protocol } from "@openai/agents-core";
import { checkpointHistory } from "../task-checkpoint.mjs";

test("checkpoint preserves ordered semantic tool call/result pairing and clones history", () => {
  const history = [
    { role: "user", content: "Find the report" },
    { type: "function_call", callId: "call-1", name: "browser_click", arguments: '{"target":"download"}', status: "completed" },
    { type: "function_call_result", callId: "call-1", name: "browser_click", status: "completed", output: JSON.stringify({ clicked: true, type: "image", image: "semantic field" }) },
    { type: "function_call", callId: "call-2", name: "browser_snapshot", arguments: "{}", status: "completed" },
    { type: "function_call_result", callId: "call-2", name: "browser_snapshot", status: "completed", output: [{ type: "input_text", text: "The report was downloaded. data:image/png;base64,keep-this-text" }] },
    { role: "assistant", status: "completed", content: [{ type: "output_text", text: "Check the downloaded report." }] },
  ];
  const saved = checkpointHistory(history);
  assert.deepEqual(saved, history);
  assert.notEqual(saved, history);
  assert.notEqual(saved[4].output, history[4].output);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), history);
  protocol.FunctionCallResultItem.parse(saved[2]);
  protocol.FunctionCallResultItem.parse(saved[4]);
  saved[4].output[0].text = "Changed";
  assert.ok(history[4].output[0].text.startsWith("The report"));
});

test("checkpoint removes large images from input and structured tool results without mutating originals", () => {
  const image = "data:image/png;base64," + "a".repeat(1000000);
  const history = [
    { role: "user", content: [{ type: "input_text", text: "Inspect this" }, { type: "input_image", image, detail: "high" }] },
    { type: "function_call", name: "browser_screenshot", callId: "shot", arguments: "{}", status: "completed" },
    { type: "function_call_result", name: "browser_screenshot", callId: "shot", status: "completed", output: [{ type: "input_text", text: "Captured tab 12" }, { type: "input_image", image }] },
  ];
  const saved = checkpointHistory(history);
  assert.equal(saved.length, history.length);
  assert.equal(saved[2].callId, saved[1].callId);
  assert.deepEqual(saved[2].output[0], history[2].output[0]);
  for (const block of [saved[0].content[1], saved[2].output[1]]) {
    assert.equal(block.type, "input_text");
    assert.match(block.text, /fresh screenshot/);
    protocol.InputText.parse(block);
  }
  protocol.UserMessageItem.parse(saved[0]);
  protocol.FunctionCallResultItem.parse(saved[2]);
  assert.ok(JSON.stringify(saved).length < 2000);
  assert.equal(history[0].content[1].image, image);
  assert.equal(history[2].output[1].type, "input_image");
});

test("SDK image variants and legacy tool output become valid text while metadata stays semantic", () => {
  const history = [
    { role: "user", content: [{ type: "image", image: "base64-data" }, { type: "image_url", image_url: { url: "https://example.test/image" } }] },
    { type: "function_call_result", name: "capture", callId: "legacy", status: "completed", output: { type: "image", image: { data: new Uint8Array([1, 2, 3]), mediaType: "image/png" } } },
    { type: "function_call_result", name: "capture", callId: "mcp", status: "completed", output: { content: [{ type: "text", text: "Success" }, { type: "image", data: "base64-mcp", mimeType: "image/png" }], structuredContent: { type: "image", image: "ordinary semantic record" } } },
    { role: "user", content: "Keep image references", providerData: { type: "image", image: "ordinary provider metadata" } },
  ];
  const saved = checkpointHistory(history);
  assert.ok(saved[0].content.every(block => block.type === "input_text"));
  protocol.FunctionCallResultItem.parse(saved[1]);
  assert.equal(saved[1].output[0].type, "input_text");
  assert.equal(saved[2].output.content[1].type, "input_text");
  assert.deepEqual(saved[2].output.structuredContent, history[2].output.structuredContent);
  assert.deepEqual(saved[3].providerData, history[3].providerData);
  assert.equal(history[1].output.image.data.length, 3);
});

test("empty checkpoints remain empty and non-array inputs are rejected", () => {
  assert.deepEqual(checkpointHistory([]), []);
  for (const invalid of [null, undefined, "history", {}]) assert.throws(() => checkpointHistory(invalid), /array/);
});
