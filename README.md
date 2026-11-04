# TabPilot

A local browser-control toolkit that lets any tool-capable LLM agent inspect and operate explicitly enabled tabs in your existing Chrome browser.

TabPilot connects an agent to your existing browser through a Chrome extension, a local CLI, and MCP tools. Give the included agent a task in the browser side panel, watch its activity, and steer or pause it as it works. Coding agents can use the same browser controls through CLI or MCP.

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

Click TabPilot's toolbar icon to open the agent UI. The **↗ layout chooser** offers **Open beside page in Chrome** or **Open separate workspace**. The latter uses a window, or a tab in browsers without extension windows. Open **Settings**, paste the displayed pairing token, and click **Connect**. Treat this token as a local credential. The bridge listens only on `127.0.0.1:4311`; its generated configuration stays in the ignored `.tabpilot` folder. Restarting the server creates a new token, so pair again afterward. Reloading the extension also requires reconnecting.

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

Only explicitly enabled tabs can be read or controlled. Access follows that tab through ordinary HTTP/HTTPS navigation. Disable access to detach the debugger and stop further operations. Closing a tab removes its access state. All new tabs, including ones opened by an agent, start disabled and require the user to enable them. Tab access controls work without the server.

The bridge serves one connected extension at a time and rejects overlapping work on the same tab. Leave it running while using the side panel, CLI, or MCP; reconnect through Settings if disconnected. Page data stays local until an agent/client chooses to send it to a model.

## Agent workspace

The toolbar popup offers quick access to the agent UI. Open a persistent workspace before longer tasks so you can watch, pause, and steer while interacting with pages. In Chrome with side-panel support, the extension's context menu also offers **Open side panel**. Embedded browsers may support only the popup and workspace tab.

Input actions show a clean arrow with smooth local animation and a small circular click ripple. The pointer lives in a noninteractive closed shadow root, stays out of page observations and screenshot-change detection, and hides before agent screenshots. It removes itself after inactivity. If visual rendering fails, browser actions continue without it. **Settings → Open Chrome side panel** opens the persistent side view in desktop Chrome. Codex's embedded browser currently lacks that native side-panel support.

Text entry is paced: short values appear character by character, while longer values use at most 24 chunks to keep tasks responsive. Typing stops if the original target loses focus or becomes unavailable, so input is not redirected into another field.

Add your provider key to ignored `.env.local` (see `.env.example`) and restart the bridge to load it. API keys stay on the local bridge. In Settings, choose the provider, model ID, and run limits, then save. The configured provider and model appear below the task composer. These panel preferences are stored in ignored `.tabpilot/agent-settings.json`; they do not change CLI flags or `.env.local`.

Select a web tab and enable access, then describe your task:

- **Browser agent** uses page controls and requests screenshots when useful.
- **Computer use** brings the selected tab into view and returns fresh screenshot observations to the model and panel after operations. Watch the real page alongside its activity trail; expand the latest observation for a closer look.
- Send another message while a task is running to steer the next action. Follow-up tasks retain conversation context for the same tab. **New chat** clears that context.
- **Pause** takes effect between operations; **Resume** continues. **Stop** cancels the run and prevents subsequent actions. Neither can undo an action already sent to Chrome. Disconnecting the extension also stops a panel run.

Each agent stays restricted to its assigned tab. Closing the panel does not stop the local runtime; reopening restores its current state. Live conversation context resets when the bridge restarts; saved History remains available. Screenshots sent in Computer use mode increase model usage and require a model that accepts images. CLI and MCP remain available independently; avoid directing external agents at a workspace task's tab at the same time.

## Tasks, schedules, and specialists

Open **Tasks** for the selected tab to see its queue, schedules, coordinator, and research specialists. **View agent** opens that agent's activity; older completed runs open their History. Switching tabs lets you inspect another task while work continues. The scheduler permits up to three active agents and one task at a time on each tab.

Expand **Schedule a task**, enter the instruction, choose a start time and optional repeat interval, then schedule it. A blank start time means now. Repeats are scheduled after successful completion, so unfinished tasks do not overlap with another occurrence. Disabled tabs wait for access; keep Chrome and the local bridge running. Tasks due while the bridge is off become eligible when it reconnects, without replaying missed repeat intervals.

An agent records completion only after reporting observed evidence. Turn limits save progress and continue in another stage. The stage limit bounds total continuation; exhausted tasks wait for review instead of being marked complete. **Review and resume** starts with a fresh page check. After a browser restart, **Use selected tab** explicitly rebinds unfinished work to the tab you choose. Interrupted actions are not automatically replayed. Schedules and progress stay local under ignored `.tabpilot/tasks.json`. You can also queue and inspect the same tasks through CLI:

```powershell
npm run cli -- task-schedule 123 "Read this page and report its title" 60
npm run cli -- task-list 123
npm run cli -- task-cancel TASK_UUID
```

The optional delay is in seconds. Scheduled tasks use the workspace model settings and can incur provider API usage; they remain visible in Tasks. External task controls cannot answer approval cards.

With research enabled, the coordinator can open a separate tab and request approval for a research specialist to access that exact page. New tabs remain disabled until you approve. Chrome opens research tabs in the background; hosts that require foreground tabs bring the new page into view. Specialists work independently in their assigned tabs; the coordinator waits for their actual findings before combining them. Waiting for a specialist spends no model tokens. **Stop** on a coordinator also stops its unfinished specialists; it cannot undo dispatched actions or close their tabs. Pause affects the selected agent. Research workers share the configured model and retain their own History.

## Downloads

Ask a workspace agent to download a linked file and give a relative Downloads destination, or ask to choose a location yourself. The approval card shows the URL and destination. **Save As** uses Chrome's native file chooser, where you select a location; the agent can wait for your help with that dialog. Existing files are kept by choosing a unique filename. The agent checks download status before reporting completion and cannot approve dangerous-download warnings or open downloaded files.

CLI and MCP expose the same scoped download controls:

```powershell
npm run cli -- download 123 https://example.com/report.pdf research/report.pdf
npm run cli -- download 123 https://example.com/report.pdf --save-as
npm run cli -- download-status 123 42
npm run cli -- download-cancel 123 42
```

In embedded browsers where Chrome's native chooser is unavailable, explicitly choose **local-bridge download** for a public file link. Set its absolute folder in **Settings > Local downloads** before starting the task. The default is this project's `.tabpilot/downloads` folder. It sends no browser cookies or sign-in credentials; authenticated downloads still need Chrome. Local transfers are limited to 25 MiB and two minutes, preserve existing files, and support progress/cancellation. The URL must be the current enabled page or a link observed on that page. A canceled native request never switches to this method automatically.

```powershell
npm run cli -- download-local 123 https://example.com/report.pdf research/report.pdf
npm run cli -- download-local-status 123 JOB_UUID
npm run cli -- download-local-cancel 123 JOB_UUID
```

Use the actual ID returned by the download command. Status and cancellation require access to the originating tab and a download created through TabPilot. A started transfer is not proof of completion; a tracking warning includes its ID so you can inspect it without starting another transfer. Workspace approval cards apply to the included workspace agent. External CLI/MCP clients control their own approval workflow.

## Approvals and requests for help

Workspace agents can pause with a request for approval, a missing detail, or a manual browser handoff. Respond in the attention card to continue the same task. CAPTCHA and login handoffs are performed by you in the browser; **Done, continue** tells the agent to inspect the page again, rather than perform the old action. **Decline** rejects the request, and **Stop** cancels the waiting run.

In Settings, choose **Important actions** or **Every action**. Important actions include recognized consequential button labels, Enter, coordinate clicks/drags, tab closing, and downloads. This is a practical action gate, not a universal classifier of website intent. The agent can ask for help whenever it cannot proceed. One approval permits one proposed action; it does not grant access to other tabs. Waiting for a reply pauses the active execution budget.

Optional sound alerts, toolbar badges, and desktop notifications draw attention to waiting tasks. Use **Test sound** in Settings. Desktop notifications and background sound depend on browser support and operating-system settings; the workspace attention card remains available in limited embedded browsers. Notifications use generic text rather than private task details. Requests and responses are saved in that tab's History.

## Tab history

Choose a browser tab, then open **History** beside **Agent**. It shows only that tab's recorded activity, newest first:

- Workspace tasks, guidance, pause/resume/stop events, final responses, and errors are grouped into runs with provider/model information.
- Tool requests and results have expandable details. Screenshots open on demand.
- Calls from terminals and other agents are included as labeled **CLI**, **MCP**, or **API** entries. External calls do not include an agent's private chat or task prompt.

History is stored locally under ignored `.tabpilot/history/`, including page observations and screenshots. Known configured credentials and the pairing token are redacted; typed text arguments are omitted, while normal field values can appear in resulting page snapshots. Password field values remain redacted. Files remain until you remove them. **New chat** clears the active conversation without deleting History, and viewing an old run never replays browser actions or sends its contents to a model.

History persists across bridge restarts and extension reloads for the same open tab. A fresh browser session uses a new history namespace so reused numeric tab IDs cannot mix unrelated tabs. Navigation within a tab keeps that tab's history. Recording starts when this feature is running; earlier work cannot be reconstructed retroactively.

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
- `browser_download`, `browser_download_status`, and `browser_download_cancel` use Chrome downloads. `browser_download_local`, `browser_download_local_status`, and `browser_download_local_cancel` explicitly save public page links through the local bridge into the configured folder.

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


For the scheduled-task and public local-download acceptance check, keep the paired practice tab enabled and run `node verification/live-workspace.mjs`. It schedules one real task one minute ahead, checks that no stage starts early, verifies completion and its archived tool result, and compares saved report bytes with the practice source. This uses the workspace model and can incur API usage; it writes a local verification report under `.tabpilot/verification/`.
