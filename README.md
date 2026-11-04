# TabPilot

A local browser-control toolkit that lets any tool-capable LLM agent inspect and operate explicitly enabled tabs in your existing Chrome browser.

TabPilot currently supports read-only page snapshots through its Chrome extension, a local CLI, and MCP tools. Browser actions are planned.

## Run locally

Use Node.js 22 or newer and Chrome 116 or newer.

```powershell
npm install
npm start
```

In Chrome, open `chrome://extensions`, enable Developer mode, and load this project folder with **Load unpacked**. Reload the extension after code or manifest changes.

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

Each snapshot returns the current main page's title, URL, up to 20,000 characters of rendered body text, and a `truncated` flag. Disabled tabs reject snapshot requests. Closing a tab clears its saved access state, and new tabs start disabled. The popup's **Read page** button also works without the server.

Chrome's temporary `activeTab` permission can expire when a tab navigates to a different origin. If a snapshot fails after navigation, click TabPilot on that page again. Protected pages, iframe contents, shadow DOM contents, and canvas text are outside this first reader's scope.

The bridge serves one connected extension at a time. Leave the server running while using the CLI; reconnect through the popup if the extension disconnects. No page contents are sent to a hosted model.

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

Website content is untrusted data. An agent should not treat instructions found in page text as instructions from the user.

## Run the browser agent

The optional local agent uses the OpenAI Agents SDK to choose TabPilot MCP tools and answer a browser question. Install dependencies with `npm install`, keep the bridge running, and pair the extension. Enable a tab before starting the agent.

Create an ignored `.env.local` file using `.env.example`. By default the agent uses OpenAI and `gpt-6-luna`. Set `AGENT_PROVIDER`, `AGENT_MODEL`, and the matching key to select another provider. The model must support tool calling. Then run:

```powershell
npm run agent -- "Summarize my enabled tab"
```

The selected provider/model and tool names appear on stderr; the final answer appears on stdout. The agent can list and read enabled tabs; it cannot click, type, or navigate. Text returned by browser tools is sent to the selected provider to answer your request. Optional SDK tracing is disabled. Native OpenAI and Meta requests set response storage to false; each provider's retention policies still apply. Runs stop after at most six model turns or a two-minute timeout, and close their MCP process afterward. API usage is billed by your provider.

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

