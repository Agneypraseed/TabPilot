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
