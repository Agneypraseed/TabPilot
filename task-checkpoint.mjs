const imageTypes = new Set(["input_image", "image", "image_url"]);
const recaptureText = "[Image omitted from the saved checkpoint. Capture a fresh screenshot before relying on visual page state.]";

// Checkpoints retain completed tool calls and their results so continuation does
// not repeat actions. Only typed image content is replaced; text (including JSON
// tool results and strings mentioning images) is never interpreted or rewritten.
export function checkpointHistory(history) {
  if (!Array.isArray(history)) throw new TypeError("History must be an array");
  const copy = structuredClone(history);
  const placeholder = () => ({ type: "input_text", text: recaptureText });
  const isImage = value => value && typeof value === "object" && imageTypes.has(value.type);
  const content = value => {
    if (Array.isArray(value)) return value.map(content);
    if (isImage(value)) return placeholder();
    return item(value);
  };
  const item = value => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(item);
    // Do not inspect arbitrary metadata/providerData/structuredContent: objects
    // describing an image there can be ordinary semantic data, not image blocks.
    if (Object.hasOwn(value, "content")) value.content = content(value.content);
    if (Object.hasOwn(value, "output")) {
      if (isImage(value.output)) {
        // A legacy single ToolOutputImage accepts a structured input_* array as
        // its replacement, whereas a bare input_text output is invalid in SDK.
        value.output = value.type === "function_call_result" ? [placeholder()] : placeholder();
      } else value.output = content(value.output);
    }
    return value;
  };
  return copy.map(item);
}
