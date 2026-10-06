import { normalizeSourcePage, safeDownloadFilename, safeDownloadFolder, sameSourcePage } from './lib/downloads.js';

const BRIDGE = 'http://127.0.0.1:4311';
const DOWNLOAD_CONTEXT_KEY = 'tabpilotDownloadContext';
const enabledTabs = new Set();
const controlledTabs = new Set();
const targetIds = new Map();
let socket = null;
let connecting = null;
let heartbeatInterval = null;

chrome.runtime.onInstalled.addListener(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));
chrome.runtime.onStartup.addListener(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  enabledTabs.delete(tabId);
  controlledTabs.delete(tabId);
  targetIds.delete(tabId);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'targetDetached', tabId }));
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (enabledTabs.has(tabId) && (change.url || change.title || change.status === 'complete')) {
    socketSend({ type: 'targetUpdated', tab: describeTab(tab) });
  }
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!enabledTabs.has(source.tabId)) return;
  socketSend({ type: 'event', tabId: source.tabId, sessionId: source.sessionId || null, method, params: params || {} });
});
chrome.debugger.onDetach.addListener((source) => {
  const wasShared = enabledTabs.delete(source.tabId);
  controlledTabs.delete(source.tabId);
  targetIds.delete(source.tabId);
  if (wasShared) socketSend({ type: 'targetDetached', tabId: source.tabId });
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let suggested = false;
  const finish = (value) => {
    if (suggested) return;
    suggested = true;
    suggest(value);
  };
  chrome.storage.session.get(DOWNLOAD_CONTEXT_KEY).then((stored) => {
    const context = stored[DOWNLOAD_CONTEXT_KEY];
    if (!context || context.expiresAt < Date.now() || !sameSourcePage(item.referrer, context.referrer)) {
      finish();
      return;
    }
    const filename = safeDownloadFilename(item.filename);
    finish({ filename: `${context.folder}/${filename}`, conflictAction: 'uniquify' });
  }).catch(() => finish());
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'tabpilot:status') {
    sendResponse({ connected: socket?.readyState === WebSocket.OPEN, enabled: enabledTabs.has(message.tabId) });
    return false;
  }
  if (message?.type === 'tabpilot:enable') {
    enableTab(Number(message.tabId)).then((tab) => sendResponse({ ok: true, tab: describeTab(tab) }), (error) => sendResponse({ error: readableError(error) }));
    return true;
  }
  if (message?.type === 'tabpilot:control') {
    controlTab(Number(message.tabId)).then((tab) => sendResponse({ ok: true, tab: describeTab(tab) }), (error) => sendResponse({ error: readableError(error) }));
    return true;
  }
  if (message?.type === 'tabpilot:release-control') {
    releaseControl(Number(message.tabId)).then(() => sendResponse({ ok: true }), (error) => sendResponse({ error: readableError(error) }));
    return true;
  }
  if (message?.type === 'tabpilot:downloads:set-context') {
    setDownloadContext(message.context).then(() => sendResponse({ ok: true }), (error) => sendResponse({ error: readableError(error) }));
    return true;
  }
  if (message?.type === 'tabpilot:disable') {
    disableTab(Number(message.tabId)).then(() => sendResponse({ ok: true }), (error) => sendResponse({ error: readableError(error) }));
    return true;
  }
  if (message?.type === 'tabpilot:command') {
    commandChrome(Number(message.tabId), message.sessionId || null, String(message.method), message.params || {})
      .then((result) => sendResponse({ result }), (error) => sendResponse({ error: readableError(error) }));
    return true;
  }
  return false;
});

async function extensionToken() {
  // Chrome omits Origin on privileged extension GETs. A POST includes the
  // extension origin so the bridge can verify it without weakening its gate.
  const response = await fetch(`${BRIDGE}/api/extension-token`, { method: 'POST', cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.token !== 'string') throw new Error(body.error || 'Start the TabPilot local bridge.');
  return body.token;
}

async function ensureConnected() {
  if (socket?.readyState === WebSocket.OPEN) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const token = await extensionToken();
    const ws = new WebSocket(`ws://127.0.0.1:4311/extension?token=${encodeURIComponent(token)}`);
    socket = ws;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting the local Playwright bridge.')), 8000);
      ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Could not reach the TabPilot bridge at 127.0.0.1:4311.')); }, { once: true });
    });
    ws.addEventListener('message', (event) => handleBridgeMessage(event.data));
    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socket = null;
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
      for (const tabId of [...enabledTabs]) chrome.debugger.detach({ tabId }).catch(() => {});
      enabledTabs.clear();
    });
    ws.addEventListener('error', () => {});
    ws.send(JSON.stringify({ type: 'targets', tabs: await enabledTabsList() }));
    clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
    }, 20_000);
  })().finally(() => { connecting = null; });
  return connecting;
}

async function enabledTabsList() {
  const tabs = [];
  for (const tabId of enabledTabs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && isControllablePage(tab.url)) tabs.push(describeTab(tab));
  }
  return tabs;
}

async function enableTab(tabId) {
  await ensureConnected();
  return attachTab(tabId, true);
}

async function controlTab(tabId) {
  return attachTab(tabId, false);
}

async function attachTab(tabId, shareWithPlaywright) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !isControllablePage(tab.url)) throw new Error('Open a regular http or https web page before enabling browser control.');
  if (!enabledTabs.has(tabId) && !controlledTabs.has(tabId)) {
    try { await chrome.debugger.attach({ tabId }, '1.3'); }
    catch (error) {
      throw new Error(error.message?.includes('another debugger')
        ? 'This tab already has DevTools or another browser controller attached. Close it and try again.'
        : 'Chrome could not attach to this tab. Protected pages such as chrome:// cannot be controlled.');
    }
    controlledTabs.add(tabId);
  }
  if (shareWithPlaywright && !targetIds.has(tabId)) {
    const target = (await chrome.debugger.getTargets()).find((item) => item.tabId === tabId && item.type === 'page');
    if (!target?.id) throw new Error('Chrome did not expose the tab target needed by Playwright.');
    targetIds.set(tabId, target.id);
  }
  if (shareWithPlaywright && !enabledTabs.has(tabId)) {
    controlledTabs.delete(tabId);
    enabledTabs.add(tabId);
    socketSend({ type: 'targetAttached', tab: describeTab(tab) });
  } else if (shareWithPlaywright) {
    socketSend({ type: 'targetUpdated', tab: describeTab(tab) });
  }
  return tab;
}

async function disableTab(tabId) {
  if (enabledTabs.has(tabId)) {
    enabledTabs.delete(tabId);
    socketSend({ type: 'targetDetached', tabId });
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function releaseControl(tabId) {
  if (!controlledTabs.has(tabId)) return;
  controlledTabs.delete(tabId);
  if (!enabledTabs.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function commandChrome(tabId, sessionId, method, params) {
  if (!enabledTabs.has(tabId) && !controlledTabs.has(tabId)) throw new Error('Enable this tab in the TabPilot panel first.');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('The Chrome tab was closed.');
  if (method === 'TabPilot.activateTarget') {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return {};
  }
  if (method === 'TabPilot.closeTarget') {
    chrome.tabs.remove(tabId).catch(() => {});
    return { success: true };
  }
  return chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params);
}

async function createTarget(url) {
  const targetUrl = String(url || 'about:blank');
  if (targetUrl !== 'about:blank') {
    let parsed;
    try { parsed = new URL(targetUrl); } catch { throw new Error('Chrome can only open http or https page URLs.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Chrome can only open http or https page URLs.');
  }
  const tab = await chrome.tabs.create({ url: targetUrl, active: false });
  await enableTab(tab.id);
  return { targetId: targetIds.get(tab.id) };
}

function handleBridgeMessage(raw) {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }
  if (message.type === 'heartbeat') return;
  if (message.type === 'command' && Number.isSafeInteger(message.requestId)) {
    const operation = commandChrome(Number(message.tabId), message.sessionId || null, String(message.method), message.params || {});
    operation.then((result) => socketSend({ type: 'result', requestId: message.requestId, result: result || {} }),
      (error) => socketSend({ type: 'result', requestId: message.requestId, error: readableError(error) }));
    return;
  }
  if (message.type === 'createTarget' && Number.isSafeInteger(message.requestId)) {
    createTarget(message.url).then((result) => socketSend({ type: 'result', requestId: message.requestId, result }),
      (error) => socketSend({ type: 'result', requestId: message.requestId, error: readableError(error) }));
  }
}

function socketSend(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function describeTab(tab) {
  return { id: tab.id, targetId: targetIds.get(tab.id), windowId: tab.windowId, title: tab.title || '', url: tab.url || '' };
}

function isWebPage(url = '') {
  return /^https?:\/\//i.test(url);
}

function isControllablePage(url = '') {
  return isWebPage(url) || url === 'about:blank';
}

async function setDownloadContext(value) {
  if (!value) {
    await chrome.storage.session.remove(DOWNLOAD_CONTEXT_KEY);
    return;
  }
  const referrer = normalizeSourcePage(value.referrer);
  if (!referrer) {
    await chrome.storage.session.remove(DOWNLOAD_CONTEXT_KEY);
    return;
  }
  await chrome.storage.session.set({
    [DOWNLOAD_CONTEXT_KEY]: {
      folder: safeDownloadFolder(value.folder),
      referrer,
      expiresAt: Date.now() + 10 * 60 * 1000
    }
  });
}

function readableError(error) {
  return String(error?.message || error || 'Browser command failed.').replace(/^Error:\s*/i, '').slice(0, 300);
}
