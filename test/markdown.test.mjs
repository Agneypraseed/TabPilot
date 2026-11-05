import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const source = (await Promise.all(["vendor/marked.js", "vendor/purify.js", "markdown.js"]
    .map(path => readFile(new URL(`../${path}`, import.meta.url), "utf8")))).join("\n");

function render(text) {
    const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
    dom.window.eval(source);
    const element = dom.window.document.querySelector("main");
    dom.window.TabPilotMarkdown.render(element, text);
    return element;
}

test("replies render headings, nested lists, emphasis, links, tables and literal code", () => {
    const element = render('# Results\n\n**Match results** and *notes*.\n\n- Liverpool\n  - 3 goals\n\n1. Check [source](https://example.com/?a=1&b=2).\n\n| Club | Goals |\n| --- | --- |\n| Liverpool | 3 |\n\n```html\n<script>alert(1)</script>\n```');
    assert.equal(element.querySelector("h1").textContent, "Results");
    assert.equal(element.querySelector("strong").textContent, "Match results");
    assert.equal(element.querySelectorAll("ul ul li").length, 1);
    assert.equal(element.querySelectorAll("ol li").length, 1);
    assert.equal(element.querySelector(".reply-table td").textContent, "Liverpool");
    assert.match(element.querySelector("pre code").textContent, /<script>/);
    assert.equal(element.querySelector("a").getAttribute("rel"), "noopener noreferrer");
    assert.equal(element.querySelector("a").getAttribute("href"), "https://example.com/?a=1&b=2");
});

test("raw HTML, executable URLs, remote images and extension links cannot become active content", () => {
    const element = render('<img src="https://tracker.example/pixel" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n<svg onload="alert(1)"></svg>\n\n[bad](javascript:alert%281%29) [data](data:text/html,hello) [extension](chrome-extension://id/page) [relative](/settings) [credentials](https://name:secret@example.com/)\n\n![tracking](https://tracker.example/pixel)\n\n[good](https://example.com/)');
    assert.equal(element.querySelector("script, img, svg, iframe, form, input, style"), null);
    assert.equal(element.querySelectorAll("a").length, 1);
    assert.equal(element.querySelector("a").textContent, "good");
    assert.match(element.textContent, /<img/);
    assert.equal(element.querySelector("[onerror], [onload]"), null);
});
