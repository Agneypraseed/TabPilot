import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = process.cwd();
const artifacts = path.join(root, '.test-artifacts', 'local-cpu');
await mkdir(artifacts, { recursive: true });
const offline = process.argv.includes('--offline');
const autoApprove = process.argv.includes('--auto');
const menuTask = process.argv.includes('--menu');
const suffix = `${offline ? '-offline' : ''}${autoApprove ? '-auto' : ''}${menuTask ? '-menu' : ''}`;
const selected = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const models = [
  { name: 'qwen', id: 'wasm:onnx-community/Qwen2.5-0.5B-Instruct' },
  { name: 'gemma', id: 'wasm:onnx-community/gemma-3-270m-it-ONNX' }
].filter(({ name }) => !selected.length || selected.includes(name));
const url = 'http://tabpilot.test/local';
const html = `<!doctype html><meta charset="utf-8"><title>Local model browser test</title>
<style>body{font:18px system-ui;padding:36px}button{font:inherit;padding:16px;margin:12px}#result{padding:20px;background:#e6f6ee}</style>
<h1>Local model browser test</h1><p>Select the requested summary among these buttons.</p>
<span id="label">Open monthly summary</span>
<button id="wrong">Open annual summary</button><button id="target" aria-labelledby="label">◉</button><button id="menu">Open reports menu</button>
<p id="result">No report opened yet.</p>
<div id="shadow-host"></div>
<script>window.events=[];for(const id of ['wrong','target','menu'])document.getElementById(id).onclick=e=>{events.push({target:id,trusted:e.isTrusted});document.getElementById('result').textContent=id==='target'?'Summary opened':'Wrong report opened';if(id==='menu'){const root=document.getElementById('shadow-host').attachShadow({mode:'open'});root.innerHTML='<button style="padding:16px;font:18px system-ui">Monthly report</button>';root.querySelector('button').onclick=e=>{events.push({target:'monthly',trusted:e.isTrusted});document.getElementById('result').textContent='Monthly report opened';};document.getElementById('result').textContent='Reports menu is open';}};</script>`;
const results = [];
const forbidden = [];
let context;
let panel;
try {
  context = await chromium.launchPersistentContext(path.join(root, '.cache', 'local-cpu-profile'), {
    channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--disable-gpu', '--disable-default-apps']
  });
  await context.route('http://tabpilot.test/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await context.route(/https?:\/\/(?!tabpilot\.test)/, (route) => {
    const request = route.request();
    const host = new URL(request.url()).hostname;
    if (!offline && request.method() === 'GET' && /(^|\.)(huggingface\.co|hf\.co|xethub\.hf\.co)$/.test(host)) return route.continue();
    if (/api\/decide|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|ai-gateway/.test(request.url()) || request.method() === 'POST') forbidden.push(request.url());
    return route.abort();
  });
  context.on('request', (request) => {
    if (/api\/decide|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|ai-gateway/.test(request.url())) forbidden.push(request.url());
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
  await cdp.detach();
  if (offline) await context.setOffline(true);
  console.log(`Loaded extension ${id}. CPU only; hosted inference blocked.`);
  const fixture = await context.newPage();
  await fixture.goto(url);
  panel = await context.newPage();
  panel.on('pageerror', (error) => console.error('PANEL ERROR:', error.message));
  panel.on('console', (message) => { if (message.type() === 'error') console.error('BROWSER:', message.text().slice(0, 600)); });
  panel.on('worker', (worker) => {
    worker.on('console', (message) => { if (message.type() === 'error') console.error('WORKER:', message.text().slice(0, 600)); });
  });
  await panel.addInitScript((url) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (query = {}) => query.active && (query.currentWindow || query.lastFocusedWindow) ? original({ url }) : original(query);
    Object.defineProperty(navigator, 'gpu', { get() { throw new Error('CPU test must never access WebGPU.'); } });
  }, url);
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.locator('#modelProvider option[value="webllm-local"]').waitFor({ state: 'attached' });
  await panel.locator('#developerMode').check();
  for (const model of models) {
    await fixture.goto(url);
    await panel.locator('#modelProvider').selectOption('webllm-local');
    await panel.locator('#localModel').selectOption(model.id);
    await panel.locator('#autoApprove').setChecked(autoApprove);
    const expected = menuTask ? ['menu', 'monthly'] : ['target'];
    const expectedLabels = menuTask ? [/Open reports menu/, /Monthly report/] : [/Open monthly summary/];
    await panel.locator('#taskInput').fill(menuTask
      ? 'Open the reports menu, then click "Monthly report" exactly once. Stop when the page says "Monthly report opened".'
      : 'Click the button named "Open monthly summary" exactly once. Stop when the page says "Summary opened".');
    await panel.locator('#runButton').click();
    const start = Date.now();
    const deadline = start + 20 * 60_000;
    let previous = '';
    let approvals = 0;
    let detail;
    try {
      while (Date.now() < deadline) {
        const status = (await panel.locator('#statusText').textContent()).trim();
        const currentEvents = await fixture.evaluate(() => window.events);
        assert.ok(currentEvents.length <= expected.length, 'Model repeated or added an unrequested click');
        assert.deepEqual(currentEvents.map(({ target }) => target), expected.slice(0, currentEvents.length), 'Model clicked an incorrect control');
        if (status !== previous) { console.log(`${model.name}: ${status}`); previous = status; }
        if (await panel.locator('#approveButton').isVisible()) {
          const label = await panel.locator('#actionLabel').textContent();
          assert.ok(approvals < expected.length, 'Model must not repeat its click');
          assert.match(label, expectedLabels[approvals], `Model chose an incorrect action: ${label}`);
          approvals++;
          await panel.locator('#approveButton').click();
        }
        if (await panel.locator('#runButtonText').textContent() === 'Start task' && !(await panel.locator('#statusLine').evaluate((element) => element.classList.contains('is-working')))) {
          const events = await fixture.evaluate(() => window.events);
          detail = { model: model.id, status, events, approvals, autoApprove, menuTask, seconds: Math.round((Date.now() - start) / 1000) };
          assert.match(status, /selected “done”/, 'Model must finish after observing the result');
          assert.deepEqual(events, expected.map((target) => ({ target, trusted: true })));
          assert.equal(forbidden.length, 0, 'No hosted inference may be attempted');
          results.push({ passed: true, ...detail });
          console.log(`PASS ${model.name}: ${JSON.stringify(detail)}`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!detail) throw new Error('Local model test timed out.');
    } catch (error) {
      results.push({ passed: false, ...detail, model: model.id, error: error.message });
      console.error(`FAIL ${model.name}: ${error.message}`);
      process.exitCode = 1;
      if (await panel.locator('#runButtonText').textContent() !== 'Start task') await panel.locator('#runButton').click();
    }
    await panel.screenshot({ path: path.join(artifacts, `${model.name}${suffix}-panel.png`), fullPage: true });
    await fixture.screenshot({ path: path.join(artifacts, `${model.name}${suffix}-page.png`) });
    await writeFile(path.join(artifacts, `${model.name}${suffix}-trace.txt`), await panel.locator('#developerTrace').textContent());
  }
} catch (error) {
  console.error(error.stack || error);
  results.push({ passed: false, error: error.message });
  process.exitCode = 1;
} finally {
  await writeFile(path.join(artifacts, `results${suffix}.json`), JSON.stringify({ testedAt: new Date().toISOString(), offline, gpuDisabled: true, hostedRequests: forbidden, results }, null, 2));
  await context?.close();
}
