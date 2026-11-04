# TabPilot side panel

The concept in `side-panel-concept.png` defines the extension's agent surface and Settings screen. The UI stays beside the real browser page; it is not a simulated browser.

Design tokens: white background; #151820 text; #697080 secondary text; #e3e6ef separators; #3459ee primary blue; #eef1ff selected surfaces; #13b54a connected indicator. System sans typography, 13px controls, 20px headings, 20px outer gutters, 10px control radius, 8px spacing unit. Outline tab mark and 1.7px line icons. No web fonts, external assets, or remote code.

Main view: brand and connection state, Settings button, selected tab and access control, Browser agent / Computer use mode switch, conversation with a slim activity trail, latest browser observation, Pause/Stop controls, sticky composer, configured provider and model. Empty state uses the same system, with task suggestions instead of fabricated activity. The model label is the configured request model; it does not claim to independently verify a provider's internal model identity.

Settings: pairing and disconnect, selected-tab access, provider/model, run limits, Save settings. Keys stay in the local bridge environment. Provider availability reflects configured credentials. Nonsecret preferences are saved locally by the bridge. Settings remain scrollable at narrow side-panel sizes.

Functional additions to the concept: new chat, accessible error/status messages, explicit pending-pause label, refreshable tab selector, and image expansion. These controls are needed for real task lifecycle and recovery. Task descriptions, tab names, activity, provider/model, screenshots, and connection states use actual runtime data.

Runtime: authenticated extension WebSocket carries task controls and recoverable state. CLI and MCP remain independent interfaces. Computer use focuses the selected tab and sends fresh viewport images to the model and panel after operations. Pause takes effect between operations; Stop prevents subsequent operations but cannot undo a browser action already sent. Steering received during a model response blocks that response's obsolete tool calls and is included before the next model request.

Compatibility: the Codex embedded browser rejects extension side panels. The default toolbar action therefore opens the same UI as a popup, with an explicit persistent-workspace launcher. Windows-capable Chrome opens a separate extension window; hosts without that capability open an extension tab. Source-window and selected-tab IDs are carried into the workspace so a separate window can still operate on the original browser tabs. A Chrome side panel remains optional through Chrome's extension context menu.
