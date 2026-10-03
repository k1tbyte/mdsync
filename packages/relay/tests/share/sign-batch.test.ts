import { SIGN_BATCH_MAX } from "@mdsync/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShareEnv } from "../../src/share/kv";
import { EShareRole } from "../../src/share/kv";
import {
	call,
	issue,
	makeEnv,
	register,
	registeredEnv,
	SHARE,
	STORAGE,
	sign,
} from "../helpers/share-env";

describe("batch signing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const objectKeys = (count: number) =>
		Array.from({ length: count }, (_, index) => `objects/o${index}`);

	async function batch(env: ShareEnv, token: string, keys: unknown) {
		const response = await sign(env, token, { op: "get", keys });
		return {
			response,
			body: (await response.json()) as {
				urls?: string[];
				method?: string;
				error?: string;
			},
		};
	}

	it("signs every key under the share, in order", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		const keys = objectKeys(5);
		const { response, body } = await batch(env, token, keys);

		expect(response.status).toBe(200);
		expect(body.method).toBe("GET");
		expect(body.urls?.map((url) => new URL(url).pathname)).toEqual(
			keys.map((key) => `/bucket/vault/shares/share1/${key}`),
		);
	});

	it("signs one date for the batch and each url like the single form", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2024-03-05T10:00:00Z"));
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		const keys = objectKeys(4);
		const { body } = await batch(env, token, keys);

		for (const [index, key] of keys.entries()) {
			const single = (await (
				await sign(env, token, { op: "get", key })
			).json()) as { url: string };
			expect(body.urls?.[index]).toBe(single.url);
		}
		const dates = new Set(
			body.urls?.map((url) => new URL(url).searchParams.get("X-Amz-Date")),
		);
		expect([...dates]).toEqual(["20240305T100000Z"]);
	});

	it("takes the most keys it allows and no more", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");

		const full = await batch(env, token, objectKeys(SIGN_BATCH_MAX));
		expect(full.response.status).toBe(200);
		expect(full.body.urls).toHaveLength(SIGN_BATCH_MAX);

		const over = await batch(env, token, objectKeys(SIGN_BATCH_MAX + 1));
		expect(over.response.status).toBe(400);
		expect(over.body.error).toBe("bad_request");
	});

	it("refuses the whole batch when one key is unsafe", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		for (const bad of [
			"../x",
			"objects/..%2f..%2fsecret",
			"/etc/passwd",
			"a\\b",
			"",
		]) {
			const { response, body } = await batch(env, token, [
				"objects/a",
				bad,
				"objects/b",
			]);
			expect(response.status, bad).toBe(400);
			expect(body.error, bad).toBe("invalid_key");
			expect(body.urls, bad).toBeUndefined();
		}
	});

	it("refuses a keys field that is not 1 to 32 strings", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		for (const keys of [
			[],
			"objects/a",
			{ 0: "objects/a", length: 1 },
			null,
			7,
			["objects/a", 1],
			["objects/a", null],
			[["objects/a"]],
		]) {
			const { response, body } = await batch(env, token, keys);
			expect(response.status, JSON.stringify(keys)).toBe(400);
			expect(body.error, JSON.stringify(keys)).toBe("bad_request");
		}
	});

	it("refuses keys next to the single-object and listing fields", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		for (const extra of [
			{ key: "objects/a" },
			{ prefix: "objects/" },
			{ cursor: "c" },
			{ maxKeys: 5 },
		]) {
			const response = await sign(env, token, {
				op: "get",
				keys: ["objects/a"],
				...extra,
			});
			expect(response.status, Object.keys(extra)[0]).toBe(400);
		}
	});

	it("takes keys only with get or put", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		for (const op of ["delete", "list", "head", "post", undefined]) {
			const response = await sign(env, token, { op, keys: ["objects/a"] });
			expect(response.status, String(op)).toBe(400);
			expect(((await response.json()) as { error: string }).error).toBe(
				"bad_request",
			);
		}
	});

	it("signs PUT batches like individual PUTs, only within the share", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2024-03-05T10:00:00Z"));
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		const keys = objectKeys(3);
		const response = await sign(env, token, { op: "put", keys });
		const body = (await response.json()) as { urls: string[]; method: string };
		expect(body.method).toBe("PUT");
		for (const [index, key] of keys.entries()) {
			const single = (await (
				await sign(env, token, { op: "put", key })
			).json()) as { url: string };
			expect(body.urls[index]).toBe(single.url);
		}
		const unsafe = await sign(env, token, {
			op: "put",
			keys: ["objects/a", "../secret"],
		});
		expect(unsafe.status).toBe(400);
		expect(((await unsafe.json()) as { urls?: string[] }).urls).toBeUndefined();
	});

	it("refuses a read-only participant's entire PUT batch", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1", EShareRole.ReadOnly);
		const response = await sign(env, token, { op: "put", keys: objectKeys(3) });
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: "read_only" });
	});

	it("lets a read-only participant batch reads", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1", EShareRole.ReadOnly);
		const { response, body } = await batch(env, token, objectKeys(3));
		expect(response.status).toBe(200);
		expect(body.urls).toHaveLength(3);
	});

	it("refuses a bad token", async () => {
		const env = await registeredEnv();
		for (const token of ["", "garbage", "a".repeat(43)]) {
			const { response, body } = await batch(env, token, objectKeys(2));
			expect(response.status, token).toBe(401);
			expect(body.urls, token).toBeUndefined();
		}
	});

	it("answers 503 for a share whose owner has not registered storage", async () => {
		const env = makeEnv();
		const token = await issue(env, "p1");
		const { response, body } = await batch(env, token, objectKeys(2));
		expect(response.status).toBe(503);
		expect(body.error).toBe("storage_not_registered");
	});

	it("reads KV the same number of times however many keys it names", async () => {
		const env = await registeredEnv();
		const token = await issue(env, "p1");
		const get = vi.spyOn(env.SHARE_TOKENS, "get");

		const reads: number[] = [];
		for (const count of [1, 8, SIGN_BATCH_MAX]) {
			get.mockClear();
			await batch(env, token, objectKeys(count));
			reads.push(get.mock.calls.length);
		}
		expect(reads).toEqual([3, 3, 3]);
	});

	it("signs only the token's own share", async () => {
		const env = await registeredEnv();
		const other = { ...STORAGE, bucket: "other-bucket", prefix: "" };
		expect((await register(env, other, "share2")).status).toBe(200);
		const tokenOf = async (shareId: string) => {
			const response = await call(env, "/share/tokens", {
				method: "POST",
				admin: true,
				body: JSON.stringify({ shareId, participantId: "p1" }),
			});
			return ((await response.json()) as { token: string }).token;
		};
		const [first, second] = [await tokenOf(SHARE), await tokenOf("share2")];
		const keys = objectKeys(3);

		const mine = await batch(env, first, keys);
		const theirs = await batch(env, second, keys);
		expect(mine.body.urls?.map((url) => new URL(url).pathname)).toEqual(
			keys.map((key) => `/bucket/vault/shares/share1/${key}`),
		);
		expect(theirs.body.urls?.map((url) => new URL(url).pathname)).toEqual(
			keys.map((key) => `/other-bucket/shares/share2/${key}`),
		);

		const traversal = await batch(env, first, ["../share2/objects/o0"]);
		expect(traversal.body.error).toBe("invalid_key");
	});
});
