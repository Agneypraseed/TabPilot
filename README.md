# TabPilot · Browser Agent

TabPilot is a Chrome browser agent with an on-device open-weight model, optional hosted models, and a local Playwright/MCP connection. Its task panel reads visible page text and controls, chooses one bounded browser action at a time, and pauses for review when an action is uncertain or consequential.

The default model is **Qwen2.5 0.5B on CPU**, running inside Chrome through Transformers.js and ONNX Runtime WebAssembly. **Gemma 3 270M on CPU** is experimental: its weights load successfully, but it failed our button-selection test. These options are free to run and require no API key, paid service, local server, or WebGPU adapter. First use downloads about 512 MB for Qwen or 450 MB for Gemma into Chrome’s cache. Gemma uses a pinned export compatible with CPU inference; the newer smaller export requires an embedding operation unavailable in the browser WASM runtime. The extension bundles the JavaScript/WASM runtime locally. GPU models through WebLLM and hosted providers remain optional.

The CPU model generates a short command naming a visible control. The extension parses the model's command and requires a unique exact DOM label; it never selects a button by matching the user's task itself. Invented or ambiguous targets become an Ask user response. CPU mode can click, hover, scroll, press keys, and enter exact text supplied by the user. It does not generate new text for a form. CPU actions require approval by default; the auto-approve option enables an unattended run. Small models may misunderstand tasks, and no calibrated confidence estimate is available.

For simple singular commands joined by “then,” the CPU controller presents one pending instruction at a time. Successful input of the required kind advances the sequence; the model still selects the control from the live page. Scrolling to reveal a button does not advance a click instruction. The last requested result must still be checked by the model. Instructions such as “download all files” keep the full task instead of assuming one click per step. Qwen has passed offline single-button and menu/shadow-DOM tests; bulk downloads and general website reliability remain unverified.

For download tasks, TabPilot tracks each Chrome download and waits for it to complete before the model chooses the next file. The task folder is relative to Chrome’s Downloads folder (default `Downloads/TabPilot`); Chrome remains responsible for the Downloads root and any safety prompts. Only downloads initiated by the current task page are routed during that run.

The Playwright bridge reuses your existing Chrome profile, open tabs, logins, and cookies. Only tabs you explicitly enable are exposed to CLI and MCP clients. On-device task control uses the extension directly and does not share the tab with Playwright unless you enable it.

## Install

Use Node.js 20 or newer. Install dependencies and build the unpacked extension:

```powershell
npm install
npm run build
npm test
```

In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the generated `dist` directory. Open a regular website and the TabPilot side panel, select **On-device · local models**, then start a task. The first run downloads the chosen model; subsequent inference runs locally. You do not need `npm start` for on-device tasks.

To use hosted providers or the Playwright CLI/MCP tools, copy `.env.example` to `.env`, add the desired API key, and start the local bridge with `npm start`. Enable the tab in the side panel to share it with CLI and MCP clients.

## CLI

The CLI works with the local bridge and installed extension:

```powershell
npm run cli -- tabs
npm run cli -- snapshot --tab 0
npm run cli -- click --role button --value "Continue" --tab 0
npm run cli -- fill --label "Search" --text "hiking backpacks" --tab 0
npm run cli -- press --key Enter --tab 0
```

Other actions include `goto`, `open`, `hover`, `scroll`, `select`, and `close`. Run `npm run cli -- help` for the full syntax. Selectors use accessible roles, labels, placeholders, visible text, or test IDs; an action runs only when its selector matches one element.

## MCP

Configure your MCP client to start `mcp.mjs` from this directory. For example, in a client that accepts stdio MCP servers:

```json
{
  "mcpServers": {
    "tabpilot": {
      "command": "node",
      "args": ["D:\\path\\to\\Jev\\mcp.mjs"]
    }
  }
}
```

The server provides `browser_tabs`, `browser_snapshot`, `browser_navigate`, `browser_click`, `browser_fill`, `browser_hover`, `browser_press`, `browser_scroll`, `browser_select`, `browser_open`, `browser_close`, and `browser_screenshot`. Click, fill, and other element actions use accessible locators. Browser operations stay in the local Chrome profile and require the tab to be enabled in the extension.

## Local services and security

The optional decision API and authenticated Playwright CDP relay bind only to `127.0.0.1:4311`. A random bridge credential is stored in the ignored `.tabpilot/bridge.json`; the signed TabPilot extension is the only Chrome extension allowed to retrieve it. Provider credentials remain in `.env` and are never returned by the health or provider-list endpoints. Do not expose the bridge port to a network.

Direct provider variables are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY`. Add the matching `*_MODEL` variable to set the initial model. For local or compatible inference servers, set `COMPATIBLE_BASE_URL`, `COMPATIBLE_MODEL`, and optionally `COMPATIBLE_API_KEY`. Loopback HTTP endpoints are supported; other endpoints must use HTTPS. Jev remains available through `AI_GATEWAY_API_KEY`.

The task panel identifies buttons from visible DOM text, accessibility labels (`aria-label`, `aria-labelledby`, associated labels), and image alt text. It also reads controls inside open shadow roots. A vision model is unnecessary for these controls. Canvas controls and images without accessible DOM labels need a separate vision implementation; iframe controls are not included in the panel's current snapshot.

Before clicking, the extension verifies that the selected DOM element still exists, has the same meaning, remains enabled and visible, and is not covered. It uses the element's current position rather than coordinates saved before model inference. The input goes through Chrome's debugger mouse events, so the page receives a real browser click.

CPU inference needs sufficient RAM and can take time, especially on the first run. Chrome may prevent debugger attachment to protected pages or while DevTools is attached. If Chrome reports that it cannot find a WebGPU adapter, select either CPU model. The CPU path never requests a GPU adapter. An AMD driver timeout occurred during an earlier GPU test on this machine; CPU models are now the default.

To use local inference, reload the extension from `dist`, select **On-device · local models**, then **Qwen2.5 · 0.5B · CPU** or **Gemma 3 · 270M · CPU**. Ask it to click a named button on a regular web page. GPU options require a compatible, stable WebGPU device; they are not used by the local CPU verification.

Run `npm run verify:click` for local Qwen model-to-browser verification. It builds the extension, loads the CPU model in an isolated Chrome profile with GPU disabled and hosted inference blocked, and tests choosing the correct button among competing controls, a trusted browser click, and recognition of the completed result. Evidence is saved under `.test-artifacts/local-cpu`; model downloads are retained in `.cache/local-cpu-profile` for subsequent runs. `npm run verify:local-models` also includes experimental Gemma and reports its failures. Test one model with `node verification/local-cpu.mjs qwen` or `gemma` after building. Add `--offline` to test using cached weights with Chrome offline, `--auto` to exercise auto-approved actions, or `--menu` for a two-step menu/shadow-DOM task. The harness approves only the requested fixture control, records approvals, and fails on a wrong selection or premature completion.

The separate `npm run verify:hosted` suite uses real hosted API calls and may incur charges. It checks layout changes, menus, shadow DOM, stale/covered controls, and CLI/MCP operations. It requires configured provider credentials and is not part of the default local verification.
