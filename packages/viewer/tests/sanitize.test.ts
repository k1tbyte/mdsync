import { describe, expect, it } from "vitest";

import { sanitizeNote } from "../src/sanitize";

function render(html: string): HTMLElement {
	const host = document.createElement("div");
	host.append(sanitizeNote(html));
	return host;
}

describe("sanitizeNote", () => {
	it("drops scripts, handlers and frames", () => {
		const host = render(
			'<p onclick="x()">hi</p><script>alert(1)</script><iframe src="https://e.x"></iframe><img src="data:image/png;base64,AAAA" onerror="x()">',
		);
		expect(host.querySelector("script, iframe")).toBeNull();
		expect(host.querySelector("p")?.getAttribute("onclick")).toBeNull();
		expect(host.querySelector("img")?.getAttribute("onerror")).toBeNull();
		expect(host.textContent).toBe("hi");
	});

	it("opens external links in a new tab without a referrer", () => {
		const link = render('<a href="https://example.com/a">a</a>').querySelector(
			"a",
		);
		expect(link?.getAttribute("href")).toBe("https://example.com/a");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
	});

	it("keeps in-page and mail links, and drops vault paths and script urls", () => {
		const host = render(
			'<a href="#fn-1">1</a><a href="mailto:a@b.c">m</a><a href="Notes/Other.md">v</a><a href="javascript:alert(1)">j</a><a href="app://local/x">l</a>',
		);
		const hrefs = [...host.querySelectorAll("a")].map((a) =>
			a.getAttribute("href"),
		);
		expect(hrefs).toEqual(["#fn-1", "mailto:a@b.c", null, null, null]);
	});

	it("keeps embedded and https images and drops every other source", () => {
		const host = render(
			'<img src="data:image/png;base64,AAAA"><img src="https://example.com/i.png"><img src="app://local/i.png"><img src="Attachments/i.png"><img src="http://example.com/i.png"><img src="data:text/html;base64,AAAA">',
		);
		expect(
			[...host.querySelectorAll("img")].map((img) => img.getAttribute("src")),
		).toEqual(["data:image/png;base64,AAAA", "https://example.com/i.png"]);
	});

	it("drops srcset so an image cannot reach another source", () => {
		const img = render(
			'<img src="data:image/png;base64,AAAA" srcset="https://e.x/a.png 2x">',
		).querySelector("img");
		expect(img?.hasAttribute("srcset")).toBe(false);
	});

	it("keeps what Obsidian's reading view is made of", () => {
		const host = render(
			'<div class="callout is-collapsible" data-callout="tip"><div class="callout-title"><div class="callout-icon"><svg viewBox="0 0 24 24"><path d="M1 1"></path></svg></div></div></div><table><tr><td>x</td></tr></table><mark>m</mark><pre><code class="language-ts"><span class="token keyword">const</span></code></pre><ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked> done</li></ul>',
		);
		expect(
			host.querySelector('.callout[data-callout="tip"] svg path'),
		).not.toBeNull();
		expect(host.querySelector("table td")?.textContent).toBe("x");
		expect(host.querySelector("mark")).not.toBeNull();
		expect(host.querySelector(".token.keyword")?.textContent).toBe("const");
	});

	it("locks task checkboxes and removes form controls", () => {
		const host = render(
			'<input type="checkbox"><form action="https://e.x"><button>go</button><textarea></textarea></form>',
		);
		expect(host.querySelector("input")?.hasAttribute("disabled")).toBe(true);
		expect(host.querySelector("form, button, textarea")).toBeNull();
	});

	it("keeps MathML and drops what could run inside it", () => {
		const host = render(
			'<p><math display="block"><mfrac><mi>a</mi><mi>b</mi></mfrac><script>alert(1)</script></math></p>',
		);
		expect(host.querySelector("math[display=block] mfrac mi")).not.toBeNull();
		expect(host.querySelector("script")).toBeNull();
	});

	it("keeps inline svg and drops script inside it", () => {
		const host = render(
			'<svg><script>alert(1)</script><rect width="2" height="2"></rect></svg>',
		);
		expect(host.querySelector("svg rect")).not.toBeNull();
		expect(host.querySelector("script")).toBeNull();
	});
});
