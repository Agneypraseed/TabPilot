// Serialized into Chrome's isolated world. Keep every helper inside this function.
function tabPilotPage(operation = "snapshot", args = {}) {
    const decorationsKey = "__tabPilotDecorationsV1";
    const decorations = globalThis[decorationsKey] ??= new WeakSet();
    if (operation === "pointer") {
        const key = "__tabPilotPointerV2";
        let pointer = globalThis[key];
        if (args.visible === false) {
            if (pointer) { clearTimeout(pointer.timer); pointer.host.remove(); }
            return { visible: false };
        }
        if (![args.x, args.y].every(Number.isFinite)) throw new Error("Invalid pointer coordinates.");
        const reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        if (!pointer?.host.isConnected) {
            const from = pointer?.x !== undefined ? { x: pointer.x - 3, y: pointer.y - 2 } : { x: args.x - 25, y: args.y - 15 };
            const host = document.createElement("tabpilot-pointer");
            decorations.add(host);
            host.setAttribute("aria-hidden", "true");
            host.style.cssText = "all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;pointer-events:none!important;z-index:2147483647!important";
            const shadow = host.attachShadow({ mode: "closed" });
            shadow.innerHTML = `<style>
                .cursor{position:fixed;left:0;top:0;width:28px;height:32px;pointer-events:none;will-change:transform;transition:transform 240ms cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 1px 2px #0003)}
                svg{display:block;width:28px;height:32px;overflow:visible}
                .ripple{position:absolute;left:-11px;top:-12px;width:24px;height:24px;border:2px solid #5575ef;border-radius:50%;box-sizing:border-box;opacity:0;pointer-events:none}
                @media(prefers-reduced-motion:reduce){.cursor{transition:none}}
            </style><div class="cursor"><span class="ripple"></span><svg viewBox="0 0 28 32" aria-hidden="true"><path d="M3 2V24L9 18L13 27L17 25L13 16H22Z" fill="#202735" stroke="white" stroke-width="1.7" stroke-linejoin="round"/></svg></div>`;
            const mark = node => { decorations.add(node); for (const child of node.childNodes) mark(child); };
            mark(shadow);
            pointer = { host, cursor: shadow.querySelector(".cursor"), ripple: shadow.querySelector(".ripple") };
            globalThis[key] = pointer;
            pointer.cursor.style.transform = `translate3d(${from.x}px,${from.y}px,0)`;
            document.documentElement.append(host);
            pointer.cursor.getBoundingClientRect();
        }
        clearTimeout(pointer.timer);
        pointer.cursor.style.transform = `translate3d(${args.x - 3}px,${args.y - 2}px,0)`;
        pointer.x = args.x; pointer.y = args.y;
        if (args.pressed) pointer.ripple.animate?.([
            { opacity: 0.65, transform: "scale(.65)" }, { opacity: 0, transform: "scale(1.8)" }
        ], { duration: reduced ? 100 : 360, easing: "ease-out" });
        pointer.timer = setTimeout(() => pointer.host.remove(), 1200);
        return { visible: true, reducedMotion: reduced };
    }
    if (operation === "fingerprint") {
        const key = "__tabPilotVisualV2";
        if (!globalThis[key] || globalThis[key].document !== document) {
            const visual = { document, id: crypto.randomUUID(), revision: 0 };
            new MutationObserver(records => {
                const own = record => decorations.has(record.target) ||
                    (record.type === "childList" && [...record.addedNodes, ...record.removedNodes].length > 0 &&
                        [...record.addedNodes, ...record.removedNodes].every(node => decorations.has(node)));
                if (records.some(record => !own(record))) visual.revision++;
            }).observe(document, { subtree: true, attributes: true, childList: true, characterData: true });
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
    if (operation === "approval-prepare" || operation === "approval-check") {
        const control = "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=menuitem],[role=checkbox],[role=radio],[contenteditable=true]";
        const across = (el, selector) => {
            while (el) {
                const match = el.closest(selector);
                if (match) return match;
                el = el.getRootNode().host;
            }
            return null;
        };
        const atPoint = ({ x, y }, root = document) => {
            const el = root.elementFromPoint?.(x, y);
            if (!el) return null;
            if (el.shadowRoot?.elementFromPoint) {
                const child = el.shadowRoot.elementFromPoint(x, y);
                if (child && child !== el) return atPoint({ x, y }, el.shadowRoot);
            }
            if (el.tagName === "IFRAME" && el.contentDocument) {
                const rect = el.getBoundingClientRect();
                return atPoint({ x: x - rect.x - el.clientLeft, y: y - rect.y - el.clientTop }, el.contentDocument) ?? el;
            }
            return el;
        };
        const focused = () => {
            let el = document.activeElement, child;
            while ((child = el?.shadowRoot?.activeElement || (el?.tagName === "IFRAME" && el.contentDocument?.activeElement))) {
                if (child === el) break;
                el = child;
            }
            return el;
        };
        const { token, method, params, points = [], inputPoint, keyboardFocused } = args;
        const entry = params.ref && globalThis[stateKey]?.nodes.get(params.ref);
        if (params.ref && (!entry?.element?.isConnected || entry.signature !== signature(entry.element) || !visible(entry.element)))
            throw new Error("STALE_REF: take a new snapshot before reviewing this action.");
        const hits = points.map(point => atPoint(point));
        const target = entry?.element ?? (method === "coordinate" ? across(hits[0], control) ?? hits[0] : method === "press" ? focused() : null);
        const inputHit = inputPoint ? atPoint(inputPoint) : null;
        if (inputPoint && target && across(inputHit, control) !== target && !target.contains(inputHit))
            throw new Error("APPROVAL_CHANGED: the reviewed control is covered or moved. Observe the page before trying again.");
        if (keyboardFocused && target && focused() !== target)
            throw new Error("APPROVAL_CHANGED: the reviewed control lost focus. Observe the page before trying again.");
        const form = target?.form ?? across(target, "form,[role=form]");
        const dialog = across(target, "dialog,[role=dialog],[role=alertdialog]");
        const region = form ?? dialog ?? target?.parentElement ?? document.body;
        const key = method === "press" ? params.key.split("+").at(-1) : null;
        const editable = target && (target.isContentEditable || target.matches("textarea,input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file])"));
        const search = Boolean(across(target, "[role=search]") || form?.querySelector("input[type=search]") ||
            editable && (target.type === "search" || /\bsearch\b/i.test(name(target))));
        const implicitSubmit = key === "Enter" && editable && !target.isContentEditable && target.tagName !== "TEXTAREA";
        const submit = implicitSubmit && form?.querySelector("input[type=submit],button[type=submit],button:not([type])");
        const effect = submit || target;
        const label = effect ? name(effect) : "";
        const identified = effect?.matches(control) && Boolean(label);
        const anchor = effect?.closest("a[href]");
        const formAction = effect?.getAttribute("formaction") || form?.getAttribute("action") || "";
        const fieldNodes = [...(form?.elements ?? region?.querySelectorAll("input,textarea,select,[contenteditable=true]") ?? [])];
        const associatedEditable = [...(region?.querySelectorAll("[contenteditable=true]") ?? [])].filter(el => !fieldNodes.includes(el));
        const fields = [...fieldNodes, ...associatedEditable];
        const proofFields = fields.slice(0, 200).map(el => [
            signature(el), el.name, el.disabled, el.checked, el.selectedIndex,
            Array.from(el.selectedOptions ?? [], option => option.value),
            String(el.isContentEditable ? el.innerText : el.value ?? "").slice(0, 20000)
        ]);
        const nearby = String(region?.innerText ?? "").replace(/\s+/g, " ").trim();
        const targetAttributes = el => Array.from(el?.attributes ?? [])
            .filter(({ name }) => name !== "class" && name !== "style")
            .map(({ name, value }) => [name, value]);
        const fullProof = JSON.stringify([
            location.href, document.title, target ? signature(target) : null, target?.ownerDocument.URL, effect ? signature(effect) : null,
            anchor?.href, anchor?.target, formAction, effect?.getAttribute("formmethod") ?? form?.getAttribute("method"),
            targetAttributes(target), target === effect ? null : targetAttributes(effect),
            target?.disabled, form || dialog || target && !anchor ? nearby.slice(0, 30000) : null, proofFields
        ]);
        const approvalKey = "__tabPilotApprovalV1";
        if (operation === "approval-check") {
            const saved = globalThis[approvalKey];
            if (!saved || saved.token !== token || saved.document !== document || saved.target !== target ||
                saved.effect !== effect || saved.hits.some((hit, index) => hit !== hits[index]) || saved.proof !== fullProof)
                throw new Error("APPROVAL_CHANGED: the reviewed page, target, or details changed. Observe it and request fresh approval before acting.");
            return { verified: true };
        }
        globalThis[approvalKey] = { token, document, target, effect, hits, proof: fullProof };
        const details = fields.flatMap(el => {
            if (!visible(el) || ["password", "file"].includes(el.type)) return [];
            const caption = name(el) || el.name || "";
            const kind = /^(to|recipient|recipients|send to|email to|recipient email|beneficiary|payee)$/i.test(caption) ? "recipient"
                : /^(subject|email subject)$/i.test(caption) ? "subject"
                : /^(amount|total|order total|payment amount|transfer amount|price)$/i.test(caption) ? "amount"
                : /^(item|product|record|document)$/i.test(caption) ? "item" : "";
            return kind && el.value ? [{ kind, value: String(el.value).slice(0, 180) }] : [];
        }).slice(0, 8);
        const amounts = new Set(nearby.match(/(?:[$€£¥]\s*\d[\d.,]*|\b(?:USD|EUR|GBP|JPY|CAD|AUD)\s+\d[\d.,]*)/gi));
        if (amounts.size === 1 && !details.some(item => item.kind === "amount")) details.push({ kind: "amount", value: [...amounts][0] });
        const keyActivates = key === "Enter" || key === "Space" || key === " " || key === "Delete" || key === "Backspace";
        const ambiguous = ["click", "coordinate"].includes(method) && (!identified && !editable ||
            method === "coordinate" && points.length > 1 && (!hits[1] || !across(hits[1], control))) ||
            method === "press" && keyActivates && (!target || !editable && (!identified || key === "Delete" || key === "Backspace") ||
                !search && editable && (implicitSubmit && !identified || params.key.includes("+") && key === "Enter"));
        return {
            title: document.title.slice(0, 160), site: location.host, label,
            details, search: Boolean(search), ambiguous: Boolean(ambiguous),
            genericControl: Boolean(effect?.matches("button,[role=button],input[type=submit]") && /^(submit|confirm|ok|yes|continue|save|apply)$/i.test(label)),
            manual: /^(i(?:'m| am) not a robot|verify (?:that )?you(?:'re| are) human)[.!?\s]*$/i.test(label) ||
                ((document.body?.innerText?.length ?? 0) < 2500 && /(^|\n)\s*(verify (?:that )?you(?:'re| are) human|complete (?:the )?captcha|i(?:'m| am) not a robot)[.!?\s]*(\n|$)/im.test(document.body?.innerText || "")),
            incomplete: fields.length > 200 || nearby.length > 30000 || proofFields.some(([, , , , , , value]) => value.length === 20000)
        };
    }
    if (operation === "snapshot") {
        const snapshotId = crypto.randomUUID();
        const nodes = new Map(), elements = [], extraText = [], frames = [];
        let total = 0;
        const shadowText = root => {
            const walker = document.createTreeWalker(root, 4), text = [];
            let node;
            while ((node = walker.nextNode())) {
                const parent = node.parentElement || root.host;
                if (parent && !parent.closest("script,style,noscript") && visible(parent)) text.push(node.textContent);
            }
            return text.join(" ").replace(/\s+/g, " ").trim();
        };
        const visit = root => {
            for (const el of root.querySelectorAll("*")) {
                if (el.shadowRoot) { extraText.push(shadowText(el.shadowRoot)); visit(el.shadowRoot); }
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
    if (operation === "typing-status") {
        const el = entry?.element;
        let focused = !!el?.isConnected && !el.disabled && !el.readOnly && el.getAttribute("aria-disabled") !== "true" &&
            (el.isContentEditable || signature(el) === entry.signature) &&
            (el.isContentEditable || (el.matches("input,textarea") && !["file", "checkbox", "radio", "range", "button", "submit"].includes(el.type))) && visible(el) &&
            (el.ownerDocument.activeElement === el || el.getRootNode().activeElement === el);
        let win = el?.ownerDocument.defaultView;
        while (focused && win && win !== window) {
            const frame = win.frameElement;
            focused = !!frame && (frame.ownerDocument.activeElement === frame || frame.getRootNode().activeElement === frame);
            win = win.parent;
        }
        return { focused: !!focused };
    }
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
