import { describe, expect, it } from "vitest";

import { clientOf, networkOf } from "../../src/link/client";

const request = (address?: string) =>
	new Request("https://relay.example.com/link/x/open", {
		headers: address ? { "CF-Connecting-IP": address } : {},
	});

describe("networkOf", () => {
	it("keeps an IPv4 address whole", () => {
		expect(networkOf("203.0.113.7")).toBe("203.0.113.7");
	});

	it("reduces an IPv6 address to its /64, however it is written", () => {
		const network = "2001:db8:abcd:12";
		expect(networkOf("2001:db8:abcd:12::1")).toBe(network);
		expect(networkOf("2001:0db8:abcd:0012:ffff:ffff:ffff:ffff")).toBe(network);
		expect(networkOf("2001:DB8:ABCD:12:1:2:3:4")).toBe(network);
		expect(networkOf("2001:db8::")).toBe("2001:db8:0:0");
		expect(networkOf("::1")).toBe("0:0:0:0");
	});
});

describe("clientOf", () => {
	it("groups the addresses of one /64 and tells networks apart", async () => {
		const a = await clientOf(request("2001:db8:abcd:12::1"));
		expect(await clientOf(request("2001:db8:abcd:12::beef"))).toBe(a);
		expect(await clientOf(request("2001:db8:abcd:13::1"))).not.toBe(a);
		expect(await clientOf(request("203.0.113.7"))).not.toBe(a);
	});

	it("is opaque and fixed in length, and has a bucket for no address", async () => {
		const client = await clientOf(request("203.0.113.7"));
		expect(client).toMatch(/^[0-9a-f]{16}$/);
		expect(client).not.toContain("203");
		expect(await clientOf(request())).toMatch(/^[0-9a-f]{16}$/);
	});
});
