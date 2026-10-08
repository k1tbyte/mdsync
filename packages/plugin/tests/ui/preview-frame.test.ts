import { describe, expect, it } from "vitest";

import { previewDocument } from "@/ui/links/preview-frame";

describe("previewDocument", () => {
	it("wraps the note under a policy that allows no script and no remote style", () => {
		const page = previewDocument("<p>Hello</p>", false);
		expect(page).toContain("<p>Hello</p>");
		expect(page).toContain("default-src 'none'");
		expect(page).toContain("img-src data: https:");
		expect(page).not.toContain("script-src");
		expect(page).toContain("color-scheme:light");
	});

	it("follows a dark theme", () => {
		expect(previewDocument("", true)).toContain("color-scheme:dark");
	});
});
