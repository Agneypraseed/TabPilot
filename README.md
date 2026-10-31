# TabPilot

A local browser-control toolkit that lets any tool-capable LLM agent inspect and operate explicitly enabled tabs in your existing Chrome browser.

Inspired by [agent-desktop](https://github.com/vercel-labs/agent-desktop), TabPilot follows an observe → act → verify loop. External agents supply the reasoning; TabPilot will expose browser observations and actions through CLI commands and MCP tools.

## First milestone

Build a minimal Chrome extension that lets the user enable or disable access to the current tab and clearly displays that tab's access state. Enabling a tab records permission for future TabPilot tools; browser automation comes in later milestones.

Acceptance checks:

- The extension loads through Chrome's **Load unpacked** option without errors.
- Tabs start with access disabled.
- The user can enable and disable access to the current tab.
- Switching between tabs displays each tab's own access state.
- Closing an enabled tab clears its access state.

## First end-to-end goal

An external agent searches a website, opens a result, and answers a question using information from that page. Demonstrate this workflow through both CLI and MCP.

Built-in models, an integrated chat assistant, desktop control, and additional browsers are outside the first version.

## Development approach

The project owner writes the implementation in small learning milestones, with planning, explanations, acceptance checks, and code review from Codex.

This branch starts with independent history. The previous implementation remains on `work`; `origin/main` is preserved for reference.
