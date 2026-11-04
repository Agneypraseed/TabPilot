// Serialized into Chrome's isolated world. Keep every helper inside this function.
function tabPilotPage(operation = "snapshot", args = {}) {
    if (operation === "fingerprint") {
        const key = "__tabPilotVisualV1";
        if (!globalThis[key] || globalThis[key].document !== document) {
            const visual = { document, id: crypto.randomUUID(), revision: 0 };
            new MutationObserver(() => { visual.revision++; }).observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
            globalThis[key] = visual;
        }
        return { id: globalThis[key].id, revision: globalThis[key].revision };
    }
    if (operation === "status") return { ready: ["interactive", "complete"].includes(document.readyState),
        matches: !args.text || (document.body?.innerText || "").includes(args.text) };
    const stateKey = "__tabPilotPageV1";
    const role = el => el.getAttribute("role") || ({ BUTTON: "button", A: "link", SELECT: "combobox",
        TEXTAREA: "textbox", SUMMARY: "button" }[el.tagName]) || (el.tagName === "INPUT"
        ? ({ checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button", search: "searchbox" }[el.type] || "textbox")
        : el.isContentEditable ? "textbox" : "generic");
    const name = el => {
        const root = el.getRootNode();
        const labelled = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
            .map(id => root.getElementById?.(id)?.textContent || "").join(" ").trim();
        return (el.getAttribute("aria-label") || labelled || Array.from(el.labels || []).map(l => l.textContent).join(" ") ||
            el.getAttribute("alt") || el.getAttribute("placeholder") ||
            (el.matches("input[type=submit],input[type=button]") ? el.value : el.innerText) || el.getAttribute("title") || "")
            .replace(/\s+/g, " ").trim().slice(0, 240);
    };
    const visible = el => {
        const r = el.getBoundingClientRect(), style = el.ownerDocument.defaultView.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const signature = el => JSON.stringify([el.tagName, role(el), name(el), el.getAttribute("type"), el.getAttribute("href")]);
    const rectangle = el => {
        const r = el.getBoundingClientRect();
        let x = r.x, y = r.y, win = el.ownerDocument.defaultView;
        while (win !== window) {
            const frame = win.frameElement, fr = frame.getBoundingClientRect();
            x += fr.x + frame.clientLeft; y += fr.y + frame.clientTop;
            win = win.parent;
        }
        return { x, y, width: r.width, height: r.height };
    };
    if (operation === "snapshot") {
        const snapshotId = crypto.randomUUID();
        const nodes = new Map(), elements = [], extraText = [], frames = [];
        let total = 0;
        const visit = root => {
            for (const el of root.querySelectorAll("*")) {
                if (el.shadowRoot) { extraText.push(el.shadowRoot.textContent || ""); visit(el.shadowRoot); }
                if (el.tagName === "IFRAME" && visible(el)) {
                    try {
                        if (!el.contentDocument) throw new Error();
                        extraText.push(el.contentDocument.body?.innerText || "");
                        visit(el.contentDocument);
                    } catch { frames.push({ title: el.title || "", url: el.src, bounds: rectangle(el), crossOrigin: true }); }
                }
                if (!el.matches("a[href],button,input:not([type=hidden]),textarea,select,summary,[role],[contenteditable=true],[tabindex]") ||
                    !visible(el) || role(el) === "generic") continue;
                total++;
                if (elements.length >= 300) continue;
                const ref = `${snapshotId}:e${elements.length + 1}`;
                nodes.set(ref, { element: el, signature: signature(el) });
                const item = { ref, role: role(el), name: name(el), tag: el.tagName.toLowerCase(),
                    type: el.getAttribute("type") || undefined, disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
                    bounds: rectangle(el) };
                if (el.tagName === "INPUT" && ["password", "file"].includes(el.type)) item.value = "[redacted]";
                else if ("value" in el) item.value = String(el.value).slice(0, 500);
                if (el.tagName === "A") { item.href = el.href; item.target = el.target || "_self"; }
                if ("checked" in el) item.checked = el.checked;
                if (el.tagName === "SELECT") item.options = Array.from(el.options).slice(0, 100)
                    .map(option => ({ value: option.value, label: option.label, selected: option.selected }));
                elements.push(item);
            }
        };
        visit(document);
        globalThis[stateKey] = { document, snapshotId, nodes };
        const text = [document.body?.innerText || "", ...extraText].join("\n");
        return { title: document.title, url: location.href, text: text.slice(0, 20000), truncated: text.length > 20000,
            snapshotId, elements, elementsTruncated: total > elements.length, frames,
            viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio } };
    }
    const state = globalThis[stateKey];
    if (!state || state.document !== document) throw new Error("STALE_REF: take a new snapshot after navigation.");
    const entry = state.nodes.get(args.ref);
    if (!entry || !entry.element.isConnected || signature(entry.element) !== entry.signature) {
        throw new Error("STALE_REF: target changed; take a new snapshot.");
    }
    const el = entry.element;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") throw new Error("Target is disabled.");
    if (!visible(el)) throw new Error("Target is hidden; take a new snapshot.");
    if (operation === "resolve") {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        // Scroll nested frame owners into the top viewport as well.
        let win = el.ownerDocument.defaultView;
        while (win !== window) { win.frameElement.scrollIntoView({ block: "center", behavior: "instant" }); win = win.parent; }
        const rect = rectangle(el);
        const local = el.getBoundingClientRect();
        const root = el.getRootNode();
        const hit = root.elementFromPoint?.(local.x + local.width / 2, local.y + local.height / 2) ||
            el.ownerDocument.elementFromPoint?.(local.x + local.width / 2, local.y + local.height / 2);
        let target = hit;
        while (target && target !== el) target = target.parentElement || target.getRootNode()?.host;
        if (hit && !target) throw new Error("TARGET_OBSCURED: another element covers this target; take a new snapshot or screenshot.");
        if (el.ownerDocument !== document) {
            const topHit = document.elementFromPoint?.(rect.x + rect.width / 2, rect.y + rect.height / 2);
            let frame = el.ownerDocument.defaultView;
            while (frame.parent !== window) frame = frame.parent;
            if (topHit && topHit !== frame.frameElement) throw new Error("TARGET_OBSCURED: frame is covered.");
        }
        return { ...rect, role: role(el), tag: el.tagName.toLowerCase(), type: el.type,
            editable: el.isContentEditable || el.matches("input,textarea"), readOnly: !!el.readOnly };
    }
    if (operation === "focus") { el.focus(); return { focused: el.ownerDocument.activeElement === el || el.getRootNode().activeElement === el }; }
    if (operation === "select") {
        if (el.tagName !== "SELECT") throw new Error("Target is not a select element.");
        const values = Array.isArray(args.values) ? args.values : [args.value];
        if (!el.multiple && values.length !== 1) throw new Error("Select one option for this control.");
        for (const value of values) if (!Array.from(el.options).some(o => o.value === value && !o.disabled)) throw new Error("Option unavailable.");
        for (const option of el.options) option.selected = values.includes(option.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { values: Array.from(el.selectedOptions).map(o => o.value) };
    }
    throw new Error("Unknown page operation.");
}
