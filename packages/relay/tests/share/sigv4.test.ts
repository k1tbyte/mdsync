import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPresigner,
	presignS3,
	type S3Target,
} from "../../src/share/sigv4";

function target(overrides: Partial<S3Target> = {}): S3Target {
	return {
		endpoint: "https://s3.example.com",
		region: "us-east-1",
		bucket: "vault-bucket",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		forcePathStyle: true,
		...overrides,
	};
}

describe("presignS3", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2013-05-24T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("matches the signature AWS documents for its presigned GET example", async () => {
		const url = await presignS3(
			target({
				endpoint: "https://s3.amazonaws.com",
				bucket: "examplebucket",
				forcePathStyle: false,
			}),
			"GET",
			"test.txt",
			86400,
		);
		expect(signatureOf(url)).toBe(
			"aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
		);
	});

	it("signs with the secret it is given, so a rotated secret under the same key id takes effect at once", async () => {
		const [before, after] = [
			await presignS3(target(), "GET", "shares/abc/o", 120),
			await presignS3(
				target({ secretAccessKey: "rotated-secret" }),
				"GET",
				"shares/abc/o",
				120,
			),
		];
		expect(signatureOf(before)).not.toBe(signatureOf(after));
	});

	it("produces a signed URL with the required query parameters", async () => {
		const url = new URL(
			await presignS3(target(), "GET", "shares/abc/objects/deadbeef", 120),
		);
		expect(url.pathname).toBe("/vault-bucket/shares/abc/objects/deadbeef");
		expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
		expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
		expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
		expect(url.searchParams.get("X-Amz-Credential")).toContain(
			"AKIAIOSFODNN7EXAMPLE/",
		);
		expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("binds the signature to the key, so a participant cannot swap it", async () => {
		const [mine, other] = await Promise.all([
			presignS3(target(), "GET", "shares/abc/objects/a", 120),
			presignS3(target(), "GET", "shares/xyz/objects/a", 120),
		]);
		expect(signatureOf(mine)).not.toBe(signatureOf(other));
	});

	it("binds the signature to the method", async () => {
		const [get, put] = await Promise.all([
			presignS3(target(), "GET", "shares/abc/o", 120),
			presignS3(target(), "PUT", "shares/abc/o", 120),
		]);
		expect(signatureOf(get)).not.toBe(signatureOf(put));
	});

	it("binds the signature to extra query parameters such as the list prefix", async () => {
		const [mine, other] = await Promise.all([
			presignS3(target(), "GET", "", 120, {
				"list-type": "2",
				prefix: "shares/abc/",
			}),
			presignS3(target(), "GET", "", 120, {
				"list-type": "2",
				prefix: "shares/xyz/",
			}),
		]);
		expect(signatureOf(mine)).not.toBe(signatureOf(other));
	});

	it("uses a virtual-hosted host when path style is off", async () => {
		const url = new URL(
			await presignS3(
				target({ forcePathStyle: false }),
				"GET",
				"shares/abc/o",
				120,
			),
		);
		expect(url.host).toBe("vault-bucket.s3.example.com");
		expect(url.pathname).toBe("/shares/abc/o");
	});

	it("keeps an endpoint's own base path", async () => {
		const url = new URL(
			await presignS3(
				target({ endpoint: "https://minio.example.com/s3/" }),
				"GET",
				"shares/abc/o",
				120,
			),
		);
		expect(url.pathname).toBe("/s3/vault-bucket/shares/abc/o");
	});
});

function signatureOf(url: string): string {
	return new URL(url).searchParams.get("X-Amz-Signature") ?? "";
}

describe("createPresigner", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2013-05-24T00:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("signs each url exactly like presignS3", async () => {
		const presign = createPresigner(target(), 120);
		const query = { "list-type": "2", prefix: "shares/abc/" };
		expect(await presign("GET", "shares/abc/o1")).toBe(
			await presignS3(target(), "GET", "shares/abc/o1", 120),
		);
		expect(await presign("PUT", "shares/abc/o2")).toBe(
			await presignS3(target(), "PUT", "shares/abc/o2", 120),
		);
		expect(await presign("GET", "", query)).toBe(
			await presignS3(target(), "GET", "", 120, query),
		);
	});

	it("keeps the date it was created at", async () => {
		const presign = createPresigner(target(), 120);
		const first = await presign("GET", "shares/abc/o");
		vi.setSystemTime(new Date("2013-05-25T06:30:00Z"));
		const later = await presign("GET", "shares/abc/o");

		expect(later).toBe(first);
		expect(new URL(later).searchParams.get("X-Amz-Date")).toBe(
			"20130524T000000Z",
		);
	});

	it("derives the signing key once, however many urls run in parallel", async () => {
		const importKey = vi.spyOn(crypto.subtle, "importKey");
		await presignS3(target(), "GET", "shares/abc/o", 120);
		const perKey = importKey.mock.calls.length;
		importKey.mockClear();

		const presign = createPresigner(target(), 120);
		await Promise.all(
			Array.from({ length: 16 }, (_, index) =>
				presign("GET", `shares/abc/o${index}`),
			),
		);
		await presign("GET", "shares/abc/later");
		expect(importKey).toHaveBeenCalledTimes(perKey);
	});

	it("derives no key until the first url", () => {
		const importKey = vi.spyOn(crypto.subtle, "importKey");
		createPresigner(target(), 120);
		expect(importKey).not.toHaveBeenCalled();
	});
});
