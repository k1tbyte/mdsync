import { describe, expect, it } from "vitest";
import { isRelayConfigured } from "@/core/settings/model";

describe("isRelayConfigured", () => {
	const secret = "s3cret";

	it.each([
		"https://relay.example",
		"http://localhost:8787",
		"http://127.0.0.1:8787/",
		"http://[::1]:8787",
	])("accepts %s", (relayUrl) => {
		expect(isRelayConfigured({ relayUrl, relaySecret: secret })).toBe(true);
	});

	it("needs both the URL and the secret", () => {
		expect(isRelayConfigured({ relayUrl: "", relaySecret: secret })).toBe(
			false,
		);
		expect(
			isRelayConfigured({ relayUrl: "https://relay.example", relaySecret: "" }),
		).toBe(false);
	});

	it("refuses a remote relay that would take the secret over plain http", () => {
		expect(
			isRelayConfigured({
				relayUrl: "http://relay.example",
				relaySecret: secret,
			}),
		).toBe(false);
	});
});
