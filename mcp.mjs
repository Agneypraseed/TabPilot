#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { connectBrowser, browserTabs, pageAt, pageSnapshot, navigate, click, fill, hover, press, scroll, selectOption, openPage, closePage, pagesOf } from './lib/client.mjs';

const server = new McpServer({ name: 'tabpilot-browser', version: '0.2.0' });
const browser = await connectBrowser();
const tabSchema = { tab: z.number().int().min(0).default(0).describe('Zero-based index from browser_tabs.') };
const selectorSchema = {
  by: z.enum(['role', 'label', 'placeholder', 'text', 'testId']).default('role'),
  value: z.string().min(1).max(300).describe('Exact accessible name, label, placeholder, visible text or test ID.'),
  role: z.string().default('button').describe('Accessible role, used only when by is role.')
};

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function register(name, title, description, inputSchema, handler, annotations = {}) {
  server.registerTool(name, { title, description, inputSchema, annotations: { readOnlyHint: false, ...annotations } }, async (input) => {
    try { return await handler(input); }
    catch (error) { return { content: [{ type: 'text', text: String(error.message || error).slice(0, 1_500) }], isError: true }; }
  });
}

register('browser_tabs', 'List enabled Chrome tabs', 'List only Chrome tabs the user explicitly enabled in the TabPilot extension.', {}, async () => textResult(await browserTabs(browser)), { readOnlyHint: true });
register('browser_snapshot', 'Read a browser page', 'Read the visible text and accessibility tree from an enabled Chrome tab.', tabSchema, async ({ tab }) => textResult(await pageSnapshot(pageAt(browser, tab))), { readOnlyHint: true });
register('browser_navigate', 'Navigate a browser tab', 'Navigate an enabled Chrome tab to an http or https URL.', { ...tabSchema, url: z.string().url().max(3_000) }, async ({ tab, url }) => textResult(await navigate(pageAt(browser, tab), url)));
register('browser_click', 'Click an accessible page element', 'Click exactly one element selected by its accessible role and name, label, placeholder, visible text, or test ID.', { ...tabSchema, ...selectorSchema }, async ({ tab, ...selector }) => textResult(await click(pageAt(browser, tab), selector)));
register('browser_fill', 'Fill a page field', 'Fill exactly one accessible page field. Supply only text required by the user task.', { ...tabSchema, ...selectorSchema, text: z.string().max(5_000) }, async ({ tab, text, ...selector }) => textResult(await fill(pageAt(browser, tab), selector, text)));
register('browser_hover', 'Hover over a page element', 'Hover over exactly one accessible page element.', { ...tabSchema, ...selectorSchema }, async ({ tab, ...selector }) => textResult(await hover(pageAt(browser, tab), selector)));
register('browser_press', 'Press a browser key', 'Press a single supported key on the focused enabled page.', { ...tabSchema, key: z.string().min(1).max(20) }, async ({ tab, key }) => textResult(await press(pageAt(browser, tab), key)));
register('browser_scroll', 'Scroll a browser page', 'Scroll an enabled page up or down by a bounded amount.', { ...tabSchema, direction: z.enum(['up', 'down']), pixels: z.number().int().min(100).max(1_600).default(500) }, async ({ tab, direction, pixels }) => textResult(await scroll(pageAt(browser, tab), direction, pixels)));
register('browser_select', 'Select a form option', 'Choose an option from an accessible select menu.', { ...tabSchema, ...selectorSchema, option: z.string().min(1).max(500) }, async ({ tab, option, ...selector }) => textResult(await selectOption(pageAt(browser, tab), selector, option)));
register('browser_open', 'Open a Chrome tab', 'Open an additional tab in the existing Chrome profile. Only http and https addresses are accepted.', { url: z.string().url().max(3_000).optional() }, async ({ url }) => {
  const opened = await openPage(browser, url);
  return textResult({ tab: opened.index, url: opened.url, tabs: await browserTabs(browser) });
  });
register('browser_close', 'Close an enabled Chrome tab', 'Close an enabled tab. This does not close the Chrome browser.', tabSchema, async ({ tab }) => textResult(await closePage(pageAt(browser, tab))), { destructiveHint: true });
register('browser_screenshot', 'Capture an enabled Chrome tab', 'Capture the visible viewport of an enabled tab as an image.', tabSchema, async ({ tab }) => {
  const page = pageAt(browser, tab);
  const screenshot = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 10_000 });
  return { content: [{ type: 'image', data: screenshot.toString('base64'), mimeType: 'image/png' }] };
}, { readOnlyHint: true });

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown() {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

if (!pagesOf(browser).length) {
  console.error('TabPilot MCP is connected. Enable at least one regular web tab from the Chrome side panel to let agents control it.');
}
