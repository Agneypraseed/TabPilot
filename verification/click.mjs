import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { collectVisiblePageState, resolveBrowserTarget } from '../lib/browser-page.js';

const root = process.cwd();
const artifacts = path.join(root, '.test-artifacts', 'click-verification');
await mkdir(artifacts, { recursive: true });
const results = [];
const selectedCases = process.argv.slice(2);
let bridge;
let context;
let panel;
let fixture;
let worker;
let fixtureTabId;
let relocate = false;
let cover = false;
const base = 'http://127.0.0.1:4311';
const fixtureURL = 'http://tabpilot.test/click';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runFile = promisify(execFile);
let bridgeOutput = '';
let lastModelCaseStarted = 0;

const fixtureHTML = `<!doctype html><html><head><meta charset="utf-8"><title>TabPilot click verification</title>
<style>body{font:18px system-ui;padding:35px;color:#152238}button{font:inherit;padding:16px;margin:10px;cursor:pointer}#result{padding:20px;background:#e6f6ee}.cover{position:fixed;inset:0;background:#f3f3f3ee;z-index:9999}#controls{display:flex;align-items:center;flex-wrap:wrap}</style></head><body>
<h1>Browser click verification</h1><p>Choose the requested report among several controls.</p>
<span id="summary-label">Open monthly summary</span>
<div id="controls"><button id="wrong">Open annual summary</button><button id="target" aria-labelledby="summary-label"><span aria-hidden="true">◉</span></button><button id="menu">Open reports menu</button><button disabled>Open monthly summary</button><button hidden>Open monthly summary</button></div>
<div id="shadow-host"></div><p id="result" aria-live="polite">No report opened yet.</p>
<script>window.events=[];const result=document.querySelector('#result');
document.querySelector('#target').onclick=e=>{events.push({target:'summary',trusted:e.isTrusted});result.textContent='Summary opened';};
document.querySelector('#wrong').onclick=e=>{events.push({target:'wrong',trusted:e.isTrusted});result.textContent='Wrong report opened';};
document.querySelector('#menu').onclick=e=>{events.push({target:'menu',trusted:e.isTrusted});const shadow=document.querySelector('#shadow-host').shadowRoot||document.querySelector('#shadow-host').attachShadow({mode:'open'});shadow.innerHTML='<button style="padding:16px;font:18px system-ui">Monthly report</button>';shadow.querySelector('button').onclick=e=>{events.push({target:'monthly',trusted:e.isTrusted});result.textContent='Monthly report opened';};result.textContent='Reports menu is open';};
</script></body></html>`;

async function record(name, run) {
  if (selectedCases.length && !selectedCases.some((filter) => {
    const escaped = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(name);
  })) return;
  if (/^(?:Live |Covered target|Jev )/.test(name)) {
    const pause = Math.max(0, lastModelCaseStarted + 30_000 - Date.now());
    if (pause) { console.log('Spacing live model cases to respect provider rate limits.'); await sleep(pause); }
    lastModelCaseStarted = Date.now();
  }
  const start = Date.now();
  try {
    const detail = await run();
    results.push({ name, passed: true, seconds: Math.round((Date.now() - start) / 1000), ...detail });
    console.log(`PASS ${name}: ${JSON.stringify(detail || {})}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
    await panel?.screenshot({ path: path.join(artifacts, 'failure-panel.png'), fullPage: true }).catch(() => {});
  }
}

async function openFixture() {
  await fixture.goto(fixtureURL);
  [ { id: fixtureTabId } ] = await worker.evaluate(async (url) => chrome.tabs.query({ url }), fixtureURL);
  await fixture.bringToFront();
}

async function runTask(provider, model, task, expectedTargets) {
  await panel.locator('#modelProvider').selectOption(provider);
  await panel.locator('#modelName').fill(model);
  await panel.locator('#taskInput').fill(task);
  await panel.locator('#runButton').click();
  const deadline = Date.now() + 180_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const status = (await panel.locator('#statusText').textContent()).trim();
    if (status !== lastStatus) { console.log(`  ${provider}: ${status}`); lastStatus = status; }
    if (await panel.locator('#approveButton').isVisible()) {
      const label = await panel.locator('#actionLabel').textContent();
      assert.match(label, /Open monthly summary|Open reports menu|Monthly report/, 'Unexpected approval request');
      await panel.locator('#approveButton').click();
    }
    if (await panel.locator('#runButtonText').textContent() === 'Start task' &&
        !(await panel.locator('#statusLine').evaluate((element) => element.classList.contains('is-working')))) {
      const events = await fixture.evaluate(() => window.events);
      if (expectedTargets) {
        assert.match(status, /selected “done”/, 'Model must finish the loop after verifying the page result');
        assert.deepEqual(events.map((event) => event.target), expectedTargets);
        assert.ok(events.every((event) => event.trusted), 'Clicks must come from browser input, not JavaScript element.click()');
      }
      return { provider, model, status, events };
    }
    await sleep(500);
  }
  throw new Error('Timed out waiting for the model/browser loop to finish.');
}

try {
  let health;
  try { health = await fetch(`${base}/health`).then((response) => response.json()); } catch {}
  if (!health?.ok) {
    bridge = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    bridge.stdout.on('data', (data) => { bridgeOutput += data; });
    bridge.stderr.on('data', (data) => { bridgeOutput += data; });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (bridge.exitCode !== null) throw new Error(`Bridge exited: ${bridgeOutput.slice(-1000)}`);
      try { health = await fetch(`${base}/health`).then((response) => response.json()); } catch {}
      if (health?.ok) break;
      await sleep(200);
    }
  }
  assert.ok(health?.ok, 'Bridge must be running');
  const catalog = await fetch(`${base}/api/models`).then((response) => response.json());
  assert.ok(catalog.providers.some((provider) => provider.id === 'gateway' && provider.configured), 'Configured gateway key required for a real-model test');
  context = await chromium.launchPersistentContext(path.join(root, '.cache', `click-verify-${Date.now()}`), {
    channel: 'chrome', headless: false, viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--disable-gpu', '--disable-default-apps']
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
  console.log(`Extension loaded: ${extensionId}; GPU disabled.`);
  context.on('request', async (request) => {
    if (request.url() === `${base}/api/extension-token`) console.log(`Token bootstrap: ${request.method()} origin=${(await request.allHeaders()).origin || '(absent)'}`);
  });
  await cdp.detach();
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  fixture = await context.newPage();
  await fixture.route('http://tabpilot.test/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHTML }));
  await openFixture();
  panel = await context.newPage();
  await panel.addInitScript((url) => {
    // A normal side panel is not a tab; bind this test panel to the fixture tab.
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (query = {}) => query.active && (query.currentWindow || query.lastFocusedWindow) ? original({ url }) : original(query);
  }, fixtureURL);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('#modelProvider option[value="gateway"]').waitFor({ state: 'attached' });
  await panel.locator('#developerMode').check();
  panel.on('request', (request) => {
    if (request.url() !== `${base}/api/decide` || request.method() !== 'POST') return;
    if (relocate) {
      relocate = false;
      fixture.evaluate(() => { document.querySelector('#controls').style.paddingTop = '150px'; }).catch(() => {});
    }
    if (cover) {
      cover = false;
      fixture.evaluate(() => { const overlay = document.createElement('div'); overlay.className = 'cover'; overlay.textContent = 'Page changed during inference'; document.body.append(overlay); }).catch(() => {});
    }
  });

  await record('Live OpenAI model chooses the requested accessible button and finishes', async () => {
    const detail = await runTask('gateway', 'openai/gpt-4.1-mini', 'Click the button named "Open monthly summary" exactly once. Stop when the page says "Summary opened".', ['summary']);
    await fixture.screenshot({ path: path.join(artifacts, 'clicked-page.png') });
    await panel.screenshot({ path: path.join(artifacts, 'model-trace.png'), fullPage: true });
    await writeFile(path.join(artifacts, 'model-trace.txt'), await panel.locator('#developerTrace').innerText());
    return detail;
  });
  await record('Live model handles a button moving during inference', async () => {
    await openFixture(); relocate = true;
    return runTask('gateway', 'openai/gpt-4.1-mini', 'Click "Open monthly summary" exactly once, then stop when "Summary opened" appears.', ['summary']);
  });
  await record('Live model opens a menu and clicks its shadow DOM button', async () => {
    await openFixture();
    return runTask('gateway', 'openai/gpt-4.1-mini', 'Open the reports menu, then click "Monthly report" exactly once. Stop when the page says "Monthly report opened".', ['menu', 'monthly']);
  });
  await record('Covered target stops without sending a click', async () => {
    await openFixture(); cover = true;
    const detail = await runTask('gateway', 'openai/gpt-4.1-mini', 'Click "Open monthly summary" exactly once, then stop when "Summary opened" appears.', null);
    assert.match(detail.status, /covers the chosen control/);
    assert.deepEqual(detail.events, []);
    return detail;
  });
  await record('Jev remains usable with the same click flow', async () => {
    await openFixture();
    return runTask('jev', 'typesafe-ai/jev', 'Click "Open monthly summary" exactly once, then stop when "Summary opened" appears.', ['summary']);
  });
  await record('DOM guard rejects replaced, renamed, disabled, and covered controls', async () => {
    for (const change of ['replace', 'rename', 'disable', 'cover']) {
      await openFixture();
      const snapshot = await fixture.evaluate(collectVisiblePageState);
      const selected = snapshot.controls.find((control) => control.label === 'Open monthly summary' && !control.disabled);
      assert.ok(selected);
      await fixture.evaluate((change) => {
        const target = document.querySelector('#target');
        if (change === 'replace') target.replaceWith(target.cloneNode(true));
        if (change === 'rename') document.querySelector('#summary-label').textContent = 'Delete account';
        if (change === 'disable') target.disabled = true;
        if (change === 'cover') { const overlay = document.createElement('div'); overlay.className = 'cover'; document.body.append(overlay); }
      }, change);
      const resolved = await fixture.evaluate(resolveBrowserTarget, { snapshotId: snapshot.snapshotId, controlId: selected.id });
      assert.ok(resolved.error, `${change} must be rejected`);
    }
    return { rejected: ['replace', 'rename', 'disable', 'cover'] };
  });
  await record('Playwright CLI reads and clicks the enabled browser tab', async () => {
    await openFixture();
    const enabled = await panel.evaluate(async (tabId) => chrome.runtime.sendMessage({ type: 'tabpilot:enable', tabId }), fixtureTabId);
    assert.ok(!enabled.error, enabled.error);
    const { stdout } = await runFile(process.execPath, ['cli.mjs', 'tabs'], { cwd: root, windowsHide: true, timeout: 30_000 });
    const tabs = JSON.parse(stdout);
    const tab = tabs.find((entry) => entry.url === fixtureURL);
    assert.ok(tab, 'CLI must see the fixture shared by the extension');
    await runFile(process.execPath, ['cli.mjs', 'click', '--role', 'button', '--value', 'Open reports menu', '--tab', String(tab.index)], { cwd: root, windowsHide: true, timeout: 30_000 });
    const events = await fixture.evaluate(() => window.events);
    assert.deepEqual(events, [{ target: 'menu', trusted: true }]);
    return { events };
  });
  await record('MCP tool reads and clicks the enabled browser tab', async () => {
    await openFixture();
    const enabled = await panel.evaluate(async (tabId) => chrome.runtime.sendMessage({ type: 'tabpilot:enable', tabId }), fixtureTabId);
    assert.ok(!enabled.error, enabled.error);
    const client = new Client({ name: 'tabpilot-click-verification', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp.mjs')], cwd: root, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const listed = await client.callTool({ name: 'browser_tabs', arguments: {} });
      assert.ok(!listed.isError);
      const tab = JSON.parse(listed.content[0].text).find((entry) => entry.url === fixtureURL);
      assert.ok(tab, 'MCP must see the enabled fixture');
      const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: { tab: tab.index } });
      assert.ok(!snapshot.isError);
      assert.match(snapshot.content[0].text, /Open reports menu/);
      const clicked = await client.callTool({ name: 'browser_click', arguments: { tab: tab.index, by: 'role', role: 'button', value: 'Open reports menu' } });
      assert.ok(!clicked.isError, clicked.content?.[0]?.text);
      const events = await fixture.evaluate(() => window.events);
      assert.deepEqual(events, [{ target: 'menu', trusted: true }]);
      return { events };
    } finally { await client.close(); }
  });
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
  if (panel) await panel.screenshot({ path: path.join(artifacts, 'failure-panel.png'), fullPage: true }).catch(() => {});
} finally {
  const result = { passed: results.length > 0 && results.every((entry) => entry.passed), selectedCases, gpuDisabled: true, testedAt: new Date().toISOString(), results };
  const filename = selectedCases.length ? `result-${Date.now()}.json` : 'result.json';
  await writeFile(path.join(artifacts, filename), JSON.stringify(result, null, 2));
  if (bridgeOutput) await writeFile(path.join(artifacts, 'bridge-log.txt'), bridgeOutput);
  await context?.close();
  bridge?.kill();
}
