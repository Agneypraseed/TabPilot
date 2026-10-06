#!/usr/bin/env node
import { connectBrowser, browserTabs, pageAt, pageSnapshot, navigate, click, fill, hover, press, scroll, selectOption, openPage, closePage } from './lib/client.mjs';

const HELP = `TabPilot controls Chrome tabs you have enabled in the extension, using Playwright.

Commands:
  tabpilot tabs
  tabpilot snapshot [--tab 0]
  tabpilot goto --url https://example.com [--tab 0]
  tabpilot open [--url https://example.com]
  tabpilot click --role button --value "Continue" [--tab 0]
  tabpilot fill --label "Search" --text "hiking backpacks" [--tab 0]
  tabpilot hover --text "Menu"
  tabpilot press --key Enter
  tabpilot scroll --direction down [--pixels 500]
  tabpilot select --label "Country" --option DE
  tabpilot close [--tab 0]

Selectors use --by role|label|placeholder|text|testId and --value, or --role/--name, --label, --placeholder, --text, or --test-id.
Only the TabPilot panel's explicitly enabled tabs are available.`;

const command = process.argv[2] || 'help';
const argv = process.argv.slice(3);
if (command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

function parseOptions(parts) {
  const options = {};
  for (let i = 0; i < parts.length; i += 1) {
    const name = parts[i];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    if (i + 1 >= parts.length || parts[i + 1].startsWith('--')) throw new Error(`Expected a value after ${name}.`);
    options[name.slice(2).replaceAll('-', '_')] = parts[++i];
  }
  return options;
}

function selector(options) {
  let by = options.by;
  let value = options.value;
  if (options.role) { by = 'role'; value ||= options.name; }
  if (options.label) { by = 'label'; value ||= options.label; }
  if (options.placeholder) { by = 'placeholder'; value ||= options.placeholder; }
  if (options.text) { by = 'text'; value ||= options.text; }
  if (options.test_id) { by = 'testId'; value ||= options.test_id; }
  return { by: by || 'role', role: options.role || 'button', value };
}

let browser;
try {
  const options = parseOptions(argv);
  const tabIndex = Number(options.tab || 0);
  if (!Number.isInteger(tabIndex) || tabIndex < 0) throw new Error('--tab must be a nonnegative tab index.');
  browser = await connectBrowser();
  let result;
  if (command === 'tabs') result = await browserTabs(browser);
  else if (command === 'open') result = await openPage(browser, options.url);
  else if (command === 'snapshot') result = await pageSnapshot(pageAt(browser, tabIndex));
  else if (command === 'goto') result = await navigate(pageAt(browser, tabIndex), options.url || '');
  else if (command === 'click') result = await click(pageAt(browser, tabIndex), selector(options));
  else if (command === 'fill' || command === 'type') result = await fill(pageAt(browser, tabIndex), selector(options), options.text || '');
  else if (command === 'hover') result = await hover(pageAt(browser, tabIndex), selector(options));
  else if (command === 'press') result = await press(pageAt(browser, tabIndex), options.key || '');
  else if (command === 'scroll') result = await scroll(pageAt(browser, tabIndex), options.direction || '', options.pixels === undefined ? 500 : Number(options.pixels));
  else if (command === 'select') result = await selectOption(pageAt(browser, tabIndex), selector(options), options.option || '');
  else if (command === 'close') result = await closePage(pageAt(browser, tabIndex));
  else throw new Error(`Unknown command "${command}".\n\n${HELP}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`TabPilot: ${String(error.message || error)}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}
