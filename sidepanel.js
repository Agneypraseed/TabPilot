const API = 'http://127.0.0.1:4311';
const MAX_STEPS = 25;
const PAGE_TEXT_LIMIT = 10000;
const state = {
  tab: null,
  preferredTabId: null,
  goal: '',
  textToType: '',
  history: [],
  actionsRun: 0,
  runId: 0,
  running: false,
  awaitingApproval: false,
  pending: null,
  bridgeReady: false,
  createdTabs: new Map()
};
const $ = (selector) => document.querySelector(selector);

const ui = {
  connection: $('#connection'),
  connectionText: $('#connectionText'),
  tabTitle: $('#tabTitle'),
  tabUrl: $('#tabUrl'),
  refreshTab: $('#refreshTab'),
  taskInput: $('#taskInput'),
  textToType: $('#textToType'),
  runButton: $('#runButton'),
  runButtonText: $('#runButtonText'),
  runButtonArrow: $('#runButtonArrow'),
  statusLine: $('#statusLine'),
  statusText: $('#statusText'),
  liveSection: $('#liveSection'),
  stepTitle: $('#stepTitle'),
  stepNumber: $('#stepNumber'),
  pageClass: $('#pageClass'),
  controlCount: $('#controlCount'),
  actionCard: $('#actionCard'),
  actionKicker: $('#actionKicker'),
  actionLabel: $('#actionLabel'),
  actionDetail: $('#actionDetail'),
  decisionMetrics: $('#decisionMetrics'),
  matchValue: $('#matchValue'),
  riskValue: $('#riskValue'),
  pageExcerptWrap: $('#pageExcerptWrap'),
  pageExcerpt: $('#pageExcerpt'),
  approveButton: $('#approveButton'),
  reviewHint: $('#reviewHint'),
  activitySection: $('#activitySection'),
  activityList: $('#activityList'),
  actionCounter: $('#actionCounter')
};

document.addEventListener('DOMContentLoaded', initialize);
ui.runButton.addEventListener('click', startOrStop);
ui.approveButton.addEventListener('click', approvePendingStep);
ui.refreshTab.addEventListener('click', refreshTabInfo);
chrome.tabs.onCreated.addListener((tab) => state.createdTabs.set(tab.id, Date.now()));
chrome.tabs.onRemoved.addListener((tabId) => state.createdTabs.delete(tabId));
chrome.tabs.onActivated.addListener(() => {
  if (!state.running) refreshTabInfo();
});

async function initialize() {
  await Promise.all([checkBridge(), refreshTabInfo()]);
}

async function checkBridge() {
  try {
    const response = await fetch(`${API}/health`, { cache: 'no-store' });
    const health = await response.json();
    if (!response.ok) throw new Error('Bridge unavailable');
    state.bridgeReady = Boolean(health.configured && health.model === 'typesafe-ai/jev');
    ui.connection.classList.toggle('is-online', state.bridgeReady);
    ui.connection.classList.toggle('is-offline', !state.bridgeReady);
    ui.connectionText.textContent = state.bridgeReady ? 'Jev ready' : 'Add Gateway key';
    if (!health.configured) setStatus('Add AI_GATEWAY_API_KEY to .env, then restart the local bridge.', 'error');
  } catch {
    state.bridgeReady = false;
    ui.connection.classList.remove('is-online');
    ui.connection.classList.add('is-offline');
    ui.connectionText.textContent = 'Bridge offline';
    setStatus('Start the local bridge with npm start.', 'error');
  }
  updateRunButton();
}

async function refreshTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab || null;
    if (!state.running && tab?.id) state.preferredTabId = tab.id;
    renderTab(tab);
  } catch {
    state.tab = null;
    renderTab(null);
  }
}

function renderTab(tab) {
  ui.tabTitle.textContent = tab?.title || 'No active tab';
  ui.tabUrl.textContent = displayUrl(tab?.url) || 'Open a regular web page';
}

async function startOrStop() {
  if (state.running) {
    stopRun('Stopped.');
    return;
  }
  const task = ui.taskInput.value.trim();
  if (!task) {
    setStatus('Describe the result you want first.', 'error');
    ui.taskInput.focus();
    return;
  }
  if (!state.bridgeReady) {
    await checkBridge();
    if (!state.bridgeReady) return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('Open a regular website tab before starting.', 'error');
    return;
  }

  state.goal = task;
  state.textToType = ui.textToType.value;
  state.history = [];
  state.actionsRun = 0;
  state.preferredTabId = tab.id;
  state.runId += 1;
  state.running = true;
  state.awaitingApproval = false;
  state.pending = null;
  ui.activityList.replaceChildren();
  ui.activitySection.hidden = false;
  ui.liveSection.hidden = false;
  ui.pageExcerptWrap.hidden = true;
  setStatus('Task started. Jev is reading the current page…', 'working');
  updateRunButton();
  await runLoop(state.runId);
}

function stopRun(message = 'Stopped.') {
  state.runId += 1;
  state.running = false;
  state.awaitingApproval = false;
  state.pending = null;
  ui.approveButton.hidden = true;
  ui.reviewHint.hidden = true;
  setStatus(message, 'ready');
  updateRunButton();
}

function finishRun(message, kind = 'ready') {
  state.running = false;
  state.awaitingApproval = false;
  state.pending = null;
  ui.approveButton.hidden = true;
  ui.reviewHint.hidden = true;
  ui.taskInput.disabled = false;
  ui.textToType.disabled = false;
  setStatus(message, kind);
  updateRunButton();
}

async function runLoop(runId) {
  try {
    while (state.running && runId === state.runId) {
      if (state.actionsRun >= MAX_STEPS) {
        finishRun(`Paused after ${MAX_STEPS} actions. Review the page and start another run if needed.`);
        return;
      }
      const tab = await getPreferredTab();
      if (!tab?.id) throw new Error('The task tab was closed.');
      state.tab = tab;
      renderTab(tab);
      setStatus(`Jev is reading ${tab.title || 'the current page'}…`, 'working');

      const pageState = await readPageState(tab.id);
      if (!state.running || runId !== state.runId) return;
      ui.pageExcerpt.textContent = pageState.text.slice(0, 380) || 'No visible page text was found.';
      ui.pageExcerptWrap.hidden = false;
      const decision = await askJev(tab, pageState);
      if (!state.running || runId !== state.runId) return;
      renderDecision(decision, pageState);

      if (decision.action.kind === 'done') {
        finishRun('Jev selected “done”. Review the task result in the browser.');
        return;
      }
      if (decision.action.kind === 'ask') {
        finishRun('Jev could not choose a safe next step. Refine the task or inspect the page.');
        return;
      }
      if (decision.requiresReview) {
        state.pending = { decision, pageState, tab };
        state.awaitingApproval = true;
        ui.approveButton.hidden = false;
        ui.reviewHint.hidden = false;
        setStatus('Jev paused this step for your approval.', 'ready');
        updateRunButton();
        return;
      }

      await performAndContinue(decision, pageState, tab, runId);
    }
  } catch (error) {
    if (runId === state.runId) finishRun(error.message || 'The task stopped because the page could not be read.', 'error');
  }
}

async function performAndContinue(decision, pageState, tab, runId) {
  if (!state.running || runId !== state.runId) return;
  const tabsBefore = await chrome.tabs.query({});
  setStatus(actionProgressText(decision.action), 'working');
  await executeBrowserAction(tab.id, decision.action, pageState.viewport);
  state.actionsRun += 1;
  addHistory(tab, decision.action, 'ran');
  const nextTab = await followAfterAction(tab, tabsBefore, runId);
  if (!state.running || runId !== state.runId) return;
  if (nextTab?.id) {
    state.preferredTabId = nextTab.id;
    state.tab = nextTab;
    renderTab(nextTab);
  }
  setStatus('Step finished. Checking the latest tab…', 'working');
}

async function approvePendingStep() {
  if (!state.pending || !state.running || state.awaitingApproval === false) return;
  const pending = state.pending;
  const runId = state.runId;
  ui.approveButton.disabled = true;
  setStatus('Running the step you approved…', 'working');
  try {
    const current = await chrome.tabs.get(pending.tab.id);
    if (current.url !== pending.tab.url || current.title !== pending.tab.title) {
      state.pending = null;
      state.awaitingApproval = false;
      ui.approveButton.hidden = true;
      ui.reviewHint.hidden = true;
      ui.approveButton.disabled = false;
      setStatus('The page changed. Jev is checking it again before acting.', 'working');
      updateRunButton();
      await runLoop(runId);
      return;
    }
    state.awaitingApproval = false;
    state.pending = null;
    ui.approveButton.hidden = true;
    ui.reviewHint.hidden = true;
    const tabsBefore = await chrome.tabs.query({});
    await executeBrowserAction(pending.tab.id, pending.decision.action, pending.pageState.viewport);
    state.actionsRun += 1;
    addHistory(pending.tab, pending.decision.action, 'approved and ran');
    const nextTab = await followAfterAction(pending.tab, tabsBefore, runId);
    if (!state.running || runId !== state.runId) {
      ui.approveButton.disabled = false;
      return;
    }
    if (nextTab?.id) {
      state.preferredTabId = nextTab.id;
      state.tab = nextTab;
      renderTab(nextTab);
    }
    ui.approveButton.disabled = false;
    setStatus('Approved step finished. Checking the latest tab…', 'working');
    await runLoop(runId);
  } catch (error) {
    ui.approveButton.disabled = false;
    finishRun(error.message || 'Chrome could not run the approved step.', 'error');
  }
}

async function getPreferredTab() {
  if (state.preferredTabId != null) {
    try { return await chrome.tabs.get(state.preferredTabId); }
    catch { state.preferredTabId = null; }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function readPageState(tabId) {
  let result;
  try {
    [result] = await chrome.scripting.executeScript({ target: { tabId }, func: collectVisiblePageState });
  } catch {
    throw new Error('Chrome cannot inspect this tab. Try a regular website instead of a protected browser page.');
  }
  if (!result?.result) throw new Error('The current page did not return readable content.');
  return result.result;
}

function collectVisiblePageState() {
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 &&
      rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };
  const selector = 'button,a[href],input:not([type="password"]),textarea,select,[role="button"],[role="link"],[role="menuitem"],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const controls = [...document.querySelectorAll(selector)].filter(isVisible).slice(0, 45).map((element, id) => {
    const rect = element.getBoundingClientRect();
    const linkedLabel = element.labels ? [...element.labels].map((label) => label.innerText).join(' ') : '';
    const label = element.getAttribute('aria-label') || element.getAttribute('title') || linkedLabel || element.innerText || element.textContent || '';
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type') || '';
    let kind = 'control';
    if (tag === 'input' || tag === 'textarea') kind = 'input';
    else if (tag === 'select') kind = 'select';
    else if (element.isContentEditable) kind = 'editable';
    else if (tag === 'a') kind = 'link';
    const href = element.href || '';
    return {
      id, tag, role: element.getAttribute('role') || '', kind,
      label: String(label).replace(/\s+/g, ' ').trim().slice(0, 180),
      type: type.slice(0, 24),
      placeholder: String(element.getAttribute('placeholder') || '').slice(0, 100),
      href,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      hasPopup: element.getAttribute('aria-haspopup') || ''
    };
  });
  const text = String(document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 10000);
  return {
    text,
    viewport: { width: innerWidth, height: innerHeight },
    controls,
    page: { title: document.title || '', url: location.href }
  };
}

async function askJev(tab, pageState) {
  const response = await fetch(`${API}/api/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task: state.goal,
      textToType: state.textToType,
      page: { title: tab.title || pageState.page.title || '', url: tab.url || pageState.page.url || '' },
      pageText: pageState.text,
      controls: pageState.controls,
      history: state.history.slice(-8)
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Jev decision failed (HTTP ${response.status}).`);
  if (!result.action?.kind) throw new Error('Jev did not return a usable action choice.');
  return result;
}

function renderDecision(decision, pageState) {
  const action = decision.action;
  ui.liveSection.hidden = false;
  ui.stepTitle.textContent = decision.requiresReview ? 'Review Jev’s choice' : 'Jev chose the next step';
  ui.stepNumber.textContent = `STEP ${state.actionsRun + 1}`;
  ui.pageClass.textContent = prettyLabel(decision.pageType || 'other');
  ui.controlCount.textContent = `${pageState.controls.length} controls`;
  ui.actionCard.classList.toggle('is-caution', decision.requiresReview);
  ui.actionKicker.textContent = action.kind === 'done' ? 'TASK STATUS' : action.kind === 'ask' ? 'NEEDS USER INPUT' : decision.requiresReview ? 'PAUSED FOR REVIEW' : 'NEXT ACTION';
  ui.actionLabel.textContent = actionLabel(action);
  ui.actionDetail.textContent = actionDetail(action);
  ui.decisionMetrics.hidden = action.kind === 'done' || action.kind === 'ask';
  ui.matchValue.textContent = `${Math.round((decision.matchProbability || 0) * 100)}%`;
  ui.riskValue.textContent = `${Math.round((decision.riskProbability || 0) * 100)}%`;
}

function actionLabel(action) {
  if (action.kind === 'click') return `Click “${controlLabel(action.control)}”`;
  if (action.kind === 'move') return `Move pointer to “${controlLabel(action.control)}”`;
  if (action.kind === 'type') return `Enter the supplied text in “${controlLabel(action.control)}”`;
  if (action.kind === 'scroll') return `Scroll ${action.direction}`;
  if (action.kind === 'key') return `Press ${action.key}`;
  if (action.kind === 'done') return 'Task appears complete';
  return 'Jev needs you to decide what to do next';
}

function actionDetail(action) {
  if (action.control?.href) return displayUrl(action.control.href);
  if (action.kind === 'type') return `Text: ${action.text}`;
  if (action.kind === 'move') return 'Moves the pointer without clicking.';
  if (action.kind === 'ask') return 'No listed action clearly fits the task.';
  if (action.kind === 'done') return 'Jev selected the completion option.';
  return '';
}

function controlLabel(control) {
  return control?.label || control?.placeholder || control?.role || control?.tag || 'control';
}

async function executeBrowserAction(tabId, action, viewport) {
  if (action.kind === 'done' || action.kind === 'ask') return;
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (error) {
    throw new Error(error.message?.includes('another debugger')
      ? 'A debugger is already attached to this tab. Close DevTools or another automation tool and try again.'
      : 'Chrome could not attach to this tab. Try another regular web page.');
  }
  try {
    const width = Math.max(1, viewport?.width || 1);
    const height = Math.max(1, viewport?.height || 1);
    const rect = action.control?.rect;
    const x = rect ? Math.min(width - 1, Math.max(0, Math.round(rect.x + rect.width / 2))) : Math.round(width / 2);
    const y = rect ? Math.min(height - 1, Math.max(0, Math.round(rect.y + rect.height / 2))) : Math.round(height / 2);
    if (action.kind === 'move') {
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    } else if (action.kind === 'click' || action.kind === 'type') {
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      if (action.kind === 'type') {
        await sendKey(debuggee, 'Control+A');
        await chrome.debugger.sendCommand(debuggee, 'Input.insertText', { text: action.text });
      }
    } else if (action.kind === 'scroll') {
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY: action.direction === 'up' ? -500 : 500
      });
    } else if (action.kind === 'key') {
      await sendKey(debuggee, action.key);
    }
  } finally {
    await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

async function sendKey(debuggee, keyName) {
  const keys = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    Space: { key: ' ', code: 'Space', keyCode: 32 },
    'Control+A': { key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 }
  };
  const entry = keys[keyName];
  if (!entry) throw new Error('Jev selected a key that is not supported.');
  const payload = {
    key: entry.key,
    code: entry.code,
    modifiers: entry.modifiers || 0,
    windowsVirtualKeyCode: entry.keyCode,
    nativeVirtualKeyCode: entry.keyCode
  };
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', { ...payload, type: 'keyDown' });
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', { ...payload, type: 'keyUp' });
}

async function followAfterAction(previousTab, tabsBefore, runId) {
  await delay(900);
  if (!state.running || runId !== state.runId) return null;
  const tabsAfter = await chrome.tabs.query({});
  const existing = new Set(tabsBefore.map((tab) => tab.id));
  const newTabs = tabsAfter.filter((tab) => !existing.has(tab.id));
  if (newTabs.length) {
    newTabs.sort((a, b) => (state.createdTabs.get(a.id) || 0) - (state.createdTabs.get(b.id) || 0));
    const newest = newTabs.at(-1);
    if (newest.windowId !== previousTab.windowId) await chrome.windows.update(newest.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(newest.id, { active: true });
    await waitForTabComplete(newest.id, runId);
    return await chrome.tabs.get(newest.id).catch(() => newest);
  }

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let current = active || await chrome.tabs.get(previousTab.id).catch(() => null);
  if (current?.id) {
    await waitForTabComplete(current.id, runId);
    current = await chrome.tabs.get(current.id).catch(() => current);
  }
  return current;
}

async function waitForTabComplete(tabId, runId) {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    if (!state.running || runId !== state.runId) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === 'complete') return;
    await delay(350);
  }
}

function addHistory(tab, action, result) {
  const entry = {
    page: tab.title || displayUrl(tab.url) || 'Web page',
    action: actionLabel(action),
    result
  };
  state.history.push(entry);
  const item = document.createElement('li');
  item.className = 'activity-item';
  const index = document.createElement('span');
  index.className = 'activity-index';
  index.textContent = String(state.history.length).padStart(2, '0');
  const content = document.createElement('span');
  content.className = 'activity-content';
  const page = document.createElement('span');
  page.className = 'activity-page';
  page.textContent = entry.page;
  const actionText = document.createElement('span');
  actionText.className = 'activity-kind';
  actionText.textContent = `${entry.action} · ${entry.result}`;
  content.append(page, actionText);
  item.append(index, content);
  ui.activityList.prepend(item);
  ui.actionCounter.textContent = `${state.actionsRun} ${state.actionsRun === 1 ? 'action' : 'actions'}`;
}

function actionProgressText(action) {
  if (action.kind === 'click') return `Clicking ${controlLabel(action.control)}…`;
  if (action.kind === 'type') return `Entering the supplied text in ${controlLabel(action.control)}…`;
  if (action.kind === 'move') return `Moving the pointer to ${controlLabel(action.control)}…`;
  if (action.kind === 'scroll') return `Scrolling ${action.direction}…`;
  return `Pressing ${action.key}…`;
}

function updateRunButton() {
  ui.runButton.disabled = !state.running && !state.bridgeReady;
  ui.runButton.classList.toggle('is-stop', state.running);
  ui.runButtonText.textContent = state.running ? 'Stop task' : 'Start task';
  ui.runButtonArrow.textContent = state.running ? '×' : '↗';
  ui.runButton.querySelector('.button-icon svg').innerHTML = state.running
    ? '<path d="M7 7h10v10H7z"/>'
    : '<path d="M8 5.5v13l10-6.5-10-6.5Z"/>';
  ui.taskInput.disabled = state.running;
  ui.textToType.disabled = state.running;
  ui.approveButton.disabled = !state.awaitingApproval;
}

function setStatus(message, kind = 'ready') {
  ui.statusText.textContent = message;
  ui.statusLine.classList.toggle('is-error', kind === 'error');
  ui.statusLine.classList.toggle('is-working', kind === 'working');
}

function displayUrl(value = '') {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  } catch { return ''; }
}

function prettyLabel(value) {
  return String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'Other';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
