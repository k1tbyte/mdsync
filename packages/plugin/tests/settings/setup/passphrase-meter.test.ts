// @vitest-environment jsdom

import { installElementMethods } from "@tests/settings/setup/element-methods";
import { describe, expect, it } from "vitest";

import { MIN_PASSPHRASE_LENGTH } from "@/crypto/constants";
import {
	METER_BARS,
	passphraseMeter,
	passphraseStrength,
} from "@/settings/setup/passphrase-meter";

installElementMethods();

const chars = (count: number): string => "a".repeat(count);

describe("passphraseStrength", () => {
	it("lights nothing for an empty passphrase", () => {
		expect(passphraseStrength("").filled).toBe(0);
	});

	it("counts characters below the minimum", () => {
		expect(passphraseStrength(chars(5))).toEqual({
			filled: 1,
			label: `5 of ${MIN_PASSPHRASE_LENGTH} characters`,
		});
	});

	it("counts code points, as the minimum does", () => {
		expect(passphraseStrength("😀".repeat(MIN_PASSPHRASE_LENGTH)).filled).toBe(
			2,
		);
	});

	it("grows with length once the minimum is met", () => {
		const filled = [
			MIN_PASSPHRASE_LENGTH,
			MIN_PASSPHRASE_LENGTH + 4,
			MIN_PASSPHRASE_LENGTH + 10,
		].map((length) => passphraseStrength(chars(length)).filled);
		expect(filled).toEqual([2, 3, METER_BARS]);
	});
});

describe("passphraseMeter", () => {
	it("exposes the strength as a meter with a live label", () => {
		const parent = document.createElement("div");
		const update = passphraseMeter(parent, "");
		const meter = parent.querySelector('[role="meter"]');
		expect(meter?.getAttribute("aria-valuemin")).toBe("0");
		expect(meter?.getAttribute("aria-valuemax")).toBe(String(METER_BARS));
		expect(meter?.getAttribute("aria-valuenow")).toBe("0");
		update(chars(MIN_PASSPHRASE_LENGTH + 10));
		expect(meter?.getAttribute("aria-valuenow")).toBe(String(METER_BARS));
		expect(meter?.getAttribute("aria-valuetext")).toBe("Strong");
		expect(
			parent.querySelector(".mdsync-meter-label")?.getAttribute("aria-live"),
		).toBe("polite");
	});
});
