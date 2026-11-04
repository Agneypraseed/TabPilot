# TabPilot implementation guide

The product runs through two interchangeable entry points:

```text
CLI ---------------------------+
                               v
Agent -> MCP -> HTTP bridge -> WebSocket -> extension -> enabled Chrome tab
```

The agent runs locally and calls a selected model API. Tool execution stays local. The model receives the page text or images returned by the tools it chooses.

## Learn by commit

Run `git show COMMIT` to inspect each implementation independently. Commits are listed in the order they were built.

| Commit | Functionality | Main files |
| --- | --- | --- |
| `7b7d6b0` | Interactive snapshots, semantic names, scoped refs, shadow targets | `page-runtime.js`, `background.js` |
| `d944106` | Explicit enable/disable attaches and detaches the debugger | `browser-controller.js`, `popup.js`, `manifest.json` |
| `145e086` | Click, hover, fill, key, select, scroll; validated local transport | `browser-controller.js`, `commands.mjs`, `server.mjs` |
| `7c8b0fe` | Navigation, history, waiting, dialogs, tab lifecycle | `browser-controller.js`, `commands.mjs` |
| `5503fb4` | Viewport images and screenshot-bound pointer/drag actions | `browser-controller.js`, `page-runtime.js` |
| `88d5d10` | CLI commands and MCP action/image tools | `cli.mjs`, `mcp.mjs` |
| `e7d3bb2` | Agent acts and observes, image delivery, turn/time limits | `agent.mjs`, `test/agent.test.mjs` |
| `5f12e51` | Live-test fix: device pixel scaling and shadow style text | `browser-controller.js`, `page-runtime.js` |
| `e467976` | Explicit provider/model flags and run-limit flags | `agent-options.mjs`, `agent.mjs` |

Earlier commits introduce the permission popup, local bridge, read-only MCP tools, and provider adapters. See `git log --oneline` for those steps.

## Responsibilities

- `popup.js` asks the extension background worker to enable a tab; it does not grant the agent arbitrary Chrome access.
- `background.js` owns pairing, dispatches authenticated bridge requests, and cleans up closed tabs.
- `browser-controller.js` checks enabled state before each Chrome command, attaches `chrome.debugger`, and uses CDP input/navigation/screenshot methods. Each tab allows one operation at a time; overlapping requests receive `TAB_BUSY` rather than becoming delayed side effects.
- `page-runtime.js` is serialized into a Chrome isolated world. It discovers targets and validates refs against the actual element and its semantic identity. Page text cannot change extension permissions.
- `commands.mjs` defines allowed commands and argument schemas. The bridge does not expose raw CDP or arbitrary JavaScript to a model.
- `server.mjs` accepts authenticated local requests, correlates replies, limits payloads, and handles disconnects/timeouts. `.tabpilot/bridge.json` contains its current local token and is ignored by Git.
- `bridge-client.mjs` is shared by CLI and MCP. It validates the local address and reads the current token for each request.
- `mcp.mjs` publishes typed tools. Screenshots include an MCP image content block, not only a base64 string buried in text.
- `agent.mjs` connects local MCP to the model and uses a bounded observe/act loop. It preserves image content in model context, operates one tool at a time, and closes MCP even on errors. `agent-models.mjs` chooses the provider and matching credential.

## References and screenshot coordinates

A new snapshot replaces the previous ref map. Removed, renamed, disconnected, or navigated targets are rejected. Actions return a new snapshot, so the next step can use fresh refs.

A screenshot has its own short-lived ID. Its image pixel dimensions are decoded from the JPEG rather than inferred from CSS dimensions: display scaling and zoom make those different. Pointer coordinates are converted back to CSS coordinates for CDP. Navigation, scrolling, viewport changes, DOM mutations, and prior actions invalidate visual targeting. Canvas updates without DOM mutations cannot all be detected; always re-observe after acting.

Navigation stays in an already enabled tab. New tabs start disabled, including tabs opened by an agent, and the user must enable them explicitly. Cross-origin iframe DOMs and closed shadow roots may need screenshot-based targeting.

## Side-panel task sessions

`4ed71af` adds the runtime behind the agent UI. `agent-service.mjs` owns run state, safe model preferences, follow-up context, cancellation, and guidance. `agent-browser-session.mjs` wraps the existing MCP client: it restricts panel runs to the selected tab, gates operations when paused, rejects obsolete actions when guidance arrives, and includes actual screenshots in Computer use mode. `agent.mjs` still runs the SDK loop for both terminal and panel callers.

The extension uses `sidepanel.html`, `sidepanel.css`, and `sidepanel.js`. Chrome's sidePanel API keeps the UI open next to the page. `background.js` forwards UI commands over the already authenticated WebSocket; `server.mjs` routes them to the local AgentService. Provider keys never cross that connection. The original `popup.html`/`popup.js` remain as a small learning example but are no longer the toolbar action.

Pause is a checkpoint, not a browser rollback. New guidance received during a model request prevents its now-obsolete tool calls from executing; the next model request includes the guidance. Stop aborts the SDK run and cancels paused work. Tool operations are serialized even if a model proposes several at once. A completed tool can still have side effects after a user presses Stop if Chrome already received it, so the next task observes the page again.

UI tests in `test/sidepanel.test.mjs` exercise the actual DOM controller with simulated Chrome APIs. `verification/ui-preview-server.mjs` serves the same UI with explicitly simulated data for browser layout checks; it never runs a model or connects to the bridge. Runtime tests exercise actual SDK tool loops and authenticated WebSocket state/control messages. Live browser verification is separate.

## Verification

`npm test` runs deterministic tests for access isolation, stale refs, command validation, input dispatch, lifecycle, model adapters, MCP images, agent tool feedback, and limits. Chrome APIs or model responses are mocked where appropriate; those tests alone do not prove a live browser action.

`npm run verify:meta` is a separate paid live acceptance test. It uses real Meta calls, the extension, MCP, and the practice page. The practice server independently records submitted values and canvas activation. A passing run requires the exact requested form values, exactly one additional submission, a screenshot tool call, a pointer tool call, and server-confirmed visual completion. Artifacts are local and ignored by Git.

Live testing also verified direct controls, same-tab navigation/history, and open shadow controls. The embedded browser did not expose a usable native prompt in the dialog exercise; dialog event/response handling is tested with mocked Chrome events and is subject to the browser host. Universal website compatibility, CAPTCHA solving, native OS dialogs, and permission bypasses are not claimed.
