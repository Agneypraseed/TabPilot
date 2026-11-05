/* Display preferences belong to the extension, independently of agent runs. */
(() => {
  const key = "tabpilotAppearance";
  const valid = value => ["system", "light", "dark"].includes(value);
  const system = matchMedia("(prefers-color-scheme: dark)");
  const storage = globalThis.chrome?.storage;
  let preference = "system";
  let revision = 0;
  let latestSelection = 0;
  let pendingSaves = 0;
  let saves = Promise.resolve();
  const cache = value => {
    try { localStorage.setItem(key, value); } catch { /* Storage can be disabled. */ }
  };
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch { /* Use the system preference until Chrome storage is ready. */ }

  function render() {
    const theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    for (const button of document.querySelectorAll("[data-theme-option]")) {
      button.setAttribute("aria-pressed", String(button.dataset.themeOption === preference));
    }
  }
  const status = text => {
    const output = document.getElementById("appearance-status");
    if (output) output.textContent = text;
  };
  render();
  system.addEventListener("change", render);
  storage?.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.hasOwn(changes, key)) return;
    revision++;
    const value = changes[key].newValue;
    if (pendingSaves && value !== preference) return;
    preference = valid(value) ? value : "system";
    cache(preference);
    render();
  });
  const initialRevision = revision;
  storage?.local.get(key).then(values => {
    if (revision !== initialRevision) return;
    preference = valid(values[key]) ? values[key] : "system";
    cache(preference);
    render();
  }).catch(() => status("Couldn’t load your saved appearance. You can choose it again."));

  function bind() {
    render();
    for (const button of document.querySelectorAll("[data-theme-option]")) {
      button.addEventListener("click", async () => {
        const value = button.dataset.themeOption;
        if (!valid(value)) return;
        revision++;
        const selection = ++latestSelection;
        preference = value;
        render();
        status("Saving appearance…");
        pendingSaves++;
        try {
          if (!storage) throw new Error("Storage unavailable");
          const write = saves.then(() => storage.local.set({ [key]: value }));
          saves = write.catch(() => {});
          await write;
          // Chrome's change event may have already updated every open panel.
          if (selection === latestSelection) {
            cache(value);
            status("Appearance saved across all tabs and conversations.");
          }
        } catch {
          if (selection === latestSelection) status("Appearance changed for now, but couldn’t be saved. Please try again.");
        } finally {
          pendingSaves--;
        }
      });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind, { once: true });
  else bind();
})();
