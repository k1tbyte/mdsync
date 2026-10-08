import { describe, expect, it } from "vitest";
import { linkError } from "@/links/errors";
import { StorageRequestError } from "@/storage";

describe("linkError", () => {
	it("uses the storage refusal's user-facing message", () => {
		const refused = new StorageRequestError("HTTP 401", "Check the secret.");
		const error = linkError(refused);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Check the secret.");
		expect(error).not.toBe(refused);
	});

	it("passes an ordinary Error through unchanged", () => {
		const error = new Error("Network failure");

		expect(linkError(error)).toBe(error);
	});

	it.each([
		["plain failure", "plain failure"],
		[{ message: "Relay failure" }, "Relay failure"],
		[42, "42"],
		[null, "null"],
	])("wraps a non-Error throwable %#", (value, message) => {
		const error = linkError(value);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe(message);
	});
});
