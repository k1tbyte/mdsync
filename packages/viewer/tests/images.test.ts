import { describe, expect, it } from "vitest";

import { markLoneImages } from "../src/images";

const mark = (html: string): string[] => {
	const body = document.createElement("div");
	body.innerHTML = html;
	markLoneImages(body);
	return Array.from(body.querySelectorAll("p")).map((p) => p.className);
};

describe("markLoneImages", () => {
	it("marks a paragraph that holds only an image, wrapped or not", () => {
		expect(
			mark(
				'<p><img src="https://example.com/a.png"></p><p><span class="image-embed"><img src="https://example.com/b.png"></span></p>',
			),
		).toEqual(["lone-image", "lone-image"]);
	});

	it("leaves paragraphs with text, and text-only ones, alone", () => {
		expect(
			mark(
				'<p>See <img src="https://example.com/a.png"> here</p><p>Words</p><p> </p>',
			),
		).toEqual(["", "", ""]);
	});
});
