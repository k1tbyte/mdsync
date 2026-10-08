import { describe, expect, it } from "vitest";

import { noteMarkdown } from "../src/markdown";
import { sanitizeNote } from "../src/sanitize";

const markdownOf = (html: string, title = "") =>
	noteMarkdown(title, sanitizeNote(html));

describe("noteMarkdown", () => {
	it("writes headings, emphasis, lists, links and fenced code", () => {
		const md = markdownOf(
			[
				"<h2>Lisbon</h2>",
				'<p>Landing in <strong>May</strong> with <em>a</em> <a href="https://example.com/map">map</a>.</p>',
				"<ul><li>one</li><li>two</li></ul>",
				'<pre class="language-ts"><code class="language-ts">const a = 1;</code></pre>',
			].join(""),
		);
		expect(md).toBe(
			[
				"## Lisbon",
				"",
				"Landing in **May** with _a_ [map](https://example.com/map).",
				"",
				"- one",
				"- two",
				"",
				"```ts",
				"const a = 1;",
				"```",
				"",
			].join("\n"),
		);
	});

	it("puts the note's name first when the page shows it", () => {
		expect(markdownOf("<p>Body</p>", "Trip notes")).toBe(
			"# Trip notes\n\nBody\n",
		);
	});

	it("keeps tables and task lists", () => {
		const md = markdownOf(
			[
				"<table><thead><tr><th>A</th><th>B</th></tr></thead>",
				"<tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
				'<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked> Book</li>',
				'<li class="task-list-item"><input type="checkbox"> Pack</li></ul>',
			].join(""),
		);
		expect(md).toContain("| A | B |");
		expect(md).toContain("| 1 | 2 |");
		expect(md).toContain("- [x] Book");
		expect(md).toContain("- [ ] Pack");
	});

	it("turns a callout into a quoted block with its type and fold", () => {
		const md = markdownOf(
			'<div class="callout is-collapsible is-collapsed" data-callout="tip"><div class="callout-title"><div class="callout-icon"><svg></svg></div><div class="callout-title-inner">Pack light</div></div><div class="callout-content"><p>Only a carry-on.</p><p>Two lines.</p></div></div>',
		);
		expect(md).toBe(
			"> [!tip]- Pack light\n> Only a carry-on.\n>\n> Two lines.\n",
		);
	});

	it("writes a formula back as the TeX it came from", () => {
		const md = markdownOf(
			'<p>Euler <math display="inline" data-tex="e^{i\\pi}"><mi>x</mi></math></p><math display="block" data-tex="a^2+b^2"><mi>y</mi></math>',
		);
		expect(md).toContain("Euler $e^{i\\pi}$");
		expect(md).toContain("$$\na^2+b^2\n$$");
	});

	it("nests and numbers lists", () => {
		const md = markdownOf(
			'<ol start="3"><li>three<ul><li>inner</li></ul></li><li>four</li></ol>',
		);
		expect(md).toBe("3. three\n   - inner\n4. four\n");
	});

	it("leaves out drawings and images that live in the page", () => {
		const md = markdownOf(
			'<p>Before</p><svg><text>diagram</text></svg><img src="data:image/png;base64,AAAA" alt="shot"><p>After <img src="https://example.com/a.png" alt="far"></p>',
		);
		expect(md).not.toContain("diagram");
		expect(md).not.toContain("data:");
		expect(md).toContain("![far](https://example.com/a.png)");
	});
});
