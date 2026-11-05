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

Navigation stays in an already enabled tab. All regular web tabs, including agent-created tabs, have access by default. A shared policy helper treats an explicit false as revocation; Settings can revoke/restore any open web tab across windows. Cross-origin iframe DOMs and closed shadow roots may need screenshot-based targeting.

## Side-panel task sessions

`4ed71af` adds the runtime behind the agent UI. `agent-service.mjs` owns run state, safe model preferences, follow-up context, cancellation, and guidance. `agent-browser-session.mjs` wraps the existing MCP client: it restricts panel runs to the selected tab, gates operations when paused, rejects obsolete actions when guidance arrives, and forwards requested screenshot images to both the model and the UI. `agent.mjs` still runs the SDK loop for both terminal and panel callers.

The workspace now has one Agent flow. The model chooses semantic page tools or screenshot/pointer tools according to the task. Screenshots are requested explicitly, rather than captured after every action, and focusing a tab is also a tool choice. Legacy browser/computer mode values remain accepted in saved records and API payloads for compatibility, but no longer select different runner behavior. Run limits remain enforced and configurable under collapsed Advanced settings; the turn limit applies per stage, and active-time expiry still ends the current stage with an error. Research specialists and coordinator collection are unchanged. Historical Computer use acceptance below describes the earlier UI.

The extension uses `sidepanel.html`, `sidepanel.css`, and `sidepanel.js`. Chrome's sidePanel API keeps the UI open next to the page. `background.js` forwards UI commands over the already authenticated WebSocket; `server.mjs` routes them to the local AgentService. Provider keys never cross that connection. The original `popup.html`/`popup.js` remain as a small learning example but are no longer the toolbar action.

Pause is a checkpoint, not a browser rollback. New guidance received during a model request prevents its now-obsolete tool calls from executing; the next model request includes the guidance. Stop aborts the SDK run and cancels paused work. Tool operations are serialized even if a model proposes several at once. A completed tool can still have side effects after a user presses Stop if Chrome already received it, so the next task observes the page again.

UI tests in `test/sidepanel.test.mjs` exercise the actual DOM controller with simulated Chrome APIs. `verification/ui-preview-server.mjs` serves the same UI with explicitly simulated data for browser layout checks; it never runs a model or connects to the bridge. Runtime tests exercise actual SDK tool loops and authenticated WebSocket state/control messages. Live browser verification is separate.

UI feature commits: `af76d8b` adds the complete agent interface and settings; `2bac618` adapts it to embedded browsers with a popup and persistent workspace. Recovery checks additionally ensure a restarted bridge can replace older high-revision UI state, trusted extension workspace tabs can send messages, and mid-run guidance remains in follow-up conversation history. The SDK input filter alone does not retain inserted guidance in `result.history`, so the runner explicitly saves those user messages before the final answer.

Live workspace acceptance used Meta `muse-spark-1.3` in Computer use mode. The user submitted the task through the extension UI and confirmed its activity/screenshot display; a separate CLI read verified Visitor name `UI Test`, delivery `express`, and Gift wrap checked. The practice backend contained no submitted order with that visitor name. No payment or external communication was performed. Direct automation of the extension workspace was blocked by the browser tool's URL policy, so the live UI interaction was user-operated rather than falsely claimed as tool-operated.

## Visible input feedback

`browser-controller.js` asks the isolated page runtime to render a proper SVG arrow and circular click ripple. CSS animates the arrow locally over 240ms; there is one command per movement, rather than debugger highlights sent for each frame. A closed shadow root isolates its styles; pointer-events:none prevents input interception. The runtime tracks its own decoration nodes in a private WeakSet, excluding only those mutations from screenshot-change detection. Real website changes still invalidate targeting. The pointer stays out of snapshots, hides for screenshots, respects reduced motion, and removes itself after inactivity. This replaces the earlier debugger Overlay implementation, whose square highlight looked rough. The layout chooser and Settings call Chrome's native sidePanel API only after the user chooses that presentation; embedded hosts may still require a separate workspace tab.

`typeText` sends short, Unicode-safe chunks with a 45ms pause, capped at 24 chunks for long values. Before each insertion, `page-runtime.js` checks that the same cached element remains focused, connected, visible, and editable. It does not re-focus a different target after the user takes over. These are trusted input operations, with the existing access check before every command.

## Per-tab trace history

`trace-history.mjs` stores append-only run events and separate screenshot files under `.tabpilot/history/<browser-session>/tab-<id>/<run-id>/`. Metadata records task, source, provider/model, timestamps, and outcome. Reads and writes are serialized; history pages are bounded and images load only on demand. The live conversation's 160-event cap does not truncate the archive. Starting a new chat does not delete it.

`background.js` retains a browser-history namespace in Chrome local storage across extension reloads and changes it on browser startup. The bridge binds history requests to that authenticated extension namespace. Tab, run, and image identifiers are validated before constructing file paths. This avoids mixing different tabs, browser instances, or reused tab IDs.

`agent-service.mjs` records workspace tasks, guidance, status changes, results, and errors. Its MCP subprocess carries a run ID, allowing `server.mjs` to attach browser requests/results to the correct workspace task. The same authenticated HTTP boundary also records external CLI/MCP calls. It does not record authorization headers or model internals; typed text arguments are omitted, and configured secrets are redacted. `sidepanel.js` displays only the selected tab's history and ignores stale responses after switching tabs.

Live verification used the user-operated workspace with Meta `muse-spark-1.3` and a read-only practice-page task. A separate disk read confirmed the task, tool request/result, final response, model, and completed status. A real CLI screenshot and real MCP stdio snapshot created separately labeled entries for the same tab; the archived screenshot bytes matched the CLI image exactly. Another tab ID returned no matching runs. Local fixture browser checks validate layout; user-operated extension checks and independent saved-file inspection validate the live path. History records new activity; it cannot reconstruct work performed before recording was added.

## Human collaboration

`human-requests.mjs` owns pending requests and the active-time budget. Requests are scoped to a run and browser namespace, expire, and are consumed only once. A CAPTCHA handoff accepts manual completion, not approval for the agent to solve it. Abort cancels pending waits. `agent-interactions.mjs` exposes the SDK help tool and gates important or every proposed action before the MCP request can reach Chrome. The active budget pauses during user input and ordinary pauses.

The default approval policy now targets consequential actions. Enter, pointer clicks/dragging, routine downloads, tab management and generic Submit/Confirm labels no longer trigger approval on their own. Recognized payment/purchase, publishing/sending, destructive, and sensitive-account labels still gate dispatch, including destructive native-dialog acceptance. For consequential coordinate actions or controls whose label does not describe their effect, the model must use `request_user_help` with kind `approval` before acting. This contextual assessment depends on the model; the label classifier is a heuristic rather than a complete action-risk detector. Optional Every action mode retains stricter prompts. The user-requested default supersedes older blanket download/Enter/pointer approval behavior below.

`attention-alerts.js` maintains one notification per request and a pending-count badge, with generic desktop text. `attention-tone.js` provides a local two-note sound; `attention-audio.html` is the optional offscreen playback document. The workspace falls back to its own unlocked AudioContext if an embedded host lacks offscreen support. UI cards preserve a draft across state updates and use the exact request/run IDs when responding. History stores the request and reply.

## Persistent tasks and research workers

`task-store.mjs` serializes atomic schedule/progress writes to a local file. Loading a restarted store marks in-flight work interrupted, requiring review rather than replay. `task-manager.mjs` wraps separate AgentService sessions, leases one task per tab, reserves a bounded execution slot before research approval, and rechecks cancellation after persistence. A stable browser profile ID lets the UI display unfinished work after Chrome rotates the history namespace; rebind creates a new task identity on an explicitly chosen tab.

The `complete_task` SDK tool records completion evidence. Ordinary final answers or max-turn errors do not complete a scheduled task: complete SDK tool history carries into another bounded stage. `task-checkpoint.mjs` removes function-tool image blocks from saved checkpoints while retaining tool call/result pairing. Restart resumes from a fresh observation instead of replaying unknown pending calls.

`delegate_research` creates a child web tab, rechecks that it is accessible, and launches the specialist without an access prompt. Revoked or protected targets are rejected. The obsolete private grant route was removed, so delegation cannot silently restore a revoked tab. Each specialist has its own tab/session/history. `collect_worker_result` suspends the coordinator's active budget until the actual child outcome arrives. Stopping the parent cancels unfinished children.

`agent.mjs` also reports SDK-local help, delegation, collection, and completion tool inputs/results. `agent-service.mjs` archives those directly, since they do not cross the HTTP browser boundary. Browser calls retain their central archive path without duplication; both appear in the activity trail.

`task-view.js` renders the per-tab queue and parent/worker tree with text-only DOM insertion. Schedules are idle data until due and permission checks pass. Settings remain shared across agents, while prompts, conversations, screenshots, and requests are tied to their assigned tab/run.

The authenticated `/tasks` endpoint and CLI `task-schedule/list/cancel/resume` commands control the same TaskManager, not a second worker process. The server binds browser scope from the paired extension and never accepts a caller-supplied scope or approval response through this route.

## Scoped file downloads

`downloads-controller.js` checks tab access before every operation and tracks Chrome download IDs in session storage. It accepts HTTP(S) URLs, safe relative Downloads paths, or Chrome's Save As chooser; it never accepts dangerous-file warnings or opens files. Once Chrome returns an ID, later tracking errors return that ID with a warning rather than encourage duplicate transfers. CLI/MCP schemas mirror these fixed operations. When Every action approval mode is selected, workspace download approval shows the concrete URL and destination.

`local-downloads.mjs` is an explicit alternative for public links when a host cannot expose Chrome downloads. It streams without cookies, checks originating-tab permission during transfer, enforces a size/time bound, and publishes unique files without overwriting. Partial files are cleaned after errors/cancellation; persisted in-flight jobs become interrupted after restart. The configured folder is user-owned Settings data, never a model-supplied absolute path. The server requires an actually observed source link and archives only metadata, not file bytes. Native cancellation never invokes this alternative automatically.

## Verification

`npm test` runs deterministic tests for access isolation, stale refs, command validation, input dispatch, lifecycle, model adapters, MCP images, agent tool feedback, and limits. Chrome APIs or model responses are mocked where appropriate; those tests alone do not prove a live browser action.

`npm run verify:meta` is a separate paid live acceptance test. It uses real Meta calls, the extension, MCP, and the practice page. The practice server independently records submitted values and canvas activation. A passing run requires the exact requested form values, exactly one additional submission, a screenshot tool call, a pointer tool call, and server-confirmed visual completion. Artifacts are local and ignored by Git.

Live testing also verified direct controls, same-tab navigation/history, and open shadow controls. The embedded browser did not expose a usable native prompt in the dialog exercise; dialog event/response handling is tested with mocked Chrome events and is subject to the browser host. Universal website compatibility, CAPTCHA solving, native OS dialogs, and permission bypasses are not claimed.

Live workspace acceptance verified Meta `muse-spark-1.3` asking a missing-information question, receiving Express, requesting new-tab approval, running a separate research specialist, and collecting the observed two-business-day result without an order submission. The user confirmed audible alerts. The foreground-only embedded-host failure led to the narrow tab-creation fallback. Chrome native download attempts returned USER_CANCELED without a chooser in this host; no successful native-download claim is made.

The final acceptance runner scheduled a real task 60 seconds ahead. Its archived start was 513 ms after the deadline, its title observation was TabPilot Practice, and its completion tool input/result and final response were saved. A real MCP local download saved the 93-byte public practice report; independent filesystem comparison matched every byte and SHA-256. The ignored report is `.tabpilot/verification/workspace-live-report.json`. The running bridge remains paired; no additional reload is needed for these tested paths.

Default access is now opt-out. `tab-access.js` shares supported-URL checks and the missing-entry-means-allowed rule across the worker and UI. Explicit false flags block every Chrome operation; local revocation IDs preserve that decision over extension reload, close removes the ID, and browser startup resets it for the new tab session. Per-tab writes are serialized so concurrent Settings changes cannot lose revocations. Canceling Chrome debugging revokes access; deliberate detach/cleanup does not silently re-enable a tab. Settings lists all open web tabs and safely renders titles/URLs with Show and Revoke/Restore controls. Earlier live notes describing research access approval reflect the previous opt-in policy, superseded by this change.
