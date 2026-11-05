# TabPilot

TabPilot is a local-first browser agent for your existing Chrome tabs. Give it a task, watch its browser work, and stay in control of tab access and consequential actions.

## Project Description

TabPilot lets a tool-capable AI work inside your existing Chrome session. By default, the Chrome extension runs the agent itself and connects directly to your selected model provider. Enter your own API key in Settings, choose a tab, and start a task. No terminal, local server, or pairing token is required for normal use.

The agent reads page text and controls, navigates and interacts with websites, and uses screenshots and pointer actions when visual context helps. It stays scoped to its selected tab and asks for approval, missing information, or a browser handoff when needed. You can pause, resume, stop, or revoke tab access. Declining a request pauses its task and related specialists for review; it does not automatically retry the denied action or start another stage. Research specialists, scheduled tasks, download tracking, attention alerts, and per-tab history support longer workflows.

An optional developer server exposes the browser to external CLI and Model Context Protocol (MCP) clients and supports downloads to an absolute local folder. Extension and developer server modes keep separate settings and data. Supported providers include OpenAI, Meta, Gemini, Claude, and OpenAI-compatible APIs. Meta's Muse Spark model is `muse-spark-1.3`.

## Start with the extension

Use desktop Chrome 118 or newer. In `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this project folder. The checkout includes the bundled browser runtime; no Node.js process is required to use it.

1. Open TabPilot from the toolbar, then **Settings**.
2. Choose a provider and enter its model ID and your own API key. Compatible providers also need their API base URL.
3. Save settings, choose a web tab, and enter a task.

For Meta, choose **Meta** and model `muse-spark-1.3`. Keys for different providers stay separate. Leave credential fields blank to preserve saved values; use the removal controls to delete them. Settings are shared across all tabs and conversations. Saved keys stay masked with a Change control; saved notification destinations remain visible for checking. Starting a new chat does not clear settings.

Credentials last for the browser session by default. **Remember credentials on this device** saves them in extension-local storage, never Chrome sync. That storage is not an encrypted vault. Do not include a shared API key in a distributed extension. Browser execution, tasks, and history stay on your device; page context and screenshots used for inference go to your selected model provider.

Web tabs have access by default. Revoke individual tabs under **Settings → Tab access**. Browser-protected pages and the Chrome Web Store are unavailable. CAPTCHA challenges, logins, and native dialogs can require a user handoff.

Keep Chrome running for schedules. Closing the workspace does not stop a task, but browser exit or extension reload interrupts active work. Review interrupted work before resuming. Scheduled work cannot execute while Chrome is closed; missed schedules are checked when the extension next runs. After a browser restart, review saved tasks and bind them to their current tabs before resuming. Session-only credentials must be entered again.

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

Task checkpoints, History and images use the browser’s IndexedDB storage. Earlier Chrome-local records are copied safely on upgrade and retained as a backup. Storage failures preserve saved records and report a warning. Credentials remain in the selected Chrome session/local settings storage.

Alerts report pending requests and verified coordinator completion; repeating tasks notify for each successful occurrence. They contain task IDs and summaries or help questions. Notifications leave your device for Telegram or Resend. They do not include a screenshot or full task history, and cannot approve actions or resume a task. Respond in TabPilot.

Provider acceptance does not prove delivery. Sends time out after 10 seconds, do not block the agent, and are never retried automatically because an uncertain send may already have arrived. Failures appear in the Tasks summary without changing the task result. Alerts are best effort and are not replayed after a runtime restart.

The developer MCP server also offers `notifications_status` and `notifications_send`. The latter sends explicitly authorized updates only to recipients configured locally; external MCP clients must obtain authorization.

## Development

Run `npm test` for the automated suite. Run `npm run build:extension` after changing bundled runtime sources; commit the generated browser assets with the source change. The local practice page is available with `npm run practice`.
