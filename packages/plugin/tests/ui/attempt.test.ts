import { afterEach, describe, expect, it, vi } from "vitest";

import { attempt } from "@/ui/common";

afterEach(() => vi.restoreAllMocks());

describe("attempt", () => {
	it("turns a rejection into a logged notice instead of an unhandled one", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);

		attempt(Promise.reject(new Error("boom")), "Could not open the diff");
		await new Promise((resolve) => setTimeout(resolve, 0));
		process.off("unhandledRejection", unhandled);

		expect(error).toHaveBeenCalledOnce();
		expect(unhandled).not.toHaveBeenCalled();
	});
});
