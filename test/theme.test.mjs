import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("../sidepanel.html", import.meta.url), "utf8");
const source = await readFile(new URL("../theme.js", import.meta.url), "utf8");
const key = "tabpilotAppearance";
const flush = () => new Promise(resolve => setImmediate(resolve));
function hub(initial) {
  const listeners = [];
  const data = initial === undefined ? {} : { [key]: initial };
  return {
    data,
    local: {
      get: async () => ({ ...data }),
      set: async values => {
        const oldValue = data[key];
        Object.assign(data, values);
        for (const listener of listeners) listener({ [key]: { oldValue, newValue: data[key] } }, "local");
      }
    },
    onChanged: { addListener: listener => listeners.push(listener) },
    emit(value, area = "local") {
      for (const listener of listeners) listener({ [key]: { newValue: value } }, area);
    }
  };
}
async function panel(storage = hub(), { dark = false, cached } = {}) {
  const dom = new JSDOM(html, { url: "https://extension.test", runScripts: "outside-only" });
  const w = dom.window;
  const mediaListeners = [];
  const media = { matches: dark, addEventListener: (_, listener) => mediaListeners.push(listener) };
  w.matchMedia = () => media;
  w.chrome = { storage };
  if (cached) w.localStorage.setItem(key, cached);
  w.eval(source);
  await flush();
  const root = w.document.documentElement;
  return {
    w, root,
    click: async value => { w.document.querySelector(`[data-theme-option="${value}"]`).click(); await flush(); },
    system: dark => { media.matches = dark; mediaListeners.forEach(listener => listener()); },
    status: () => w.document.getElementById("appearance-status").textContent,
    close: () => w.close()
  };
}

test("system default follows live device changes; explicit preference stays fixed", async () => {
  const ui = await panel(hub(), { dark: true });
  assert.equal(ui.root.dataset.theme, "dark");
  assert.equal(ui.root.dataset.themePreference, "system");
  ui.system(false);
  assert.equal(ui.root.dataset.theme, "light");
  await ui.click("dark");
  ui.system(false);
  assert.equal(ui.root.dataset.theme, "dark");
  assert.equal(ui.w.document.querySelector('[data-theme-option="dark"]').getAttribute("aria-pressed"), "true");
  await ui.click("system");
  assert.equal(ui.root.dataset.theme, "light");
  ui.close();
});

test("appearance persists and synchronizes all open panels independently of a chat", async () => {
  const storage = hub();
  const a = await panel(storage), b = await panel(storage);
  await a.click("dark");
  assert.equal(storage.data[key], "dark");
  assert.equal(b.root.dataset.theme, "dark");
  // A chat change has no appearance handler or dependency on the agent service.
  a.w.document.getElementById("new-chat").click();
  assert.equal(a.root.dataset.theme, "dark");
  const reopened = await panel(storage);
  assert.equal(reopened.root.dataset.theme, "dark");
  assert.match(a.status(), /saved across all tabs/);
  storage.emit(undefined);
  assert.equal(a.root.dataset.themePreference, "system");
  for (const ui of [a, b, reopened]) ui.close();
});

test("Chrome preferences override stale cache; invalid stored values use system", async () => {
  const storage = hub("light");
  const ui = await panel(storage, { cached: "dark", dark: true });
  assert.equal(ui.root.dataset.theme, "light");
  storage.emit("dark", "session");
  assert.equal(ui.root.dataset.theme, "light");
  storage.emit("unexpected");
  assert.equal(ui.root.dataset.themePreference, "system");
  assert.equal(ui.root.dataset.theme, "dark");
  ui.close();
});

test("late initial storage response cannot overwrite a user selection", async () => {
  const storage = hub();
  let resolve;
  storage.local.get = () => new Promise(done => { resolve = done; });
  const ui = await panel(storage);
  await ui.click("dark");
  resolve({ [key]: "light" });
  await flush();
  assert.equal(ui.root.dataset.theme, "dark");
  ui.close();
});

test("rapid choices write in order and keep the latest theme selected", async () => {
  const storage = hub();
  const originalSet = storage.local.set;
  let complete;
  let writes = 0;
  storage.local.set = async values => {
    if (++writes === 1) await new Promise(resolve => { complete = resolve; });
    await originalSet(values);
  };
  const ui = await panel(storage);
  await ui.click("dark");
  await ui.click("light");
  assert.equal(writes, 1);
  complete();
  await flush();
  assert.equal(storage.data[key], "light");
  assert.equal(ui.root.dataset.theme, "light");
  assert.equal(ui.w.localStorage.getItem(key), "light");
  ui.close();
});

test("storage failure explains that preference has not been saved and can retry", async () => {
  const storage = hub("light");
  const originalSet = storage.local.set;
  storage.local.set = async () => { throw new Error("Quota exceeded"); };
  const ui = await panel(storage);
  await ui.click("dark");
  assert.equal(ui.root.dataset.theme, "dark");
  assert.equal(ui.w.localStorage.getItem(key), "light");
  assert.match(ui.status(), /be saved/);
  storage.local.set = originalSet;
  await ui.click("dark");
  assert.equal(storage.data[key], "dark");
  assert.match(ui.status(), /saved across/);
  ui.close();
});
