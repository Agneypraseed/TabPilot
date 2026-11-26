# TabPilot

TabPilot is a local-first browser agent for your existing Chrome tabs. Give it a task, watch its browser work, and stay in control of tab access and consequential actions.

## Project Description

TabPilot lets a tool-capable AI work inside your existing Chrome session. By default, the Chrome extension runs the agent itself and connects directly to your selected model provider. Enter your own API key in Settings, choose a tab, and start a task. No terminal, local server, or pairing token is required for normal use.

The agent reads page text and controls, navigates and interacts with websites, and uses screenshots and pointer actions when visual context helps. It stays scoped to its selected tab and asks for approval, missing information, or a browser handoff when needed. You can pause, resume, stop, or revoke tab access. Declining a request pauses its task and related specialists for review; it does not automatically retry the denied action or start another stage. Research specialists, scheduled tasks, download tracking, attention alerts, and per-tab history support longer workflows.

An optional developer server exposes the browser to external CLI and Model Context Protocol (MCP) clients and supports downloads to an absolute local folder. Extension and developer server modes keep separate settings and data. Supported providers include OpenAI, Meta, Gemini, Claude, and OpenAI-compatible APIs. 

## Start with the extension

Use desktop Chrome 118 or newer. In `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this project folder. The checkout includes the bundled browser runtime; no Node.js process is required to use it.

1. Open TabPilot from the toolbar, then **Settings**.
2. Choose a provider and enter its model ID and your own API key. Compatible providers also need their API base URL.
3. Save settings, choose a web tab, and enter a task.

Choose **Settings → Appearance** to switch between white Light, light Green, black Dark, and System. System follows your device’s light or dark appearance. Your choice saves immediately on this device, updates open panels, and stays across tabs, new chats, and browser restarts.

Web tabs have access by default. Revoke individual tabs under **Settings → Tab access**. Browser-protected pages and the Chrome Web Store are unavailable. CAPTCHA challenges, logins, and native dialogs can require a user handoff.

Keep Chrome running for schedules. Closing the workspace leaves tasks running. After a browser restart, review saved schedules and choose their tabs. Rebinding a future schedule keeps its start time and repeat interval. For a missed start, choose **Run now** or **Skip missed run**. Skipping a recurring task schedules its next interval. If TabPilot could not save a repeat after a verified completion, **Retry scheduling** in Tasks saves the next occurrence while preserving the completed result. Session-only credentials must be entered again after browser exit.

The **Agent** chat shows coordinator and specialist progress and keeps the final reply. Each panel follows its selected tab and run. Scheduled jobs start with independent context. Open **History** or use **View trace** in **Tasks** for verification details.

After a restart or lost connection, **Review and resume** in Tasks opens **History → Review before continuing**. Check the last recorded step, choose an enabled tab, and add any updated instructions before continuing. The new run requires a fresh page snapshot before browser actions. In **Settings → Advanced settings**, you can set separate stage and task limits. The task limits cover all stages and specialists, and repeated stages without new browser evidence pause for review.

## Optional developer server, CLI, and MCP

Open **Settings → Developer settings**, select **Local developer server**, and apply the mode. This is for external CLI/MCP integrations or explicit downloads to a local filesystem folder. Normal extension use does not need it.

Install Node.js 22 or newer, then run:

```powershell
npm ci
npm start
```

In another terminal:

```powershell
npm run cli -- pair
```

Paste the token into the pairing field under Developer settings and connect. Only the server needs to stay running; the pairing command displays a token and exits. The server listens on `127.0.0.1:4311`. Restarting it generates a new pairing token.

The server reads its own provider credentials from ignored `.env.local`; use `.env.example` for setting names. Extension credentials are not copied to the server. Switching modes keeps their tasks, history, and settings separate. Return to **In this extension (default)** for normal use.

```powershell
npm run cli -- tabs
npm run cli -- snapshot <tab-id>
npm run cli -- help
npm run agent -- --provider meta --model muse-spark-1.3 "Summarize this page"
```

For an external MCP client, launch `mcp.mjs` with Node.js from this checkout. The MCP process uses the authenticated local bridge; do not put the pairing token in the client's configuration. External clients manage their own approvals.

## Telegram and email alerts

Configure either channel under **Settings → Telegram and email alerts** in extension mode. Developer server mode instead reads the following settings from `.env.local`; restart the server after changing that file.

Telegram needs a bot token from [@BotFather](https://t.me/BotFather) and a numeric chat ID. Send `/start` to your bot first. Obtain the chat ID locally using [getUpdates](https://core.telegram.org/bots/api#getupdates); its URL contains your secret bot token, so keep it out of chat, screenshots, and logs.

Email uses [Resend](https://resend.com), with an API key, allowed sender, and recipient. For testing, `onboarding@resend.dev` can send to your Resend account's own email address. Other recipients need a verified sending domain.

```dotenv
TELEGRAM_BOT_TOKEN=
TABPILOT_TELEGRAM_CHAT_ID=
RESEND_API_KEY=
TABPILOT_EMAIL_FROM=
TABPILOT_EMAIL_TO=
```

Use **Settings → Telegram → Send test alert** to check the saved destination without a model call. Pending question cards show whether each provider accepted or rejected its alert; acceptance still requires checking the receiving app.

Task checkpoints, History and images use the browser’s IndexedDB storage. Earlier Chrome-local records are copied safely on upgrade and retained as a backup until deleted. Open a finished run in **History → Runs** and choose **Delete run** to delete its saved events and screenshots. To delete older finished runs automatically for this browser profile and execution mode, choose a retention period in **Settings → Advanced settings**. Credentials remain in the selected Chrome session/local settings storage.

Permission alerts describe the proposed action and its context, including the page and available details such as recipient, subject, or amount. TabPilot verifies that the reviewed action still matches the page when it is about to execute. If relevant details changed, review the new action. TabPilot asks you to handle consequential actions in the browser when it cannot determine the exact target or effect. Full message bodies and task prompts are not copied automatically.

Alerts report pending requests and verified coordinator completion; repeating tasks notify for each successful occurrence. They contain task summaries or help questions and relevant approval details. Notifications leave your device for Telegram or Resend. They do not include a screenshot or full task history.

In a private chat with your bot, an approval alert that offers a reply accepts **OK** to approve or **Deny** to pause. Use Telegram's Reply action on that specific alert while the request is still pending. Keep Chrome and the TabPilot runtime running. Use a dedicated bot: TabPilot reads replies with [getUpdates](https://core.telegram.org/bots/api#getupdates), which cannot run alongside a webhook or reliably share an update queue with another poller. Group, channel, and email alerts, information requests, and browser handoffs still use the controls in TabPilot.

The agent can send keyboard input to an enabled browser tab. For a game, ask it to focus the game and tap or briefly hold a key, for example “hold ArrowRight for 500 ms, then take a screenshot.” Each hold is capped at two seconds. This works for games that respond to ordinary browser keyboard events; the agent acts one tool call at a time, so it is better suited to deliberate movement than fast reactions.

Delegated research runs keep their own browser history. While the task is active, open **Research specialists** in the parent chat for live progress. In **History**, open the coordinator run or use the specialist links beneath it to review the specialist traces in the same place.

Provider acceptance does not prove delivery. Sends time out after 10 seconds, do not block the agent, and are never retried automatically because an uncertain send may already have arrived. Failures appear in the Tasks summary without changing the task result. Alerts are best effort and are not replayed after a runtime restart.

The developer MCP server also offers `notifications_status` and `notifications_send`. The latter sends explicitly authorized updates only to recipients configured locally; external MCP clients must obtain authorization.

## Development

Run `npm test` for the automated suite. Run `npm run build:extension` after changing bundled runtime sources; commit the generated browser assets with the source change. The local practice page is available with `npm run practice`.
