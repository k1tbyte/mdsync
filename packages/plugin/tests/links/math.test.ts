// @vitest-environment jsdom

import { installElementFactories } from "@tests/helpers/obsidian-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mathToMathML, tagMathSources } from "@/links/math";

installElementFactories();

interface FakeMathJax {
	tex2chtml: (source: string, options?: { display?: boolean }) => Element;
	tex2chtmlPromise: (
		source: string,
		options?: { display?: boolean },
	) => Promise<Element>;
	tex2mml: (source: string, options?: { display?: boolean }) => string;
}

const chtml = (): Element => {
	const node = document.createElement("mjx-container");
	node.append(document.createElement("mjx-math"));
	return node;
};

const fake: FakeMathJax = {
	tex2chtml: () => chtml(),
	tex2chtmlPromise: () => Promise.resolve(chtml()),
	tex2mml: (source, options) => {
		if (source === "\\bad") throw new Error("Undefined control sequence");
		return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${options?.display ? "block" : "inline"}"><mi>${source}</mi></math>`;
	},
};
const original = { ...fake };

beforeEach(() => {
	(window as unknown as { MathJax?: FakeMathJax }).MathJax = fake;
});

afterEach(() => {
	Object.assign(fake, original);
});

describe("math", () => {
	it("tags each formula with its TeX while held, and stops after release", async () => {
		const release = await tagMathSources("$x$");
		const inline = fake.tex2chtml("x", { display: false });
		const block = await fake.tex2chtmlPromise("y", { display: true });
		release();
		expect(inline.getAttribute("data-mdsync-tex")).toBe("x");
		expect(inline.hasAttribute("data-mdsync-display")).toBe(false);
		expect(block.getAttribute("data-mdsync-tex")).toBe("y");
		expect(block.hasAttribute("data-mdsync-display")).toBe(true);
		expect(fake.tex2chtml).toBe(original.tex2chtml);
		expect(fake.tex2chtml("z").hasAttribute("data-mdsync-tex")).toBe(false);
	});

	it("stays on until every holder has released", async () => {
		const first = await tagMathSources("$a$");
		const second = await tagMathSources("$b$");
		first();
		first();
		expect(fake.tex2chtml("x").hasAttribute("data-mdsync-tex")).toBe(true);
		second();
		expect(fake.tex2chtml).toBe(original.tex2chtml);
	});

	it("replaces tagged formulas with MathML and keeps the rest", async () => {
		const release = await tagMathSources("$x$");
		const root = document.createElement("div");
		root.append(
			fake.tex2chtml("x", { display: false }),
			fake.tex2chtml("y", { display: true }),
			document.createElement("mjx-container"),
		);
		release();
		mathToMathML(root);
		const maths = root.querySelectorAll("math");
		expect(maths).toHaveLength(2);
		expect(maths[0]?.getAttribute("display")).toBe("inline");
		expect(maths[1]?.getAttribute("display")).toBe("block");
		expect(maths[1]?.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
		expect(maths.item(0).getAttribute("data-tex")).toBe("x");
		expect(maths.item(1).getAttribute("data-tex")).toBe("y");
		expect(root.querySelectorAll("mjx-container")).toHaveLength(1);
		expect(root.querySelector("[data-mdsync-tex]")).toBeNull();
	});

	it("falls back to the TeX as code when MathJax cannot convert it", async () => {
		const release = await tagMathSources("$\\bad$");
		const root = document.createElement("div");
		root.append(fake.tex2chtml("\\bad"));
		release();
		mathToMathML(root);
		expect(root.querySelector("math")).toBeNull();
		expect(root.querySelector("code")?.textContent).toBe("\\bad");
	});
});
