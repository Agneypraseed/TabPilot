// Local, sanitized Markdown shared by live replies and saved History.
(() => {
    const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const parser = new marked.Marked({ gfm: true, breaks: true, renderer: {
        html: ({ text }) => escape(text),
        // Images from model output must not make remote requests.
        image: ({ text }) => escape(text || "Image"),
    } });
    globalThis.TabPilotMarkdown = {
        render(element, value) {
            const text = String(value ?? "");
            if (!DOMPurify.isSupported) { element.textContent = text; return; }
            const fragment = DOMPurify.sanitize(parser.parse(text), {
                ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "h1", "h2", "h3", "h4", "h5", "h6",
                    "ul", "ol", "li", "blockquote", "pre", "code", "a", "hr", "table", "thead", "tbody", "tr", "th", "td"],
                ALLOWED_ATTR: ["href", "title", "start"],
                ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
                RETURN_DOM_FRAGMENT: true,
            });
            for (const link of fragment.querySelectorAll("a")) {
                const href = link.getAttribute("href") || "";
                let safe = false;
                try {
                    const url = new URL(href);
                    safe = /^https?:\/\//i.test(href) && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
                } catch {}
                if (!safe) { link.replaceWith(element.ownerDocument.createTextNode(link.textContent)); continue; }
                link.setAttribute("target", "_blank");
                link.setAttribute("rel", "noopener noreferrer");
                link.setAttribute("referrerpolicy", "no-referrer");
            }
            for (const table of [...fragment.querySelectorAll("table")]) {
                const wrapper = element.ownerDocument.createElement("div");
                wrapper.className = "reply-table";
                wrapper.setAttribute("tabindex", "0");
                wrapper.setAttribute("role", "region");
                wrapper.setAttribute("aria-label", "Results table");
                table.replaceWith(wrapper);
                wrapper.append(table);
            }
            element.classList.add("formatted-reply");
            element.replaceChildren(fragment);
        },
    };
})();
