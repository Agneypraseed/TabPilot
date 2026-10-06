import { chromium } from 'playwright-core';
import { loadBridgeConfig } from './relay.mjs';

export const CDP_ENDPOINT = 'ws://127.0.0.1:4311/cdp';
const ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'heading', 'switch', 'slider']);
const KEYS = new Set(['Enter', 'Tab', 'Shift+Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Space', 'Backspace', 'Delete', 'Control+A']);

export async function connectBrowser() {
  let config;
  try { config = await loadBridgeConfig(); }
  catch { throw new Error('Start the local TabPilot bridge with `npm start`.'); }
  try {
    return await chromium.connectOverCDP(CDP_ENDPOINT, {
      headers: { Authorization: `Bearer ${config.token}` }, noDefaults: true, timeout: 15_000
    });
  } catch (error) {
    if (String(error.message).includes('ECONNREFUSED') || String(error.message).includes('Failed to connect')) {
      throw new Error('The TabPilot bridge is not running. Start it with `npm start`, then enable a Chrome tab in the extension.');
    }
    throw new Error(`Could not connect to the enabled Chrome tabs: ${String(error.message || error).slice(0, 220)}`);
  }
}

export function contextsOf(browser) { return browser.contexts(); }
export function pagesOf(browser) { return contextsOf(browser).flatMap((context) => context.pages()); }

export function pageAt(browser, index = 0) {
  const pages = pagesOf(browser);
  const page = pages[index];
  if (!page) throw new Error(pages.length ? `Tab ${index} does not exist.` : 'No tabs are enabled. Open the TabPilot panel and enable a regular web tab.');
  return page;
}

export async function browserTabs(browser) {
  return Promise.all(pagesOf(browser).map(async (page, index) => ({ index, title: await page.title().catch(() => ''), url: page.url() })));
}

export async function pageSnapshot(page) {
  const [title, text, accessibility] = await Promise.all([
    page.title().catch(() => ''),
    page.locator('body').innerText({ timeout: 4_000 }).catch(() => ''),
    page.locator('body').ariaSnapshot({ timeout: 4_000 }).catch(() => '')
  ]);
  return { title, url: page.url(), text: text.slice(0, 20_000), accessibility: accessibility.slice(0, 16_000) };
}

function validateText(value, label, max = 5_000) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be a string of at most ${max} characters.`);
  return value;
}

export async function locate(page, selector) {
  const by = selector?.by;
  const value = validateText(selector?.value, 'Selector', 300);
  if (!value.trim()) throw new Error('Enter a nonempty selector value.');
  if (by === 'role') {
    const role = String(selector.role || 'button');
    if (!ROLES.has(role)) throw new Error('Choose a supported interactive role.');
    return page.getByRole(role, { name: value, exact: true });
  }
  if (by === 'label') return page.getByLabel(value, { exact: true });
  if (by === 'placeholder') return page.getByPlaceholder(value, { exact: true });
  if (by === 'text') return page.getByText(value, { exact: true });
  if (by === 'testId') return page.getByTestId(value);
  throw new Error('Choose selector type role, label, placeholder, text, or testId.');
}

async function uniqueLocator(page, selector) {
  const locator = await locate(page, selector);
  const count = await locator.count();
  if (count !== 1) throw new Error(count ? `This selector matches ${count} elements. Make it more specific.` : 'This selector does not match an element on the current page.');
  return locator;
}

export async function navigate(page, target) {
  validateText(target, 'URL', 3_000);
  let url;
  try { url = new URL(target); } catch { throw new Error('Enter a full http or https URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('TabPilot opens only http and https web pages.');
  const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return { url: page.url(), status: response?.status() ?? null };
}

export async function click(page, selector) {
  const locator = await uniqueLocator(page, selector);
  await locator.click({ timeout: 8_000 });
  return { clicked: selector.value };
}

export async function fill(page, selector, value) {
  validateText(value, 'Field value');
  const locator = await uniqueLocator(page, selector);
  await locator.fill(value, { timeout: 8_000 });
  return { filled: selector.value, characters: value.length };
}

export async function hover(page, selector) {
  const locator = await uniqueLocator(page, selector);
  await locator.hover({ timeout: 8_000 });
  return { hovered: selector.value };
}

export async function press(page, key) {
  if (!KEYS.has(key)) throw new Error(`Choose a supported key: ${[...KEYS].join(', ')}.`);
  await page.keyboard.press(key, { timeout: 8_000 });
  return { pressed: key };
}

export async function scroll(page, direction, amount = 500) {
  if (direction !== 'up' && direction !== 'down') throw new Error('Choose scroll direction up or down.');
  if (!Number.isInteger(amount) || amount < 100 || amount > 1_600) throw new Error('Scroll amount must be an integer from 100 to 1600.');
  await page.mouse.wheel(0, direction === 'up' ? -amount : amount);
  return { scrolled: direction, pixels: amount };
}

export async function selectOption(page, selector, option) {
  validateText(option, 'Option value', 500);
  const locator = await uniqueLocator(page, selector);
  const selected = await locator.selectOption(option, { timeout: 8_000 });
  return { selected };
}

export async function openPage(browser, target) {
  const context = contextsOf(browser)[0];
  if (!context) throw new Error('No enabled Chrome browser context is available.');
  const page = await context.newPage();
  if (target) await navigate(page, target);
  return { page, index: pagesOf(browser).indexOf(page), url: page.url() };
}

export async function closePage(page) {
  const url = page.url();
  await page.close();
  return { closed: url };
}
