# TabPilot

TabPilot is a local-first browser agent for your existing Chrome tabs. Give an AI agent a task, watch its browser work, and stay in control of access and important actions.

## Project Description

TabPilot lets a tool-capable AI work inside a user's existing Chrome session. A Chrome extension exposes browser tools through an authenticated local Node.js bridge. The included agent runs in a browser workspace; the same tools are available to other clients through a command-line interface and Model Context Protocol (MCP).

The agent can inspect page text and controls, navigate and interact with websites, and use screenshots and pointer actions when a task depends on visual content. It checks browser results as it works, stays scoped to the selected tab, and can ask for approval, missing information, or a handoff to the user. People can pause, resume, or stop a run and revoke a tab's access. Scheduled tasks, research specialists in separate tabs, download tracking, attention alerts, and durable per-tab history support longer workflows.

TabPilot keeps browser execution, pairing, schedules, and history on the local machine. Page content and screenshots go to the selected model only when needed for the requested task. The project supports multiple model providers and uses Meta's Muse Spark (`muse-spark-1.3`) through the Meta Model API. The model interprets requests, chooses browser tools, adapts to observed results, handles follow-up input, and reports verified outcomes. TabPilot connects natural-language intent to observable, user-controlled browser actions.

## Highlights

- **Two ways to work:** a DOM-oriented Browser agent and screenshot-driven Computer use.
- **Human control:** tab-by-tab access revocation, action approvals, requests for help, and pause, resume, and stop controls.
- **Long-running tasks:** schedules, a coordinator with parallel research specialists, download tracking, and per-tab activity history.
- **Flexible integrations:** the included agent, CLI, and MCP tools use the same local browser bridge; the agent supports Meta, OpenAI, Gemini, Claude, and compatible APIs.

## Run locally

Requirements: Node.js 22 or newer and Chrome 118 or newer.

```powershell
npm ci
npm start
```

In Chrome, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked** to select this project folder. In another terminal, pair the extension with the local bridge:

```powershell
npm run cli -- pair
```

Click TabPilot's toolbar icon, open **Settings**, paste the pairing token, and connect. The bridge listens on `127.0.0.1:4311`; its pairing file is stored in the ignored `.tabpilot` folder. Restarting the bridge creates a new token. Web tabs are accessible by default; revoke individual tabs in **Settings → Tab access** whenever needed.

Add a provider key to the ignored `.env.local` file using `.env.example`. To use Meta's Muse Spark model:

```dotenv
AGENT_PROVIDER=meta
AGENT_MODEL=muse-spark-1.3
META_API_KEY=your-key
```

Then open a web tab and start a task:

```powershell
npm run agent -- --provider meta --model muse-spark-1.3 "Summarize the page and verify the result"
```

The provider and model can also be selected in the workspace. API keys stay on the local bridge; page context selected for inference is sent to the chosen provider.

## CLI and MCP

The CLI can list accessible tabs and inspect or control a tab:

```powershell
npm run cli -- tabs
npm run cli -- snapshot <tab-id>
npm run cli -- help
```

For an MCP client, launch `mcp.mjs` with Node.js from this checkout. MCP clients use the same authenticated local bridge; no token belongs in client configuration. External clients are responsible for their own approval workflow.

## Data and limits

TabPilot stores pairing configuration, schedules, and per-tab history locally. Page text and screenshots may be sent to the configured model when an agent uses them. Browser-protected pages and the Chrome Web Store are unavailable. CAPTCHA challenges, login prompts, native dialogs, and browser security warnings may need you to take over. Always review consequential browser actions.

## Development

Run the automated test suite with `npm test`. The local practice page is available with `npm run practice`.
