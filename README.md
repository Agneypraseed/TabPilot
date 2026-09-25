# TabPilot · Jev Browser Agent

TabPilot is a local Chrome side-panel extension that uses **Jev** for model decisions. It reads the active web page's visible text and accessible controls, asks Jev which available action best advances the task, then runs routine actions in sequence. It follows a new tab opened by an action and checks that page on the next decision.

Jev is a typed decision model.

## Setup

   Put your key in the local `.env` file:

   ```text
   AI_GATEWAY_API_KEY=your_key_here
   ```
   ```
   npm start
   ```

In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this project folder.
Open a regular website tab, click the TabPilot extension button, describe your task


## Current limits
- The agent can only choose controls it can read from the page DOM. It cannot see pixels, interpret images, or operate controls drawn only on a canvas.
