# TabPilot · Jev Browser Agent

TabPilot is a local Chrome side-panel extension that uses **Jev only** for model decisions. It reads the active web page's visible text and accessible controls, asks Jev which available action best advances the task, then runs routine actions in sequence. It follows a new tab opened by an action and checks that page on the next decision.

Jev is a typed decision model. The extension does not use a vision model, chat model, or screenshot input. It can choose from controls the browser exposes in the page DOM; it cannot interpret images, canvas-only interfaces, or invent text to enter. To enter text, provide the exact string in the optional **Exact text to enter** field.

## What a run does

1. You enter a task and optionally exact text for a search or form field.
2. The extension reads the visible page text and up to 45 visible interactive controls. It does not separately read form values or passwords.
3. Jev classifies the page and chooses one bounded action from the current controls, scroll, keyboard, completion, or clarification options.
4. A second Jev decision checks whether the action matches the task and whether it may have a consequential effect. Routine, well-matched actions run automatically after you start the task. If task match is below 80%, or consequence risk reaches 20%, the extension pauses for your approval.
5. After each action it checks for a newly opened tab or a page navigation, then asks Jev to decide what to do next. Stop the run at any time. Each run is capped at 25 actions.

The extension uses Chrome's debugger protocol to click or move to a visible control, enter the exact text you supplied, scroll, and press Enter or Escape. It attaches only while executing one action and detaches afterward.

## Requirements

- Chrome 116 or newer
- Node.js 20 or newer
- A Vercel AI Gateway API key with access to `typesafe-ai/jev`

## Setup

1. Put your key in the ignored local `.env` file:

   ```text
   AI_GATEWAY_API_KEY=your_key_here
   ```

   `.env.example` is a blank template; do not put a real key there.

2. Start the local bridge from this folder:

   ```powershell
   npm start
   ```

3. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this project folder.
4. Open a regular website tab, click the TabPilot extension button, describe your task, then click **Start task**.
5. Keep the side panel open while it runs. Click **Stop task** to end the run.

The API key stays in `.env`; it is used only by the local Node bridge and never sent to the extension. The extension sends the task, visible page text, visible control labels, and optional exact text to Vercel AI Gateway for Jev decisions. It does not send screenshots or save page content to disk.

## Browser permission

The extension requests access to HTTP and HTTPS pages so it can inspect a newly opened page, plus Chrome's `debugger`, `tabs`, and `windows` permissions to send input and follow tabs. Chrome displays a warning for debugger and website access. TabPilot only reads pages while a task is running in the side panel.

## Current limits

- The agent can only choose controls it can read from the page DOM. It cannot see pixels, interpret images, or operate controls drawn only on a canvas.
- It does not generate form or search text. Supply the exact string in the optional text field.
- Chrome internal pages, the Chrome Web Store, and some protected pages may block inspection or input.
- Consequence checks are Jev probabilities; review paused actions carefully.

## Project files

- `manifest.json`, `background.js`: Chrome extension registration
- `sidepanel.html`, `sidepanel.css`, `sidepanel.js`: task controls, page reading, action execution, and tab-following loop
- `server.mjs`: local bridge for Jev's Vercel AI Gateway evaluation endpoint
- `.env.example`: blank local configuration template
