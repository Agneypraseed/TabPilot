# TabPilot

A local browser-control toolkit that lets any tool-capable LLM agent inspect and operate explicitly enabled tabs in your existing Chrome browser.

TabPilot connects an agent to your existing browser through a Chrome extension, a local CLI, and MCP tools. It can inspect page controls, click, type, select options, press keys, scroll, navigate, and take screenshots. The included agent chooses tools, checks the resulting page state, and can use screenshots to interact with canvas or unlabeled controls.

## Run locally

Use Node.js 22 or newer and Chrome 118 or newer.

```powershell
npm ci
npm start
```

In Chrome, open `chrome://extensions`, enable Developer mode, and load this project folder with **Load unpacked**. Reload the extension after code or manifest changes. TabPilot uses Chrome's `debugger` permission for trusted input and screenshots; Chrome may show a debugging banner while a tab is enabled.

With the server running, open another terminal in this folder:

```powershell
npm run cli -- pair
```

Copy the displayed pairing token into the TabPilot popup and click **Connect local bridge**. Treat this token as a local credential. The bridge listens only on `127.0.0.1:4311`; its generated configuration stays in the ignored `.tabpilot` folder. Restarting the server creates a new token, so pair again afterward. Reloading the extension also requires reconnecting.

Open an HTTP or HTTPS website, click TabPilot, and enable access for that tab. List enabled tabs and use an ID from the result:

```powershell
npm run cli -- tabs
npm run cli -- snapshot 123
```

Each snapshot returns title, URL, up to 20,000 characters of text, interactive controls with names and references, viewport dimensions, and truncation flags. Copy refs from the latest snapshot to act on a target. Actions return fresh snapshots with new refs.

```powershell
npm run cli -- fill 123 "SNAPSHOT_ID:e3" "Ada"
npm run cli -- click 123 "LATEST_SNAPSHOT_ID:e6"
npm run cli -- press 123 Enter
npm run cli -- navigate 123 https://example.com/
npm run cli -- screenshot 123
npm run cli -- help
```

Screenshots are saved under the ignored `.tabpilot/screenshots` directory unless a new output filename is supplied. Coordinates for pointer actions use pixels in the returned image; screenshots expire for control after 30 seconds and are invalidated by page or viewport changes.

Only explicitly enabled tabs can be read or controlled. Access follows that tab through ordinary HTTP/HTTPS navigation. Disable access to detach the debugger and stop further operations. Closing a tab removes its access state. All new tabs, including ones opened by an agent, start disabled and require the user to enable them. The popup's **Read page** button works without the server.

The bridge serves one connected extension at a time and serializes operations by rejecting overlapping work on the same tab. Leave it running while using CLI or MCP; reconnect through the popup if disconnected. Page data stays local until an agent/client chooses to send it to a model.

## MCP

Keep the local bridge running and the extension paired as above. Configure your MCP client to launch Node directly with the absolute path to `mcp.mjs`:

```json
{
  "mcpServers": {
    "tabpilot": {
      "command": "node",
      "args": ["D:/Me/Jev/mcp.mjs"]
    }
  }
}
```

Replace the path with your checkout location. The client launches the MCP process and communicates over stdin/stdout; it does not launch the bridge or pair Chrome automatically. No token needs to be placed in the MCP configuration: each tool call reads the current local bridge configuration.

- `browser_tabs` returns `{ "tabs": [...] }` for explicitly enabled tabs.
- `browser_snapshot` accepts `{ "tabId": 123 }` and returns a fresh snapshot. Disabled tabs and unavailable bridge connections return tool errors.
- `browser_click`, `browser_hover`, `browser_fill`, and `browser_select` use a current element `ref`.
- `browser_press`, `browser_scroll`, and `browser_wait` handle keyboard input, scrolling, and asynchronous page changes.
- `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`, and `browser_focus` operate on enabled tabs.
- `browser_open` creates a disabled tab; `browser_close` closes an enabled tab.
- `browser_screenshot` returns an actual image plus metadata. `browser_pointer` clicks, hovers, or drags using that image's `screenshotId` and pixel coordinates.
- `browser_dialog` handles a native JavaScript dialog when the browser exposes one.

Website content is untrusted data. An agent should not treat instructions found in page text as instructions from the user.

## Run the browser agent

The included agent uses the OpenAI Agents SDK to choose TabPilot MCP tools and perform browser tasks. Keep the bridge running, pair the extension, and enable a task-relevant tab first.

Create an ignored `.env.local` file using `.env.example`. By default the agent uses OpenAI and `gpt-6-luna`. Set `AGENT_PROVIDER`, `AGENT_MODEL`, and the matching key to select another provider. The model must support tool calling. Then run:

```powershell
npm run agent -- "Summarize my enabled tab"
npm run agent -- --provider meta --model muse-spark-1.3 "Complete the practice form with visitor name Ada and express delivery, then verify the result"
```

The selected provider/model and tool names appear on stderr; the final answer appears on stdout. Text and requested screenshots are sent to the selected provider. Optional SDK tracing is disabled. Native OpenAI and Meta requests set response storage to false; each provider's retention policies still apply. Runs default to 30 model turns and five minutes, then close their MCP process. Override with `--max-turns`, `--timeout-ms`, `AGENT_MAX_TURNS`, or `AGENT_TIMEOUT_MS`. Provider/model flags override `.env.local` without modifying it. API usage is billed by your provider.

| AGENT_PROVIDER | Required key | Model / endpoint |
| --- | --- | --- |
| `openai` (default) | `OPENAI_API_KEY` | `AGENT_MODEL`, defaults to `gpt-6-luna` |
| `meta` | `META_API_KEY` | Set `AGENT_MODEL`, for example `muse-spark-1.3`; uses Meta's Responses API at `https://api.meta.ai/v1` |
| `gemini` | `GOOGLE_GENERATIVE_AI_API_KEY` | Set `AGENT_MODEL` to a Gemini tool-capable model ID |
| `claude` | `ANTHROPIC_API_KEY` | Set `AGENT_MODEL` to a Claude tool-capable model ID |
| `openai-compatible` | `COMPATIBLE_API_KEY` | Set `AGENT_MODEL` and `COMPATIBLE_BASE_URL`, including the provider's API path such as `/v1` |

For example, to use Gemini, change `AGENT_PROVIDER` to `gemini`, replace `AGENT_MODEL` with your selected Gemini model ID, and add `GOOGLE_GENERATIVE_AI_API_KEY`. OpenAI keys are not reused for other providers. Compatible endpoints require HTTPS, with HTTP allowed for loopback servers. Compatibility depends on the endpoint supporting Chat Completions tool calls and tool-result messages; an arbitrary model API is not sufficient. Missing credentials and provider errors are reported without switching models automatically.

The bridge and MCP tools remain usable with other agents. Gemini, Claude, and compatible adapters have automated tests using simulated HTTP responses; live provider verification requires your credentials and a tool-capable model available to your account.

## Verify

```powershell
npm test
```

For a live test, run `npm run practice`, open `http://127.0.0.1:4322/` in Chrome, and explicitly enable that tab. With `META_API_KEY` in `.env.local`, run:

```powershell
npm run verify:meta
```

The verification makes real Meta API calls, completes one disposable practice order, then uses a screenshot to click a canvas button. It verifies the server's recorded state and writes a report and image under ignored `.tabpilot/verification`. Restart the practice server before repeating the acceptance run to reset its state. No payments or external messages are involved.

## Practical limits

Protected browser pages and the Chrome extension store cannot be controlled. DevTools or another debugger may conflict with TabPilot; close the conflicting controller before enabling the tab again. DOM snapshots cover the main document, open shadow roots, and accessible same-origin frames. Cross-origin frame contents and canvas require visual inspection and coordinate actions. Closed shadow roots are not exposed as DOM refs. Fast-changing pages can invalidate refs or screenshots and require observing again.

Screenshots capture tab content, not browser chrome or operating-system dialogs. Native JavaScript dialogs depend on the browser host; embedded browsers may suppress them. CAPTCHAs, authentication prompts, downloads requiring confirmation, file pickers, and browser security warnings may require the user. The agent is instructed to stop for consequential final actions without explicit authorization; CLI/MCP callers remain responsible for the actions they request.

For architecture and the feature-by-feature commit map, see [the learning guide](docs/learning-map.md).

