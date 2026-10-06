import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

export const HOST = '127.0.0.1';
export const PORT = 4311;
export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const EXTENSION_ID = 'bpnbddeomacmnadacfnmgglciafbjgon';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const CONFIG_FILE = resolve(PROJECT_ROOT, '.tabpilot', 'bridge.json');
const MAX_MESSAGE = 2 * 1024 * 1024;
const REQUEST_TIMEOUT = 30_000;

export async function loadBridgeConfig() {
  await mkdir(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  let config;
  try { config = JSON.parse(await readFile(CONFIG_FILE, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read .tabpilot/bridge.json.'); }
  if (!config || typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) {
    config = { token: randomBytes(32).toString('hex'), createdAt: new Date().toISOString() };
    await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  return config;
}

function constantTimeEquals(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(socket, value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function sendCdp(client, id, result = {}, error, sessionId = null) {
  const message = error
    ? { id, error: { code: -32000, message: String(error).slice(0, 500) }, ...(sessionId ? { sessionId } : {}) }
    : { id, result: result || {}, ...(sessionId ? { sessionId } : {}) };
  sendJson(client.socket, message);
}

function safePage(tab) {
  return {
    tabId: Number(tab.id),
    targetId: String(tab.targetId || `tp-tab-${Number(tab.id)}`).slice(0, 128),
    type: 'page',
    title: String(tab.title || '').slice(0, 300),
    url: String(tab.url || '').slice(0, 2500),
    windowId: Number(tab.windowId) || 1
  };
}

/** Authenticated, user-enabled Chrome tabs bridged to CDP for Playwright clients. */
export class BrowserRelay {
  constructor({ token, extensionId = EXTENSION_ID, server = null } = {}) {
    this.token = token;
    this.extensionOrigin = `chrome-extension://${extensionId}`;
    this.httpServer = server || createServer();
    this.webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
    this.extension = null;
    this.targets = new Map();
    this.clients = new Set();
    this.requests = new Map();
    this.nextRequestId = 1;
    this.extensionGeneration = 0;
    this.httpServer.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
    if (!server) this.httpServer.listen(PORT, HOST);
  }

  ready() { return Boolean(this.extension?.readyState === WebSocket.OPEN); }
  attachedTabs() { return [...this.targets.values()].map((target) => ({ id: target.tabId, title: target.title, url: target.url })); }

  upgrade(request, socket, head) {
    let url;
    try { url = new URL(request.url || '/', `http://${HOST}:${PORT}`); }
    catch { socket.destroy(); return; }
    const host = String(request.headers.host || '').toLowerCase();
    if (!['127.0.0.1:4311', 'localhost:4311'].includes(host) && host !== `127.0.0.1:${PORT}`) { socket.destroy(); return; }
    if (url.pathname === '/extension') {
      const suppliedToken = url.searchParams.get('token');
      if (request.headers.origin !== this.extensionOrigin || !constantTimeEquals(suppliedToken, this.token)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => this.acceptExtension(webSocket));
      return;
    }
    if (url.pathname === '/cdp') {
      const authorization = String(request.headers.authorization || '');
      const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!constantTimeEquals(suppliedToken, this.token) || request.headers.origin) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => this.acceptClient(webSocket));
      return;
    }
    socket.destroy();
  }

  acceptExtension(socket) {
    this.extension?.close(1012, 'A new extension connection replaced this one.');
    const generation = ++this.extensionGeneration;
    this.extension = socket;
    socket.on('message', (data) => this.onExtensionMessage(generation, data));
    socket.on('close', () => {
      if (generation !== this.extensionGeneration) return;
      this.extension = null;
      for (const target of this.targets.values()) this.removeTarget(target.tabId);
      for (const [id, pending] of this.requests) {
        this.requests.delete(id);
        sendCdp(pending.client, pending.id, null, 'Chrome extension disconnected. Reconnect TabPilot in the browser.', pending.publicSessionId);
      }
    });
    socket.on('error', () => {});
    sendJson(socket, { type: 'initialize' });
  }

  acceptClient(socket) {
    const client = { socket, discovering: false, autoAttach: false, targets: new Map(), sessions: new Map(), children: new Map() };
    this.clients.add(client);
    socket.on('message', (data) => this.onClientMessage(client, data));
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => {});
    for (const target of this.targets.values()) this.discover(client, target);
  }

  onExtensionMessage(generation, data) {
    if (generation !== this.extensionGeneration) return;
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type === 'targets' && Array.isArray(message.tabs)) {
      const present = new Set();
      for (const item of message.tabs) {
        const target = safePage(item);
        if (!Number.isSafeInteger(target.tabId)) continue;
        present.add(target.tabId);
        this.updateTarget(target);
      }
      for (const id of this.targets.keys()) if (!present.has(id)) this.removeTarget(id);
    } else if (message.type === 'targetAttached' && message.tab) {
      this.updateTarget(safePage(message.tab));
    } else if (message.type === 'targetUpdated' && message.tab) {
      this.updateTarget(safePage(message.tab));
    } else if (message.type === 'targetDetached' && Number.isSafeInteger(Number(message.tabId))) {
      this.removeTarget(Number(message.tabId));
    } else if (message.type === 'result' && Number.isSafeInteger(message.requestId)) {
      const request = this.requests.get(message.requestId);
      if (!request) return;
      if (process.env.TABPILOT_RELAY_DEBUG === '1') console.error('[relay result]', request.id, request.method, message.error || 'ok', message.result?.frameTree?.frame?.id || '');
      clearTimeout(request.timer);
      this.requests.delete(message.requestId);
      if (message.error) sendCdp(request.client, request.id, null, String(message.error), request.publicSessionId);
      else sendCdp(request.client, request.id, message.result ?? {}, undefined, request.publicSessionId);
    } else if (message.type === 'event' && Number.isSafeInteger(Number(message.tabId))) {
      this.forwardPageEvent(Number(message.tabId), message);
    } else if (message.type === 'heartbeat') {
      sendJson(this.extension, { type: 'heartbeat' });
    }
  }

  updateTarget(target) {
    const previous = this.targets.get(target.tabId);
    const isNew = !previous;
    this.targets.set(target.tabId, { ...previous, ...target });
    for (const client of this.clients) {
      if (!previous || previous.url !== target.url || previous.title !== target.title) this.discover(client, this.targets.get(target.tabId), isNew);
      if (client.sessions.has(target.targetId) && !isNew) {
        sendJson(client.socket, { method: 'Target.targetInfoChanged', params: { targetInfo: this.targetInfo(client, target) } });
      }
      if (isNew && client.autoAttach) this.announceAttach(client, target);
    }
  }

  removeTarget(tabId) {
    const target = this.targets.get(tabId);
    if (!target) return;
    this.targets.delete(tabId);
    for (const [id, pending] of this.requests) {
      if (pending.tabId !== tabId) continue;
      clearTimeout(pending.timer);
      this.requests.delete(id);
      if (pending.method === 'TabPilot.closeTarget') sendCdp(pending.client, pending.id, {}, undefined, pending.publicSessionId);
      else sendCdp(pending.client, pending.id, null, 'The browser tab was closed or disconnected.', pending.publicSessionId);
    }
    for (const client of this.clients) {
      const sessionId = client.sessions.get(target.targetId);
      client.sessions.delete(target.targetId);
      if (sessionId) {
        client.targets.delete(sessionId);
        sendJson(client.socket, { method: 'Target.detachedFromTarget', params: { sessionId, targetId: target.targetId, reason: 'TabPilot tab was disconnected.' } });
      }
      this.discover(client, target, false, true);
    }
  }

  targetInfo(client, target) {
    return { targetId: target.targetId, type: 'page', title: target.title, url: target.url, attached: client.sessions.has(target.targetId), canAccessOpener: true, browserContextId: 'tabpilot-default' };
  }

  discover(client, target, created = false, destroyed = false) {
    if (!client.discovering) return;
    if (destroyed) sendJson(client.socket, { method: 'Target.targetDestroyed', params: { targetId: target.targetId } });
    else sendJson(client.socket, { method: created ? 'Target.targetCreated' : 'Target.targetInfoChanged', params: { targetInfo: this.targetInfo(client, target) } });
  }

  attach(client, target) {
    if (client.sessions.has(target.targetId)) return client.sessions.get(target.targetId);
    const publicSessionId = `tp-session-${randomBytes(8).toString('hex')}`;
    client.sessions.set(target.targetId, publicSessionId);
    client.targets.set(publicSessionId, { tabId: target.tabId, realSessionId: null });
    return publicSessionId;
  }

  announceAttach(client, target) {
    const sessionId = this.attach(client, target);
    sendJson(client.socket, { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: this.targetInfo(client, target), waitingForDebugger: false } });
    return sessionId;
  }

  onClientMessage(client, data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (process.env.TABPILOT_RELAY_DEBUG === '1') console.error('[relay command]', message.id, message.sessionId || 'browser', message.method);
    if (message.method === 'Browser.getVersion') {
      sendCdp(client, message.id, { protocolVersion: '1.3', product: 'Chrome/126.0.0.0', revision: '', userAgent: 'TabPilot existing Chrome browser', jsVersion: '' });
      return;
    }
    if (message.method === 'Target.getBrowserContexts') { sendCdp(client, message.id, { browserContextIds: [] }); return; }
    if (message.method === 'Target.getTargets') {
      sendCdp(client, message.id, { targetInfos: [...this.targets.values()].map((target) => this.targetInfo(client, target)) });
      return;
    }
    if (message.method === 'Target.setDiscoverTargets') {
      client.discovering = Boolean(message.params?.discover);
      sendCdp(client, message.id, {});
      if (client.discovering) for (const target of this.targets.values()) this.discover(client, target, true);
      return;
    }
    if (message.method === 'Target.setAutoAttach' && !message.sessionId) {
      client.autoAttach = Boolean(message.params?.autoAttach);
      sendCdp(client, message.id, {});
      if (client.autoAttach) for (const target of this.targets.values()) this.announceAttach(client, target);
      return;
    }
    if (message.method === 'Target.attachToTarget') {
      const target = [...this.targets.values()].find((item) => item.targetId === message.params?.targetId);
      if (!target) { sendCdp(client, message.id, null, 'This tab is not connected to TabPilot. Enable it in the Chrome extension first.'); return; }
      const sessionId = this.announceAttach(client, target);
      sendCdp(client, message.id, { sessionId });
      return;
    }
    if (message.method === 'Target.detachFromTarget' && !message.sessionId) {
      const publicSessionId = message.params?.sessionId;
      const attached = client.targets.get(publicSessionId);
      if (!attached) { sendCdp(client, message.id, null, 'Unknown browser target session.'); return; }
      client.targets.delete(publicSessionId);
      if (attached.realSessionId) client.children.delete(attached.realSessionId);
      for (const [targetId, sessionId] of client.sessions) {
        if (sessionId === publicSessionId) client.sessions.delete(targetId);
      }
      sendJson(client.socket, { method: 'Target.detachedFromTarget', params: { sessionId: publicSessionId, targetId: this.targets.get(attached.tabId)?.targetId, reason: 'Detached by Playwright.' } });
      sendCdp(client, message.id, {});
      return;
    }
    if (message.method === 'Target.getTargetInfo') {
      const target = message.params?.targetId
        ? [...this.targets.values()].find((item) => item.targetId === message.params.targetId)
        : message.sessionId ? this.targets.get(client.targets.get(message.sessionId)?.tabId) : null;
      if (!target) {
        if (!message.params?.targetId && !message.sessionId) {
          sendCdp(client, message.id, { targetInfo: { targetId: 'tabpilot-browser', type: 'browser', title: 'TabPilot', url: '', attached: false } });
          return;
        }
        sendCdp(client, message.id, null, 'Unknown target.');
        return;
      }
      sendCdp(client, message.id, { targetInfo: this.targetInfo(client, target) });
      return;
    }
    if (message.method === 'Browser.close') {
      sendCdp(client, message.id, {});
      setTimeout(() => client.socket.close(1000, 'Playwright client disconnected.'), 0);
      return;
    }
    if (['Browser.setDownloadBehavior', 'Browser.grantPermissions', 'Browser.resetPermissions', 'Target.runIfWaitingForDebugger', 'Target.disposeBrowserContext'].includes(message.method)) {
      sendCdp(client, message.id, {});
      return;
    }
    if (message.method === 'Browser.getWindowForTarget') {
      const targetId = message.params?.targetId;
      const target = targetId
        ? [...this.targets.values()].find((item) => item.targetId === targetId)
        : this.targets.get(client.targets.get(message.sessionId)?.tabId);
      sendCdp(client, message.id, { windowId: target?.windowId || 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' } });
      return;
    }
    if (message.method === 'Target.createTarget') {
      const requestId = this.nextRequestId++;
      const clientId = message.id;
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        sendCdp(client, clientId, null, 'Timed out opening a Chrome tab.');
      }, REQUEST_TIMEOUT);
      this.requests.set(requestId, { client, id: clientId, tabId: null, createTarget: true, timer });
      sendJson(this.extension, { type: 'createTarget', requestId, url: String(message.params?.url || 'about:blank').slice(0, 3000) });
      if (!this.ready()) { clearTimeout(timer); this.requests.delete(requestId); sendCdp(client, clientId, null, 'Reconnect TabPilot in Chrome before opening a browser tab.'); }
      return;
    }

    const tabId = message.sessionId
      ? client.targets.get(message.sessionId)?.tabId
      : message.method === 'Target.activateTarget' || message.method === 'Target.closeTarget' || message.method === 'Page.bringToFront'
        ? [...this.targets.values()].find((target) => target.targetId === message.params?.targetId)?.tabId
        : null;
    if (tabId === undefined || tabId === null || !this.targets.has(tabId)) {
      sendCdp(client, message.id, null, 'This tab is not enabled for TabPilot. Open the extension and enable browser access for the tab.');
      return;
    }
    const method = message.method === 'Target.activateTarget' || message.method === 'Page.bringToFront'
      ? 'TabPilot.activateTarget'
      : message.method === 'Target.closeTarget' ? 'TabPilot.closeTarget' : message.method;
    this.sendCommand(client, message.id, tabId, method, message.params || {}, client.targets.get(message.sessionId)?.realSessionId || null, message.sessionId || null);
  }

  sendCommand(client, id, tabId, method, params, realSessionId, publicSessionId) {
    const requestId = this.nextRequestId++;
    const timer = setTimeout(() => {
      this.requests.delete(requestId);
      sendCdp(client, id, null, `Chrome did not answer ${method} in time.`, publicSessionId);
    }, REQUEST_TIMEOUT);
    this.requests.set(requestId, { client, id, tabId, method, publicSessionId, timer });
    sendJson(this.extension, { type: 'command', requestId, tabId, sessionId: realSessionId, method, params });
  }

  forwardPageEvent(tabId, message) {
    if (process.env.TABPILOT_RELAY_DEBUG === '1') console.error('[relay event]', tabId, message.sessionId || 'page', message.method, message.params?.context?.auxData?.frameId || '', message.params?.context?.auxData?.isDefault ?? '');
    const target = this.targets.get(tabId);
    if (!target) return;
    for (const client of this.clients) {
      const mainSessionId = client.sessions.get(target.targetId) || null;
      if (!mainSessionId) continue;
      const childSessionId = message.sessionId ? client.children.get(message.sessionId) : null;
      const isTargetSessionEvent = message.method === 'Target.attachedToTarget' || message.method === 'Target.detachedFromTarget';
      const eventSessionId = childSessionId || (!message.sessionId || isTargetSessionEvent ? mainSessionId : null);
      if (!eventSessionId) continue;
      const params = { ...(message.params || {}) };
      if (message.method === 'Target.attachedToTarget' && message.params?.sessionId) {
        const realChildSessionId = message.params.sessionId;
        let publicChildSessionId = client.children.get(realChildSessionId);
        if (!publicChildSessionId) {
          publicChildSessionId = `tp-frame-${randomBytes(7).toString('hex')}`;
          client.targets.set(publicChildSessionId, { tabId, realSessionId: realChildSessionId });
          client.children.set(realChildSessionId, publicChildSessionId);
        }
        params.sessionId = publicChildSessionId;
      }
      if (message.method === 'Target.detachedFromTarget' && params.sessionId) {
        const realChildSessionId = params.sessionId;
        const childSession = client.children.get(realChildSessionId);
        if (childSession) params.sessionId = childSession;
        client.children.delete(realChildSessionId);
        if (childSession) client.targets.delete(childSession);
      }
      const outgoing = { method: message.method, params };
      outgoing.sessionId = eventSessionId;
      sendJson(client.socket, outgoing);
    }
  }
}
