import { failure, fakeCloudflare } from "@tests/helpers/fake-cloudflare";
import { describe, expect, it } from "vitest";
import {
	accountRelays,
	freeRelayName,
	ownRelayName,
	relayBehind,
	relayNameError,
	relayUrlOf,
} from "@/cloudflare";

const A = "/accounts/acc";
const RELAYS = { taken: ["mdsync-relay", "other"], subdomain: "me" };
const RELAY_URL = "https://mdsync-relay.me.workers.dev";

describe("accountRelays", () => {
	it("lists every worker name and the account's workers.dev subdomain", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => ({
					result: [{ id: "mdsync-relay" }, { id: "unrelated" }],
				}),
			},
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => ({ result: { subdomain: "me" } }),
			},
		]);
		expect(await accountRelays(cf.api, "acc")).toEqual({
			taken: ["mdsync-relay", "unrelated"],
			subdomain: "me",
		});
	});

	it("keeps worker names when the account has no workers.dev subdomain", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => ({ result: [{ id: "other" }] }),
			},
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => failure(10007, 404),
			},
		]);
		expect(await accountRelays(cf.api, "acc")).toEqual({
			taken: ["other"],
			subdomain: null,
		});
	});

	it("propagates account lookup failures", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => failure(10005),
			},
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => ({ result: { subdomain: "me" } }),
			},
		]);
		await expect(accountRelays(cf.api, "acc")).rejects.toThrow(/10005/);
	});
});

describe("relay names and URLs", () => {
	it("builds the default or chosen worker URL only with a subdomain", () => {
		expect(relayUrlOf(RELAYS)).toBe(RELAY_URL);
		expect(relayUrlOf(RELAYS, "other")).toBe("https://other.me.workers.dev");
		expect(relayUrlOf({ taken: [], subdomain: null })).toBeNull();
	});

	it.each([
		[RELAY_URL, "mdsync-relay"],
		[`${RELAY_URL}/status?x=1`, "mdsync-relay"],
		["https://other.me.workers.dev", "other"],
		["https://missing.me.workers.dev", null],
		["https://mdsync-relay.someone-else.workers.dev", null],
		["https://mdsync-relay.me.workers.dev.evil.test", null],
		["https://mdsync-relay.notme.workers.dev", null],
		["https://nested.mdsync-relay.me.workers.dev", null],
		["https://relay.example", null],
		["not a URL", null],
	] as const)("recognizes an owned worker for %s as %s", (url, name) => {
		expect(ownRelayName(RELAYS, url)).toBe(name);
	});

	it("cannot claim an owned worker without an account subdomain", () => {
		expect(ownRelayName({ ...RELAYS, subdomain: null }, RELAY_URL)).toBeNull();
	});

	it.each([
		[[], "mdsync-relay"],
		[["unrelated", "mdsync-relay-2"], "mdsync-relay"],
		[["mdsync-relay"], "mdsync-relay-2"],
		[["mdsync-relay", "mdsync-relay-2", "mdsync-relay-4"], "mdsync-relay-3"],
	] as const)("chooses the first free relay name from %j", (taken, name) => {
		expect(freeRelayName(taken)).toBe(name);
	});

	it.each(["a", "0", "my-relay-2", "a".repeat(63)])(
		"accepts the available worker name %s",
		(name) => {
			expect(relayNameError(name, [])).toBeNull();
		},
	);

	it.each([
		"",
		"Relay",
		"my_relay",
		"my relay",
		"-relay",
		"relay-",
		"a.b",
		"é",
		"a".repeat(64),
	])("rejects the invalid worker name %s", (name) => {
		expect(relayNameError(name, [])).toBe(
			"Use lowercase letters, digits and dashes, up to 63.",
		);
	});

	it("rejects an existing worker name", () => {
		expect(relayNameError("other", RELAYS.taken)).toBe(
			"A worker with this name already exists.",
		);
	});
});

describe("relayBehind", () => {
	it.each([
		["1.2.0+abc", true],
		["abc", true],
		["1.3.0+other", true],
		["1.3.0+test", false],
		["1.4.0+test", false],
		["1.2.0+test", false],
		["test", false],
		["1.4.0+other", false],
		["1.3.1+other", false],
		["1.3+other", true],
		[null, false],
		[undefined, false],
		["", false],
	] as const)("against 1.3.0+test, %s is behind: %s", (deployed, behind) => {
		expect(relayBehind(deployed)).toBe(behind);
	});
});
