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

## Verify

```powershell
npm test
```

