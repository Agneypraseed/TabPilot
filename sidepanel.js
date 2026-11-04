(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(globalThis.location?.search || "");
  document.documentElement.dataset.presentation = params.has("popup")
    ? "popup"
    : "workspace";
  const sourceWindow = params.get("window");
  const initialTab = Number(params.get("tab"));
  let initialTarget = true;
  let connected = false,
    agent = null,
    tabs = [],
    selected = null,
    mode = "browser";
  let settingsDirty = false,
    accessBusy = false,
    busy = false,
    screenshotData = "",
    rendered = "";
  const active = () =>
    ["running", "pausing", "paused", "stopping"].includes(agent?.status);
  const labels = {
    browser_tabs: "Finding your tab",
    browser_snapshot: "Reading the page",
    browser_click: "Clicking an element",
    browser_fill: "Typing into a field",
    browser_select: "Selecting an option",
    browser_press: "Pressing a key",
    browser_scroll: "Scrolling the page",
    browser_navigate: "Navigating",
    browser_back: "Going back",
    browser_forward: "Going forward",
    browser_reload: "Reloading",
    browser_focus: "Showing your tab",
    browser_open: "Opening a tab",
    browser_close: "Closing a tab",
    browser_wait: "Waiting for the page",
    browser_dialog: "Responding to a dialog",
    browser_screenshot: "Observing the browser",
    browser_pointer: "Moving the pointer",
  };
  const providerLabels = {
    openai: "OpenAI",
    meta: "Meta",
    gemini: "Gemini",
    claude: "Claude",
    "openai-compatible": "OpenAI compatible",
  };
  const defaults = { openai: "gpt-6-luna", meta: "muse-spark-1.3" };

  function notice(text, success = false) {
    $("notice").textContent = text;
    $("notice").className = success ? "success" : "";
    $("notice").hidden = !text;
  }
  async function request(type, params = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...params });
    if (response?.ok === false)
      throw new Error(response.error || "Request failed.");
    return response;
  }
  async function command(method, payload = {}) {
    const result = await request("tabpilot:agent", { method, payload });
    if (result.state) receive(result.state);
    return result;
  }
  function host(url) {
    try {
      return new URL(url).host;
    } catch {
      return "Browser tab";
    }
  }
  function showSettings(show) {
    $("settings-view").hidden = !show;
    $("agent-view").hidden = show;
    $("back").hidden = !show;
    document.body.classList.toggle("settings-open", show);
    if (show) {
      fillSettings();
      $("settings-view").scrollTop = 0;
    }
  }
  function fillSettings() {
    if (!agent?.settings || settingsDirty) return;
    const s = agent.settings;
    $("provider").value = s.provider;
    $("model").value = s.model;
    $("max-turns").value = s.maxTurns;
    if (
      ![...$("timeout").options].some(
        (option) => Number(option.value) === s.timeoutMs,
      )
    ) {
      const option = document.createElement("option");
      option.value = s.timeoutMs;
      option.textContent = `${s.timeoutMs / 1000} seconds`;
      $("timeout").append(option);
    }
    $("timeout").value = String(s.timeoutMs);
    providerHelp();
  }
  function providerHelp() {
    const configured = agent?.providers?.find(
      (p) => p.id === $("provider").value,
    )?.configured;
    $("provider-help").textContent = configured
      ? "API keys stay on your local bridge."
      : "Add this provider’s API key to .env.local and restart the bridge.";
  }
  async function refreshTabs(preferActive = false) {
    const [available, stored] = await Promise.all([
      chrome.tabs.query(
        sourceWindow && /^\d+$/.test(sourceWindow)
          ? { windowId: Number(sourceWindow) }
          : { currentWindow: true },
      ),
      chrome.storage.session.get(null),
    ]);
    tabs = available.filter((tab) => /^https?:\/\//.test(tab.url || ""));
    const oldId = selected?.id;
    const desired = active()
      ? agent.tabId
      : preferActive
        ? (initialTarget && initialTab) || available.find((t) => t.active)?.id
        : oldId;
    initialTarget = false;
    selected =
      tabs.find((t) => t.id === desired) ??
      tabs.find((t) => t.id === oldId) ??
      tabs.find((t) => t.active) ??
      tabs[0] ??
      null;
    tabs = tabs.map((tab) => ({
      ...tab,
      enabled: stored[`tab:${tab.id}`] === true,
    }));
    selected = tabs.find((tab) => tab.id === selected?.id) ?? null;
    $("target-tab").replaceChildren();
    if (!tabs.length) {
      const option = document.createElement("option");
      option.textContent = "Open a web page";
      $("target-tab").append(option);
    }
    for (const tab of tabs) {
      const option = document.createElement("option");
      option.value = String(tab.id);
      option.textContent = tab.title || host(tab.url);
      $("target-tab").append(option);
    }
    if (selected) $("target-tab").value = String(selected.id);
    renderControls();
  }
  function renderControls() {
    $("connection").classList.toggle("connected", connected);
    $("connection-label").textContent = connected
      ? "Connected"
      : "Disconnected";
    $("settings-connection").textContent = connected
      ? "Connected to your local bridge."
      : "Start your local bridge with npm start.";
    $("disconnect").hidden = !connected;
    $("pair-form").hidden = connected;
    $("target-tab").disabled = active() || !tabs.length;
    $("target-domain").textContent = selected
      ? host(selected.url)
      : "Choose a browser tab";
    $("settings-tab-name").textContent = selected?.title || "No tab selected";
    $("settings-tab-domain").textContent = selected ? host(selected.url) : "";
    for (const id of ["access-toggle", "settings-access"]) {
      $(id).setAttribute("aria-checked", String(Boolean(selected?.enabled)));
      $(id).disabled = !selected || accessBusy;
    }
    $("access-label").replaceChildren(
      "Access",
      document.createElement("br"),
      selected?.enabled ? "enabled" : "disabled",
    );
    $("settings-access").setAttribute(
      "aria-label",
      selected?.enabled ? "Disable selected tab" : "Enable selected tab",
    );
    $("mode-browser").setAttribute("aria-pressed", String(mode === "browser"));
    $("mode-computer").setAttribute(
      "aria-pressed",
      String(mode === "computer"),
    );
    $("mode-browser").disabled = $("mode-computer").disabled = active();
    $("run-controls").hidden = !active();
    $("run-status").textContent =
      {
        running: "Working…",
        pausing: "Pausing after this operation…",
        paused: "Paused · you have control",
        stopping: "Stopping…",
      }[agent?.status] || "";
    $("pause").textContent = ["paused", "pausing"].includes(agent?.status)
      ? "▶ Resume"
      : "Ⅱ Pause";
    $("pause").disabled = agent?.status === "stopping";
    $("stop").disabled = agent?.status === "stopping";
    $("new-chat").disabled = active();
    $("send").disabled =
      busy ||
      !connected ||
      !agent ||
      !selected?.enabled ||
      agent?.status === "stopping";
    $("send").setAttribute(
      "aria-label",
      active() ? "Send guidance" : "Send task",
    );
    $("task").placeholder = active()
      ? "Guide your agent…"
      : "What should I do next?";
    $("composer-hint").textContent = !connected
      ? "Connect the local bridge in Settings to start."
      : !agent
        ? "Restart the bridge to enable the agent interface."
        : !selected?.enabled
          ? "Enable access on this tab to start."
          : active()
            ? "New guidance applies before the next action. Enter to send."
            : mode === "computer"
              ? "Watch it work in your tab. Pause any time."
              : "Only tabs you enable are shared.";
    $("save-settings").disabled = !connected || !agent || active();
    if (agent?.settings) {
      $("model-label").replaceChildren(
        `${providerLabels[agent.settings.provider]} · ${agent.settings.model}`,
        Object.assign(document.createElement("span"), { textContent: "⌄" }),
      );
    } else $("model-label").textContent = "Connect your local bridge ⌄";
  }
  function renderMessages() {
    const events = agent?.events || [];
    const signature = events.map((e) => e.id).join();
    if (signature !== rendered) {
      const main = $("conversation");
      const atEnd =
        main.scrollHeight - main.scrollTop - main.clientHeight < 100;
      $("messages").replaceChildren();
      const runningTools = new Map();
      for (const event of events) {
        if (event.kind === "tool") {
          if (event.phase !== "running" && runningTools.has(event.tool)) {
            runningTools.get(event.tool).className = `activity ${event.phase}`;
            runningTools.delete(event.tool);
            continue;
          }
          const row = document.createElement("div");
          row.className = `activity ${event.phase}`;
          row.textContent =
            labels[event.tool] || event.tool.replace(/^browser_/, "");
          const time = document.createElement("span");
          time.className = "time";
          time.textContent = new Date(event.time).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          row.append(time);
          $("messages").append(row);
          if (event.phase === "running") runningTools.set(event.tool, row);
        } else {
          const row = document.createElement("div");
          row.className = `message ${event.kind}`;
          row.textContent = event.text;
          $("messages").append(row);
        }
      }
      rendered = signature;
      $("empty-state").hidden = Boolean(events.length);
      if (atEnd || events.at(-1)?.kind === "user")
        main.scrollTop = main.scrollHeight;
    }
    const shot = agent?.screenshot;
    const next =
      shot && /^image\/(jpeg|png)$/.test(shot.mimeType)
        ? `data:${shot.mimeType};base64,${shot.data}`
        : "";
    if (next !== screenshotData) {
      screenshotData = next;
      $("observation").hidden = !next;
      $("screenshot").src = next;
      $("observation-time").textContent = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }
  function receive(state) {
    if (agent && state.revision < agent.revision) return;
    agent = state;
    if (active()) mode = state.mode;
    fillSettings();
    renderControls();
    renderMessages();
  }
  async function sync() {
    const state = await request("tabpilot:ui-state");
    connected = Boolean(state.connected);
    if (state.agent) receive(state.agent);
    else {
      agent = null;
      renderControls();
    }
  }
  async function toggleAccess() {
    if (!selected || accessBusy) return;
    accessBusy = true;
    renderControls();
    try {
      const response = await request("tabpilot:access", {
        tabId: selected.id,
        enabled: !selected.enabled,
      });
      selected.enabled = response.enabled;
      notice("");
    } catch (error) {
      notice(error.message);
    } finally {
      accessBusy = false;
      renderControls();
    }
  }
  $("settings-button").addEventListener("click", () =>
    showSettings($("settings-view").hidden),
  );
  $("open-workspace").addEventListener("click", async () => {
    try {
      const query = new URLSearchParams();
      if (selected?.windowId !== undefined)
        query.set("window", String(selected.windowId));
      if (selected?.id !== undefined) query.set("tab", String(selected.id));
      const url = chrome.runtime.getURL(`sidepanel.html?${query}`);
      try {
        if (!chrome.windows?.create) throw new Error("Window UI unavailable");
        await chrome.windows.create({
          url,
          type: "popup",
          width: 440,
          height: 880,
        });
      } catch {
        await chrome.tabs.create({ url, active: true });
      }
    } catch (error) {
      notice(error.message);
    }
  });
  $("model-label").addEventListener("click", () => showSettings(true));
  $("back").addEventListener("click", () => showSettings(false));
  $("refresh-tabs").addEventListener("click", () =>
    refreshTabs().catch((e) => notice(e.message)),
  );
  $("target-tab").addEventListener("change", () => {
    selected = tabs.find((t) => t.id === Number($("target-tab").value));
    renderControls();
  });
  for (const id of ["access-toggle", "settings-access"])
    $(id).addEventListener("click", toggleAccess);
  for (const value of ["browser", "computer"])
    $("mode-" + value).addEventListener("click", () => {
      mode = value;
      renderControls();
    });
  $("pair-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("connect").disabled = true;
    try {
      await request("tabpilot:connect", {
        token: $("pair-token").value.trim(),
      });
      $("pair-token").value = "";
      await sync();
      // Ask explicitly too: compatible older bridges have no unsolicited state.
      await command("state");
      notice("Bridge connected.", true);
    } catch (error) {
      notice(error.message);
    } finally {
      $("connect").disabled = false;
    }
  });
  $("disconnect").addEventListener("click", async () => {
    try {
      await request("tabpilot:disconnect");
      connected = false;
      agent = null;
      renderControls();
      notice("Bridge disconnected. Any active run is stopping.");
    } catch (error) {
      notice(error.message);
    }
  });
  $("settings-form").addEventListener("input", () => {
    settingsDirty = true;
  });
  $("provider").addEventListener("change", () => {
    settingsDirty = true;
    $("model").value = defaults[$("provider").value] || "";
    providerHelp();
  });
  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await command("settings", {
        provider: $("provider").value,
        model: $("model").value.trim(),
        maxTurns: Number($("max-turns").value),
        timeoutMs: Number($("timeout").value),
      });
      settingsDirty = false;
      fillSettings();
      notice("Settings saved for the next run.", true);
    } catch (error) {
      notice(error.message);
    }
  });
  $("task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = $("task").value.trim();
    if (!prompt || busy || $("send").disabled) return;
    busy = true;
    renderControls();
    try {
      notice("");
      if (active())
        await command("steer", { runId: agent.runId, text: prompt });
      else await command("start", { prompt, tabId: selected.id, mode });
      $("task").value = "";
      $("task").focus();
    } catch (error) {
      notice(error.message);
    } finally {
      busy = false;
      renderControls();
    }
  });
  $("task").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("task-form").requestSubmit();
    }
  });
  for (const button of document.querySelectorAll("[data-prompt]"))
    button.addEventListener("click", () => {
      $("task").value = button.dataset.prompt;
      $("task").focus();
    });
  $("pause").addEventListener("click", async () => {
    try {
      await command(
        ["paused", "pausing"].includes(agent.status) ? "resume" : "pause",
        { runId: agent.runId },
      );
    } catch (error) {
      notice(error.message);
    }
  });
  $("stop").addEventListener("click", async () => {
    try {
      await command("stop", { runId: agent.runId });
    } catch (error) {
      notice(error.message);
    }
  });
  $("new-chat").addEventListener("click", async () => {
    try {
      await command("clear");
      notice("");
      $("task").focus();
    } catch (error) {
      notice(error.message);
    }
  });
  $("expand-image").addEventListener("click", () => {
    $("large-screenshot").src = screenshotData;
    $("image-dialog").showModal();
  });
  $("close-image").addEventListener("click", () => $("image-dialog").close());
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "tabpilot:agent-event") {
      connected = true;
      receive(message.state);
    }
  });
  chrome.tabs.onActivated.addListener(() =>
    refreshTabs(!active()).catch((e) => notice(e.message)),
  );
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if (change.status === "complete" || change.title)
      refreshTabs().catch(() => {});
  });
  chrome.tabs.onRemoved.addListener(() => refreshTabs().catch(() => {}));
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "session") refreshTabs().catch(() => {});
  });
  // Recover state if the panel was closed/reopened; the run lives in Node.
  const poll = setInterval(
    () =>
      sync().catch(() => {
        connected = false;
        renderControls();
      }),
    2000,
  );
  window.addEventListener("unload", () => clearInterval(poll));
  Promise.all([sync(), refreshTabs(true)]).catch((error) =>
    notice(error.message),
  );
})();
