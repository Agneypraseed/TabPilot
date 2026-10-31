# TabPilot worklog

## Goal and working agreement

- Build a local toolkit for agents to inspect and operate explicitly enabled Chrome tabs through CLI and MCP.
- User is learning and owns implementation decisions. Explain changes before implementation; modify code only when requested. Keep steps focused and review code together.
- Commit each completed task on `master`; do not push without authorization. Preserve existing work and local runtime files. Keep README about the product.
- Owner: assistant maintains this log and verification; user performs live extension acceptance checks.

## Completed

- `9d01bba`: popup with per-tab session access state and tab-close cleanup.
- `4fc1e5d`: permission-gated main-page snapshots with title, URL, capped rendered text, and truncation flag.
- `025d287`: local bridge and CLI implemented: one manually paired extension, loopback-only HTTP API, token authentication, WebSocket transport, enabled-tab listing, and fresh snapshots. Automated tests pass. Live enabled-tab reading also verified below.

## Decisions

- Permission is keyed by tab ID, not website. Closing a tab ends its recorded access.
- Reader uses `activeTab` plus `scripting`. Cross-origin navigation can revoke Chrome's temporary grant even while TabPilot's stored flag remains true; click the extension again to renew it.
- Pairing is explicit through the popup. The ignored `.tabpilot/bridge.json` holds the server's current token. Restarting the server rotates it; reload/disconnect requires manual reconnect.
- Only local CLI requests authenticated with the token are forwarded. HTTP browser origins and invalid Host headers are rejected; WebSocket requires an extension origin plus the token.
- No hosted model or API credentials are required. CLI snapshots return JSON for tool-capable agents. MCP and browser actions remain unimplemented.

## Validation and next actions

- `npm test`: five tests passed, covering unauthorized clients, routing, timeouts/disconnects, and real background-handler access enforcement over the transport with mocked Chrome APIs.
- JavaScript syntax and Git whitespace checks pass. Tests require loopback networking; this session's sandbox required escalation.
- Live verification: user paired the extension in the embedded browser and enabled Google. `node cli.mjs tabs` returned that enabled tab; `node cli.mjs snapshot 1004336041` returned Google's title, URL, rendered text, and `truncated: false` through the running server. No token or page content is stored in this log.
- Server is running in exec session 40357 with local networking enabled; sandboxed server/CLI connections were unreachable. Restarting rotates the token and requires pairing again.
- Remaining manual acceptance check: user disables the same tab, then assistant confirms its CLI snapshot is rejected. Automated rejection checks already pass.
- Browser automation cannot access `chrome://extensions/` due to tool policy; user handles reload and pairing.
- Next teaching step: explain `server.mjs`, `cli.mjs`, and the extension WebSocket flow in focused blocks before adding MCP.
