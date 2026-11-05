(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(globalThis.location?.search || "");
  document.documentElement.dataset.presentation = params.has("popup")
    ? "popup"
    : "workspace";
  const sourceWindow = params.get("window");
  let contextWindowId = sourceWindow && /^\d+$/.test(sourceWindow)
    ? Number(sourceWindow)
    : null;
  let incognitoWindow = chrome.extension?.inIncognitoContext === true;
  let contextWindowPromise;
  const initialTab = Number(params.get("tab"));
  let initialTarget = true;
  let connected = false,
    agent = null,
    tabs = [],
    selected = null;
  // Retain the existing wire value for saved tasks and older bridges.
  const mode = "browser";
  let executionMode = "extension";
  let executionModeDirty = false;
  let runtimeSettings = { configuredFields: [] };
  const credentialEdits = new Set();
  let settingsDirty = false,
    accessBusy = false,
    busy = false,
    screenshotData = "",
    rendered = "";
  let workspaceView = "agent",
    historyRun = null,
    historyTab = null,
    historyNext = null,
    historyBusy = false,
    historyReload = false,
    historyRevision = -1;
  const active = () =>
    ["running", "pausing", "paused", "needs-input", "waiting-for-worker", "stopping"].includes(
      agent?.status,
    );
  const attentionCards = new Map();
  const taskView = globalThis.TabPilotTaskView ? new globalThis.TabPilotTaskView({ document, command,
    selected: () => selected, notice, mode: () => mode,
    viewAgent: async job => {
      selected = tabs.find(tab => tab.id === job.tabId) || selected;
      if (!selected || selected.id !== job.tabId) throw new Error("This tab is no longer open. Review and resume on a selected tab instead.");
      $("target-tab").value = String(selected.id);
      await command("select-tab", { tabId: selected.id });
      if (agent.taskId !== job.id && job.runId) {
        showWorkspaceView("history");
        historyRun = { runId: job.runId, task: job.prompt, status: job.status, startedAt: job.createdAt };
        historyNext = null;
        await refreshHistory();
        return;
      }
      showWorkspaceView("agent");
    }
  }) : null;
  function renderAttention(requests = []) {
    const ids = new Set(requests.map((request) => request.id));
    for (const [id, card] of attentionCards)
      if (!ids.has(id)) {
        card.remove();
        attentionCards.delete(id);
      }
    for (const pending of requests) {
      if (attentionCards.has(pending.id)) { renderAlertDelivery(attentionCards.get(pending.id), pending); continue; }
      const card = document.createElement("article");
      card.className = "attention-card";
      const title = document.createElement("h3");
      title.textContent =
        pending.kind === "approval"
          ? "Approve an action"
          : pending.kind === "handoff"
            ? "Your help is needed"
            : "The agent has a question";
      const question = document.createElement("p");
      question.textContent = pending.question;
      const detail = document.createElement("p");
      detail.className = "help";
      detail.textContent = pending.detail || "";
      const tabLabel = document.createElement("small");
      tabLabel.textContent = tabs.find(tab => tab.id === pending.tabId)?.title || `Tab ${pending.tabId}`;
      card.append(tabLabel, title, question, detail);
      const delivery = document.createElement("p");
      delivery.className = "help alert-delivery";
      delivery.setAttribute("role", "status");
      card.append(delivery);
      renderAlertDelivery(card, pending);
      let input;
      if (pending.kind === "information") {
        input = document.createElement("textarea");
        input.maxLength = 12000;
        input.placeholder = "Your reply";
        input.setAttribute("aria-label", "Reply to agent");
        card.append(input);
      }
      const actions = document.createElement("div");
      actions.className = "attention-actions";
      const decisions =
        pending.kind === "approval"
          ? [
              ["approve", "Approve once"],
              ["deny", "Decline"],
            ]
          : pending.kind === "handoff"
            ? [
                ["done", "Done, continue"],
                ["deny", "Cannot continue"],
              ]
            : [
                ["answer", "Send reply"],
                ["deny", "Decline"],
              ];
      for (const [decision, label] of decisions) {
        const button = document.createElement("button");
        button.textContent = label;
        if (decision !== "deny") button.className = "primary";
        button.addEventListener("click", async () => {
          const buttons = [...actions.querySelectorAll("button")];
          for (const item of buttons) item.disabled = true;
          try {
            await command("human-response", {
              id: pending.id,
              runId: pending.runId,
              decision,
              ...(input ? { text: input.value } : {}),
            });
            notice("");
          } catch (error) {
            notice(error.message);
          } finally {
            for (const item of buttons) item.disabled = false;
          }
        });
        actions.append(button);
      }
      card.append(actions);
      $("attention-requests").append(card);
      attentionCards.set(pending.id, card);
    }
    $("attention-requests").hidden = !requests.length;
  }
  function renderAlertDelivery(card, request) {
    const element = card.querySelector(".alert-delivery");
    if (!element) return;
    const delivery = agent?.notificationDeliveries?.find(item => item.requestId === request.id);
    const status = runtimeSettings.notificationStatus?.telegram;
    const lines = (delivery?.results || []).map(item => {
      const name = item.channel === "telegram" ? "Telegram" : "Email";
      return item.status === "sending" ? `${name}: sending alert…`
        : item.accepted ? `${name} accepted the alert. Reply here in TabPilot.`
        : `${name} alert failed: ${item.error || "Check the channel settings."}`;
    });
    if (!lines.length && status?.invalid) lines.push("Telegram alert was not sent: the saved bot token or chat ID has an invalid format. Check Settings.");
    element.textContent = lines.join(" ");
    element.hidden = !lines.length;
  }
  const labels = {
    request_user_help: "Asking for your help",
    delegate_research: "Starting a research specialist",
    collect_worker_result: "Collecting specialist findings",
    complete_task: "Recording verified completion",
    browser_download: "Starting a download",
    browser_download_status: "Checking download progress",
    browser_download_cancel: "Canceling a download",
    browser_download_local: "Saving a public file locally",
    browser_download_local_status: "Checking local download progress",
    browser_download_local_cancel: "Canceling a local download",
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
  const providerKeys = { openai: "OPENAI_API_KEY", meta: "META_API_KEY", gemini: "GOOGLE_GENERATIVE_AI_API_KEY", claude: "ANTHROPIC_API_KEY", "openai-compatible": "COMPATIBLE_API_KEY" };
  const credentialInputs = { "telegram-token": "TELEGRAM_BOT_TOKEN", "telegram-chat": "TABPILOT_TELEGRAM_CHAT_ID", "resend-key": "RESEND_API_KEY", "email-from": "TABPILOT_EMAIL_FROM", "email-to": "TABPILOT_EMAIL_TO" };
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
  function renderReply(element, text) {
    if (globalThis.TabPilotMarkdown) TabPilotMarkdown.render(element, text);
    else element.textContent = text || "";
  }
  function showSettings(show) {
    $("settings-view").hidden = !show;
    $("agent-view").hidden = show;
    $("back").hidden = !show;
    document.body.classList.toggle("settings-open", show);
    if (show) {
      fillSettings();
      void refreshRuntimeSettings().catch(error => notice(error.message));
      $("settings-view").scrollTop = 0;
    }
  }
  function showWorkspaceView(view) {
    workspaceView = view;
    $("history-view").hidden = view !== "history";
    $("tasks-view").hidden = view !== "tasks";
    for (const id of ["conversation", "composer-area"])
      $(id).hidden = view !== "agent";
    $("agent-tab").setAttribute("aria-pressed", String(view === "agent"));
    $("history-tab").setAttribute("aria-pressed", String(view === "history"));
    $("tasks-tab").setAttribute("aria-pressed", String(view === "tasks"));
    if (view === "tasks") taskView?.render(agent, connected);
    if (view === "history") {
      if (historyTab !== selected?.id) resetHistory();
      refreshHistory();
    }
  }
  function resetHistory() {
    historyTab = selected?.id;
    historyRun = null;
    historyNext = null;
    $("history-content").replaceChildren();
    $("history-more").hidden = true;
    $("history-back").hidden = true;
  }
  function historyTime(time) {
    return new Date(time).toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  function historyRunRow(run) {
    const button = document.createElement("button");
    button.className = "history-run";
    const title = document.createElement("strong");
    title.textContent = run.task || "Browser activity";
    const meta = document.createElement("small");
    meta.textContent = `${historyTime(run.startedAt)} · ${run.source === "workspace" ? "Workspace" : (run.source || "API").toUpperCase()}${run.model ? ` · ${run.model}` : ""}`;
    const status = document.createElement("span");
    status.className = "history-badge";
    status.textContent = run.status;
    button.append(title, meta, status);
    button.addEventListener("click", () => {
      historyRun = run;
      historyNext = null;
      $("history-content").replaceChildren();
      refreshHistory();
    });
    return button;
  }
  function historyEventRow(event, tabId, runId) {
    const row = document.createElement("section");
    row.className = `history-event ${event.phase === "error" || event.kind === "error" ? "error" : ""}`;
    const time = document.createElement("small");
    time.textContent = historyTime(event.time);
    row.append(time);
    if (event.kind === "tool") {
      const details = document.createElement("details"),
        summary = document.createElement("summary"),
        pre = document.createElement("pre");
      summary.textContent = `${labels[event.tool] || labels[`browser_${event.tool}`] || event.tool} · ${event.phase || "complete"}`;
      pre.textContent = JSON.stringify(
        event.arguments !== undefined
          ? { arguments: event.arguments }
          : { result: event.result },
        null,
        2,
      );
      details.append(summary, pre);
      row.append(details);
    } else {
      const label = document.createElement("strong");
      label.textContent =
        {
          user: "You",
          assistant: "Agent",
          attention: "Needs attention",
          status: "Status",
          error: "Error",
        }[event.kind] || "Activity";
      const text = document.createElement(event.kind === "assistant" ? "div" : "p");
      if (event.kind === "assistant") renderReply(text, event.text);
      else text.textContent = event.text || "";
      row.append(label, text);
      if (event.detail) {
        const detail = document.createElement("p");
        detail.className = "help";
        detail.textContent = event.detail;
        row.append(detail);
      }
    }
    const images = new Map();
    function collect(value) {
      if (!value || typeof value !== "object") return;
      if (value.artifactId && value.mimeType?.startsWith("image/"))
        images.set(value.artifactId, value);
      for (const item of Object.values(value))
        if (item && typeof item === "object") collect(item);
    }
    collect(event);
    for (const artifact of images.values()) {
      const button = document.createElement("button");
      button.textContent = "View screenshot";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const response = await command("history-image", {
            tabId,
            runId,
            artifactId: artifact.artifactId,
          });
          if (selected?.id !== tabId || historyRun?.runId !== runId) return;
          const image = response.history;
          $("large-screenshot").src =
            `data:${image.mimeType};base64,${image.data}`;
          $("image-dialog").showModal();
        } catch (error) {
          notice(error.message);
        } finally {
          button.disabled = false;
        }
      });
      row.append(button);
    }
    return row;
  }
  async function refreshHistory(append = false) {
    $("history-tab-label").textContent = selected?.title || "Choose a tab";
    if (!connected || !selected || !agent?.historyAvailable) {
      $("history-status").textContent = !connected
        ? executionMode === "bridge" ? "Connect the developer server to view its History." : "Starting extension History…"
        : !selected
          ? "Choose a browser tab."
          : "History is not available from this runtime.";
      return;
    }
    if (historyBusy) {
      historyReload = true;
      return;
    }
    historyBusy = true;
    $("history-more").disabled = true;
    const tabId = selected.id,
      runId = historyRun?.runId;
    const offset = append ? historyNext : 0;
    $("history-status").textContent = "Loading history…";
    try {
      const response = await command(
        runId ? "history-events" : "history-list",
        { tabId, ...(runId ? { runId } : {}), offset: offset || 0 },
      );
      if (
        selected?.id !== tabId ||
        historyRun?.runId !== runId ||
        workspaceView !== "history"
      )
        return;
      const data = response.history;
      if (runId && data.run) historyRun = data.run;
      if (!append) $("history-content").replaceChildren();
      $("history-back").hidden = !runId;
      const records = runId ? data.events : data.runs;
      for (const record of records)
        $("history-content").append(
          runId ? historyEventRow(record, tabId, runId) : historyRunRow(record),
        );
      historyNext = data.nextOffset;
      $("history-more").hidden = historyNext === null;
      $("history-status").textContent =
        agent.historyWarning ||
        (runId
          ? `${historyRun.task} · ${historyRun.status}`
          : records.length || append
            ? "Runs for this tab, newest first."
            : "No activity recorded for this tab yet.");
    } catch (error) {
      if (selected?.id === tabId)
        $("history-status").textContent = error.message;
    } finally {
      historyBusy = false;
      $("history-more").disabled = false;
      if (historyReload) {
        historyReload = false;
        if (workspaceView === "history") refreshHistory();
      }
    }
  }
  function fillSettings() {
    if (!agent?.settings || settingsDirty) return;
    const s = agent.settings;
    $("provider").value = s.provider;
    $("model").value = s.model;
    $("max-turns").value = s.maxTurns;
    $("approval-mode").value = s.approvalMode || "important";
    $("sound-alerts").checked = s.soundAlerts !== false;
    $("download-directory").value = s.downloadDirectory || "";
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
  function acceptRuntime(value) {
    if (!value) return;
    runtimeSettings = { ...runtimeSettings, ...value };
    if (["extension", "bridge"].includes(value.executionMode)) executionMode = value.executionMode;
    if (!executionModeDirty) $("execution-mode").value = executionMode;
    if (!settingsDirty) {
      $("remember-credentials").checked = runtimeSettings.rememberCredentials === true;
      $("compatible-base-url").value = runtimeSettings.compatibleBaseUrl || "";
    }
    renderRuntimeSettings();
  }
  async function refreshRuntimeSettings() {
    const result = await command("runtime-settings");
    acceptRuntime(result.runtime || result.state?.runtime);
  }
  function renderRuntimeSettings() {
    const local = executionMode === "extension";
    $("extension-credentials").hidden = !local;
    $("notification-settings").hidden = !local;
    $("test-telegram").disabled = !connected || !local;
    $("check-telegram").disabled = !connected || !local;
    $("credential-storage").hidden = !local;
    $("developer-bridge").hidden = local;
    $("apply-execution-mode").disabled = active();
    const fields = runtimeSettings.configuredFields || [];
    $("settings-storage-scope").textContent = executionMode === "bridge"
      ? "The developer server keeps its own settings. Starting a new chat does not reset them."
      : runtimeSettings.rememberCredentials
        ? "Saved on this device, including after restarting Chrome. New chats and switching tabs keep these settings."
        : "Saved for this browser session. New chats and switching tabs keep these settings. Enable Remember credentials below to keep them after restarting Chrome.";
    for (const [id, name] of Object.entries(credentialInputs)) renderSavedCredential(id, fields.includes(name), runtimeSettings.savedValues?.[name]);
    $("telegram-status").textContent = runtimeSettings.notificationStatus?.telegram?.invalid ? "Saved Telegram settings have an invalid format. Use the raw bot token and a numeric chat ID, then send a test alert." : ["TELEGRAM_BOT_TOKEN", "TABPILOT_TELEGRAM_CHAT_ID"].every(name => fields.includes(name))
      ? "Telegram settings saved. The bot must have received /start from this chat."
      : "Add a bot token and chat ID. Send /start to your bot first.";
    $("email-status").textContent = ["RESEND_API_KEY", "TABPILOT_EMAIL_FROM", "TABPILOT_EMAIL_TO"].every(name => fields.includes(name))
      ? "Email settings saved. Your sender must be allowed by Resend."
      : "Add a Resend key, sender and recipient. Test senders can only email your Resend account address.";
    providerHelp();
  }
  function providerHelp() {
    const provider = $("provider").value;
    const configured = (runtimeSettings.configuredFields || []).includes(providerKeys[provider]) || agent?.providers?.find(p => p.id === provider)?.configured;
    $("compatible-endpoint").hidden = provider !== "openai-compatible";
    renderSavedCredential("provider-key", configured);
    $("provider-key").placeholder = configured ? "Key saved · leave blank to keep it" : "Enter your API key";
    $("provider-help").textContent = executionMode === "bridge"
      ? configured ? "This provider’s key is configured on the developer server." : "Add this provider’s key to the server’s .env.local and restart that server."
      : configured ? "API key saved for all tabs and conversations. Use Change to replace it." : "Enter your own provider API key above, then save settings. No local server is needed.";
  }
  function renderSavedCredential(id, configured, displayValue) {
    const saved = configured && !credentialEdits.has(id);
    $(id).hidden = saved;
    $(id + "-saved").hidden = !saved;
    $(id + "-saved-value").textContent = displayValue || "••••••••  Saved";
  }
  for (const id of ["provider-key", ...Object.keys(credentialInputs)]) {
    $(id + "-change").addEventListener("click", () => {
      credentialEdits.add(id);
      renderSavedCredential(id, true);
      $(id).placeholder = "Enter replacement, or leave blank to keep saved value";
      $(id).focus();
    });
  }
  function clearCredentialInputs() {
    credentialEdits.clear();
    $("provider-key").value = "";
    for (const id of Object.keys(credentialInputs)) $(id).value = "";
    for (const id of ["clear-provider-key", "clear-telegram", "clear-email"]) $(id).checked = false;
  }
  async function resolveContextWindow() {
    return contextWindowPromise ??= (async () => {
      try {
        const current = Number.isInteger(contextWindowId)
          ? await chrome.windows?.get?.(contextWindowId)
          : await chrome.windows?.getCurrent?.();
        if (Number.isInteger(current?.id)) contextWindowId = current.id;
        incognitoWindow ||= current?.incognito === true;
      } catch {}
      return contextWindowId;
    })();
  }
  async function refreshTabs(preferActive = false, activeTabId) {
    const activeQuery = Number.isInteger(contextWindowId)
      ? { active: true, windowId: contextWindowId }
      : { active: true, currentWindow: true };
    const [available, stored, current] = await Promise.all([
      chrome.tabs.query({}),
      TabPilotTabAccess.read(chrome),
      preferActive && activeTabId === undefined ? chrome.tabs.query(activeQuery) : [],
    ]);
    incognitoWindow ||= available.some(tab => tab.windowId === contextWindowId && tab.incognito === true);
    tabs = available.filter((tab) => TabPilotTabAccess.supported(tab.url) &&
      (!incognitoWindow || (Number.isInteger(contextWindowId) && tab.windowId === contextWindowId)));
    $("tab-access-help").textContent = incognitoWindow
      ? "Only web tabs in this incognito window are shown. Revoke access for any tab below."
      : "All web tabs have access by default. Revoke access for any tab below. Chrome-protected pages are unavailable.";
    $("settings-tab-list").setAttribute("aria-label", incognitoWindow ? "Access for this incognito window" : "Access for all open web tabs");
    const oldId = selected?.id;
    const oldTab = tabs.find((tab) => tab.id === oldId);
    const contextTabs = Number.isInteger(contextWindowId)
      ? tabs.filter((tab) => tab.windowId === contextWindowId)
      : tabs;
    const desired = active() && !agent?.jobs
      ? agent.tabId
      : preferActive
        ? (initialTarget && initialTab) || activeTabId || current.find(t => TabPilotTabAccess.supported(t.url))?.id || contextTabs.find((t) => t.active)?.id
        : oldId;
    initialTarget = false;
    selected =
      tabs.find((t) => t.id === desired) ??
      (preferActive && Number.isInteger(contextWindowId) && oldTab?.windowId !== contextWindowId ? null : oldTab) ??
      contextTabs.find((t) => t.active) ??
      contextTabs[0] ??
      (!preferActive && !Number.isInteger(contextWindowId) ? tabs.find((t) => t.active) ?? tabs[0] : null) ??
      null;
    tabs = tabs.map((tab) => ({
      ...tab,
      enabled: TabPilotTabAccess.enabled(stored, tab.id),
    }));
    selected = tabs.find((tab) => tab.id === selected?.id) ?? null;
    $("target-tab").replaceChildren();
    if (!tabs.length || (preferActive && Number.isInteger(contextWindowId) && !selected)) {
      const option = document.createElement("option");
      option.textContent = tabs.length ? "Choose a web tab" : "Open a web page";
      option.value = "";
      option.disabled = true;
      option.selected = true;
      $("target-tab").append(option);
    }
    for (const tab of tabs) {
      const option = document.createElement("option");
      option.value = String(tab.id);
      option.textContent = `${tab.title || "Web tab"} · ${host(tab.url)}`;
      $("target-tab").append(option);
    }
    if (selected) $("target-tab").value = String(selected.id);
    renderControls();
    if (connected && agent?.jobs && selected && agent.selectedTabId !== selected.id)
      await command("select-tab", { tabId: selected.id });
    if (workspaceView === "history" && historyTab !== selected?.id) {
      resetHistory();
      refreshHistory();
    }
  }
  function renderControls() {
    $("connection").classList.toggle("connected", connected);
    $("connection-label").textContent = connected
      ? executionMode === "extension" ? "In browser" : "Server connected"
      : executionMode === "extension" ? "Starting…" : "Server offline";
    $("settings-connection").textContent = executionMode === "extension"
      ? "The agent runs in this extension. No server connection is needed."
      : connected ? "Connected to your local developer server." : "Start your local server with npm start, then pair it below.";
    $("disconnect").hidden = executionMode !== "bridge" || !connected;
    $("pair-form").hidden = executionMode !== "bridge" || connected;
    renderRuntimeSettings();
    $("target-tab").disabled = (active() && !agent?.jobs) || !tabs.length;
    $("target-domain").textContent = selected
      ? host(selected.url)
      : "Choose a browser tab";
    for (const id of ["access-toggle"]) {
      $(id).setAttribute("aria-checked", String(Boolean(selected?.enabled)));
      $(id).disabled = !selected || accessBusy;
    }
    $("access-label").replaceChildren(
      "Access",
      document.createElement("br"),
      selected?.enabled ? "enabled" : "disabled",
    );
    renderTabAccess();
    $("run-controls").hidden = !active();
    $("run-status").textContent =
      {
        running: "Working…",
        pausing: "Pausing after this operation…",
        paused: "Paused · you have control",
        "needs-input": "Waiting for your reply",
        "waiting-for-worker": "Specialists are working…",
        stopping: "Stopping…",
      }[agent?.status] || "";
    $("pause").textContent = ["paused", "pausing"].includes(agent?.status)
      ? "▶ Resume"
      : "Ⅱ Pause";
    $("pause").disabled = ["stopping", "needs-input", "waiting-for-worker"].includes(agent?.status);
    $("stop").disabled = agent?.status === "stopping";
    $("new-chat").disabled = active();
    $("send").disabled =
      busy ||
      !connected ||
      !agent ||
      !selected?.enabled ||
      ["stopping", "needs-input"].includes(agent?.status);
    $("send").setAttribute(
      "aria-label",
      active() ? "Send guidance" : "Send task",
    );
    $("task").placeholder = active()
      ? "Guide your agent…"
      : "What should I do next?";
    $("composer-hint").textContent = !connected
      ? executionMode === "bridge" ? "Connect the developer server in Settings to start." : "Starting the extension agent…"
      : !agent
        ? "Open Settings to configure the agent."
        : !agent.providers?.find(provider => provider.id === agent.settings?.provider)?.configured
          ? "Add your provider API key in Settings to start."
        : !selected?.enabled
          ? "Enable access on this tab to start."
          : agent?.status === "needs-input"
            ? "Answer the request above to continue."
            : active()
              ? "New guidance applies before the next action. Enter to send."
              : "The agent chooses page and visual tools as needed. Pause any time.";
    $("save-settings").disabled = !connected || !agent || active();
    if (agent?.settings) {
      $("model-label").replaceChildren(
        `${providerLabels[agent.settings.provider]} · ${agent.settings.model}`,
        Object.assign(document.createElement("span"), { textContent: "⌄" }),
      );
    } else $("model-label").textContent = executionMode === "bridge" ? "Connect developer server ⌄" : "Choose your model ⌄";
    taskView?.render(agent, connected);
  }
  let tabAccessSignature = "";
  function renderTabAccess() {
    const signature = JSON.stringify(tabs.map(tab => [tab.id, tab.title, tab.url, tab.enabled, tab.active]));
    if (signature === tabAccessSignature) return;
    tabAccessSignature = signature;
    const list = $("settings-tab-list");
    list.replaceChildren();
    if (!tabs.length) { list.textContent = "No open web tabs."; return; }
    for (const tab of tabs) {
      const row = document.createElement("div"); row.className = "tab-access-row";
      const text = document.createElement("div"); text.className = "tab-access-title";
      const title = document.createElement("strong"); title.textContent = tab.title || host(tab.url);
      const url = document.createElement("span"); url.textContent = tab.url;
      text.append(title, url);
      const show = document.createElement("button"); show.textContent = "Show"; show.type = "button";
      show.addEventListener("click", async () => {
        try { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows?.update(tab.windowId, { focused: true }); }
        catch (error) { notice(error.message); }
      });
      const toggle = document.createElement("button"); toggle.type = "button";
      toggle.textContent = tab.enabled ? "Revoke" : "Restore";
      toggle.setAttribute("aria-label", `${tab.enabled ? "Revoke" : "Restore"} access: ${tab.title || host(tab.url)}`);
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          const response = await request("tabpilot:access", { tabId: tab.id, enabled: !tab.enabled });
          tab.enabled = response.enabled;
          await refreshTabs();
        } catch (error) { notice(error.message); }
        finally { toggle.disabled = false; }
      });
      row.append(text, show, toggle); list.append(row);
    }
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
          if (event.kind === "assistant") renderReply(row, event.text);
          else row.textContent = event.text;
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
    if (
      agent &&
      state.sessionId === agent.sessionId &&
      state.revision < agent.revision
    )
      return;
    agent = state;
    if (state.executionMode) executionMode = state.executionMode;
    acceptRuntime(state.runtime);
    fillSettings();
    renderControls();
    renderMessages();
    renderAttention(state.requests);
    if (state.historyRevision !== historyRevision) {
      historyRevision = state.historyRevision;
      if (workspaceView === "history") refreshHistory();
    }
  }
  async function sync() {
    const state = await request("tabpilot:ui-state");
    connected = Boolean(state.connected);
    if(state.error) notice(state.error);
    if (state.executionMode) executionMode = state.executionMode;
    acceptRuntime(state.runtime);
    if (state.agent) receive(state.agent);
    else {
      agent = null;
      renderAttention([]);
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
    $("layout-menu").hidden = !$("layout-menu").hidden;
  });
  $("open-window").addEventListener("click", async () => {
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
          ...(incognitoWindow ? { incognito: true } : {}),
        });
      } catch {
        query.set("layout", "tab");
        await chrome.tabs.create({
          url: chrome.runtime.getURL(`sidepanel.html?${query}`),
          active: true,
          ...(incognitoWindow && Number.isInteger(contextWindowId) ? { windowId: contextWindowId } : {}),
        });
      }
    } catch (error) {
      notice(error.message);
    }
  });
  async function openSidePanel() {
    try {
      if (!chrome.sidePanel?.open || selected?.windowId === undefined)
        throw new Error(
          "This browser cannot open Chrome side panels. Use desktop Chrome to keep TabPilot beside the page.",
        );
      await chrome.sidePanel.open({ windowId: selected.windowId });
      notice(
        "Side panel requested. If your browser reports it is unsupported, use TabPilot in desktop Chrome.",
        true,
      );
    } catch (error) {
      notice(error.message);
    }
  }
  $("open-side-panel").addEventListener("click", openSidePanel);
  $("open-side-panel-top").addEventListener("click", openSidePanel);
  $("model-label").addEventListener("click", () => showSettings(true));
  $("back").addEventListener("click", () => showSettings(false));
  $("refresh-tabs").addEventListener("click", () =>
    refreshTabs().catch((e) => notice(e.message)),
  );
  $("target-tab").addEventListener("change", async () => {
    selected = tabs.find((t) => t.id === Number($("target-tab").value));
    if (connected && agent?.jobs && selected) {
      try { await command("select-tab", { tabId: selected.id }); }
      catch (error) { notice(error.message); }
    }
    renderControls();
    if (workspaceView === "history") {
      resetHistory();
      refreshHistory();
    }
  });
  for (const id of ["access-toggle"])
    $(id).addEventListener("click", toggleAccess);
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
      renderAttention([]);
      renderControls();
      notice("Bridge disconnected. Any active run is stopping.");
    } catch (error) {
      notice(error.message);
    }
  });
  $("execution-mode").addEventListener("change", () => { executionModeDirty = true; });
  $("apply-execution-mode").addEventListener("click", async () => {
    $("apply-execution-mode").disabled = true;
    try {
      const next = $("execution-mode").value;
      const result = await command("runtime-configure", { executionMode: next });
      executionMode = next;
      executionModeDirty = false;
      settingsDirty = false;
      clearCredentialInputs();
      acceptRuntime(result.runtime || result.state?.runtime || { executionMode: next });
      await sync();
      await refreshRuntimeSettings();
      notice(next === "extension" ? "The agent now runs in this extension." : "Developer server mode selected. Start and pair your local server below.", true);
    } catch (error) { notice(error.message); }
    finally { renderControls(); }
  });
  $("settings-form").addEventListener("input", () => {
    settingsDirty = true;
  });
  $("download-directory").addEventListener("input", () => { settingsDirty = true; });
  $("provider").addEventListener("change", () => {
    settingsDirty = true;
    $("model").value = defaults[$("provider").value] || "";
    $("provider-key").value = "";
    credentialEdits.delete("provider-key");
    $("clear-provider-key").checked = false;
    providerHelp();
  });
  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      if (executionMode === "extension") {
        const credentials = {};
        const key = $("provider-key").value.trim();
        if (key) credentials[providerKeys[$("provider").value]] = key;
        for (const [id, name] of Object.entries(credentialInputs)) {
          const value = $(id).value.trim();
          if (value) credentials[name] = value;
        }
        if ($("provider").value === "openai-compatible") {
          const address = $("compatible-base-url").value.trim();
          if (!address) throw new Error("Enter the compatible provider’s HTTPS API base URL.");
          const endpoint = new URL(address);
          if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
            throw new Error("Use an HTTPS API base URL without credentials, a query, or a fragment. Local HTTP providers need developer server mode.");
          const granted = await chrome.permissions.request({ origins: [endpoint.origin + "/*"] });
          if (!granted) throw new Error("Allow access to this provider’s API host before saving it.");
          credentials.COMPATIBLE_BASE_URL = address;
        }
        const clearCredentials = [];
        if ($("clear-provider-key").checked) clearCredentials.push(providerKeys[$("provider").value]);
        if ($("clear-telegram").checked) clearCredentials.push("TELEGRAM_BOT_TOKEN", "TABPILOT_TELEGRAM_CHAT_ID");
        if ($("clear-email").checked) clearCredentials.push("RESEND_API_KEY", "TABPILOT_EMAIL_FROM", "TABPILOT_EMAIL_TO");
        const result = await command("runtime-configure", { credentials, clearCredentials, rememberCredentials: $("remember-credentials").checked });
        clearCredentialInputs();
        acceptRuntime(result.runtime || result.state?.runtime);
      }
      await command("settings", {
        provider: $("provider").value,
        model: $("model").value.trim(),
        maxTurns: Number($("max-turns").value),
        timeoutMs: Number($("timeout").value),
        approvalMode: $("approval-mode").value,
        soundAlerts: $("sound-alerts").checked,
        ...(executionMode === "bridge" && $("download-directory").value.trim() ? { downloadDirectory: $("download-directory").value.trim() } : {}),
      });
      settingsDirty = false;
      fillSettings();
      notice("Settings saved for all tabs and conversations.", true);
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
      await globalThis.tabPilotAttentionTone?.({ unlockOnly: true });
      notice("");
      if (active())
        await command("steer", { runId: agent.runId, text: prompt });
      else
        await command("start", {
          prompt,
          tabId: selected.id,
          mode,
          tabTitle: selected.title,
        });
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
  $("check-telegram").addEventListener("click", async () => {
    $("check-telegram").disabled = true;
    try {
      if(chrome.permissions?.request && !await chrome.permissions.request({origins:["https://api.telegram.org/*"]}))throw new Error("Telegram access was not granted. No alert was sent.");
      notice("Checking Telegram connection without sending an alert…");
      const {check} = await command("notification-check");
      notice(check.ok ? check.message : check.error, check.ok);
    } catch(error){notice(error.message);}
    finally{$("check-telegram").disabled=false;}
  });
  $("test-telegram").addEventListener("click", async () => {
    $("test-telegram").disabled = true;
    try {
      if(chrome.permissions?.request) {
        const granted = await chrome.permissions.request({origins:["https://api.telegram.org/*"]});
        if(!granted)throw new Error("Telegram access was not granted. No test message was sent.");
      }
      const result = await command("notification-test", { channel: "telegram" });
      const accepted = result.notification?.accepted === true;
      notice(accepted ? "Telegram accepted the test alert. Check the saved chat or channel." : result.notification?.results?.[0]?.error || result.notification?.error || "The Telegram test failed. Check Settings.", accepted);
    } catch (error) { notice(error.message); }
    finally { $("test-telegram").disabled = false; }
  });
  $("test-alert").addEventListener("click", async () => {
    try {
      await globalThis.tabPilotAttentionTone?.({ unlockOnly: true });
      const response = await request("tabpilot:test-alert");
      const played =
        response.played || (await globalThis.tabPilotAttentionTone?.());
      notice(
        played
          ? "Attention sound played."
          : "Audio is unavailable in this browser. Waiting tasks still appear in the workspace.",
        !!played,
      );
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
  $("agent-tab").addEventListener("click", () => showWorkspaceView("agent"));
  $("tasks-tab").addEventListener("click", () => showWorkspaceView("tasks"));
  $("history-tab").addEventListener("click", () =>
    showWorkspaceView("history"),
  );
  $("refresh-history").addEventListener("click", () => refreshHistory());
  $("history-more").addEventListener("click", () => refreshHistory(true));
  $("history-back").addEventListener("click", () => {
    historyRun = null;
    historyNext = null;
    refreshHistory();
  });
  $("expand-image").addEventListener("click", () => {
    $("large-screenshot").src = screenshotData;
    $("image-dialog").showModal();
  });
  $("close-image").addEventListener("click", () => $("image-dialog").close());
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "tabpilot:attention-alert") {
      if (!message.played && agent?.settings.soundAlerts !== false)
        void globalThis.tabPilotAttentionTone?.();
      return;
    }
    if (message.type === "tabpilot:history-event") {
      if (agent) agent.historyRevision = message.revision;
      historyRevision = message.revision;
      if (workspaceView === "history") refreshHistory();
      return;
    }
    if (message.type === "tabpilot:agent-event") {
      connected = true;
      receive(message.state);
    }
  });
  chrome.tabs.onActivated.addListener((info) => {
    void (async () => {
      await resolveContextWindow();
      if (Number.isInteger(contextWindowId) && info?.windowId !== contextWindowId) return;
      if (!Number.isInteger(contextWindowId)) {
        const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (current?.windowId !== info?.windowId) return;
      }
      await refreshTabs(agent?.jobs ? true : !active(), info?.tabId);
    })().catch((error) => notice(error.message));
  });
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if (change.status === "complete" || change.title)
      refreshTabs().catch(() => {});
  });
  chrome.tabs.onRemoved.addListener(() => refreshTabs().catch(() => {}));
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "session" || (area === "local" && _changes.tabAccessRevocations)) refreshTabs().catch(() => {});
  });
  // Recover state when reopening the workspace; the selected runtime owns the run.
  const poll = setInterval(
    () =>
      sync().catch(() => {
        connected = false;
        renderControls();
      }),
    2000,
  );
  window.addEventListener("unload", () => clearInterval(poll));
  if (params.get("layout") === "tab")
    notice(
      "This browser opened a workspace tab. Desktop Chrome also supports keeping TabPilot beside the page.",
    );
  (async () => {
    await resolveContextWindow();
    await Promise.all([sync(), refreshTabs(true)]);
  })().catch((error) => notice(error.message));
})();
