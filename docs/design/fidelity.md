# Side-panel design verification

Reference: `side-panel-concept.png`, generated with the built-in Image Gen tool. The prompt describes both the full chat/control screen and Settings, with a white/blue system and real code-native controls. Native concept board is 1262×1246; each panel is approximately 590×1216. Browser checks use the equivalent narrow product proportions at 400×820 and the compact breakpoint at 320×640.

Comparison ledger (built-in browser screenshot API, then local `view_image` inspection):

| Point | Concept | Implemented / decision |
| --- | --- | --- |
| Palette | White, near-black type, cobalt accent, cool separators | Same tokens; no gradient or tinted background |
| Brand/header | Outline tab mark, stacked connection state, gear | Matched; added New chat for conversation lifecycle |
| Target and modes | Tab selector, enable switch, two-part mode control | Matched; refresh action added; redundant access text hides at 320px |
| Conversation | User bubble, open assistant text, vertical checked activity | Matched; real task/tool text replaces illustrative copy |
| Composer | Bottom anchored prompt, blue send, model caption | Matched; run controls appear only during an active run |
| Settings | Divided sections, labeled fields, access toggle, limits | Matched; scrollable for narrow/short panels; pairing form hides while connected, with Disconnect to pair again |
| Typography | Sans, compact UI, clear weight hierarchy | System sans with explicit control sizes; no browser-default control fonts |
| Images | Latest browser screenshot under result | Real runtime image only; no invented Google result thumbnail |
| Responsive | Narrow persistent browser companion | No horizontal overflow at 320px; composer stays visible, conversation/settings scroll |

Copy audit: primary controls retain Browser agent, Computer use, Settings, Connection, Tab access, Model, Provider, Run limits, Max turns, Timeout, Save settings. Task/model/tab/result text is dynamic. Functional additions (New chat, refresh, status/errors, pause-pending copy) and the empty-state heading/suggestions are documented in `side-panel.md`. The reference's fabricated search result and generic assistant promise are intentionally not seeded into real chats. Live screenshot and control verification remains distinct from fixture preview checks.

Host compatibility correction: the user's live Codex browser reported that extension side panels are unsupported. The toolbar now uses the same UI as a 400×600 popup, with a persistent-workspace button. It opens an extension window where supported and otherwise an extension tab. The workspace is at most 480px wide; Chrome's optional side panel still uses the same source. This is a required host adaptation, not a separate visual system. Popup Settings and conversation areas scroll independently.

Live acceptance: the user opened the actual extension workspace, selected Meta/muse-spark-1.3, and confirmed the Computer use task, activity trail, and screenshot display worked. An independent bridge snapshot and practice backend check verified all requested form values without an order submission for that visitor. Browser tools reject chrome-extension://, so direct tool-driven workspace inspection was unavailable; local HTTP preview screenshots supplied layout verification, and the user operated the live extension. No claim of automated extension-page UI coverage is made. The implementation follows the concept's visual system with the host adaptations above; no material visual mismatch remained in the inspected popup/workspace previews.

Follow-up usability change: the workspace arrow now opens a layout chooser rather than silently creating a tab, and Settings provides an explicit native Chrome side-panel action. Both explain the embedded-host limitation. This is a focused control change within the existing design system. Pointer feedback was subsequently changed from debugger highlight shapes to a normal dark SVG arrow and a small blue circular ripple, animated locally in an isolated, noninteractive closed shadow root. Decoration mutations are excluded from screenshot targeting; real page mutations remain tracked.

History extends the same UI system with Agent/History navigation, a tab-specific run list and expandable trace details. Browser fixture checks at400×820 and320×640 verified readable run labels, model/source/status metadata, safe text output, scrollable JSON, back navigation, and no horizontal overflow. A visual check found the timestamp and speaker label touching; speaker labels now start on their own line. The fixture preview proves layout only; live trace persistence and isolation are separately tested through authenticated HTTP/WebSocket transport and disk round trips.

Live History acceptance: the user confirmed the new workspace run, tool details, and final response appeared. Independent saved-file checks confirmed the Meta task and complete request/result trace. Real CLI and MCP calls were labeled separately in the same tab, and the archived CLI screenshot matched its original bytes. No direct automated interaction with the chrome-extension:// UI is claimed because browser policy blocks that surface.
