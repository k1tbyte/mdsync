import { beforeEach, describe, expect, it, vi } from "vitest";
import { createS3Adapter } from "@/storage/adapters/s3";
import { EStorageBackend, type S3StorageConfig } from "@/storage/config";

interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: ArrayBuffer;
}

interface Reply {
	status: number;
	text?: string;
	arrayBuffer?: ArrayBuffer;
	headers?: Record<string, string>;
	error?: Error;
}

const requests: Recorded[] = [];
let replies: Reply[] = [];

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: (params: Recorded) => {
		requests.push(params);
		const reply = replies.shift() ?? { status: 200 };
		if (reply.error) return Promise.reject(reply.error);
		return Promise.resolve({
			status: reply.status,
			text: reply.text ?? "",
			arrayBuffer: reply.arrayBuffer ?? new ArrayBuffer(0),
			json: {},
			headers: reply.headers ?? {},
		});
	},
}));

function config(overrides: Partial<S3StorageConfig> = {}): S3StorageConfig {
	return {
		kind: EStorageBackend.S3,
		endpoint: "https://minio.example.com",
		region: "us-east-1",
		bucket: "vault",
		prefix: "",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		forcePathStyle: true,
		concurrency: 4,
		...overrides,
	};
}

function listing(keys: string[], nextToken?: string): string {
	const contents = keys
		.map((key) => `<Contents><Key>${key}</Key></Contents>`)
		.join("");
	const token = nextToken
		? `<NextContinuationToken>${nextToken}</NextContinuationToken>`
		: "";
	return `<ListBucketResult>${contents}${token}</ListBucketResult>`;
}

const NO_SUCH_BUCKET =
	"<Error><Code>NoSuchBucket</Code><Message>no bucket</Message></Error>";

beforeEach(() => {
	requests.length = 0;
	replies = [];
});

describe("S3 adapter over requestUrl", () => {
	it("reads an object and reports a missing one as absent", async () => {
		const adapter = createS3Adapter(config());
		replies = [
			{ status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer },
			{ status: 404, text: "<Error><Code>NoSuchKey</Code></Error>" },
		];

		expect(await adapter.get("a.bin")).toEqual(new Uint8Array([1, 2, 3]));
		expect(await adapter.get("b.bin")).toBeNull();
		expect(requests[0]?.url).toBe("https://minio.example.com/vault/a.bin");
	});

	it("refuses to call a missing bucket an empty vault", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 404, text: NO_SUCH_BUCKET }];

		// Absence means the object is gone. A bucket that is not there means the
		// configuration is wrong, and treating it as absence re-uploads the whole
		// vault into nowhere.
		await expect(adapter.get("a.bin")).rejects.toThrow("HTTP 404");
	});

	it("probes existence without downloading the object", async () => {
		const adapter = createS3Adapter(config());
		replies = [
			{ status: 200, text: listing(["a.bin"]) },
			{ status: 200, text: listing(["b.bin.suffix"]) },
		];

		expect(await adapter.exists("a.bin")).toBe(true);
		expect(await adapter.exists("b.bin")).toBe(false);
		expect(requests.map((r) => r.method)).toEqual(["GET", "GET"]);
		expect(requests[0]?.url).toContain("max-keys=1");
		expect(requests[0]?.url).toContain("prefix=a.bin");
	});

	it("shows a signature error instead of treating it as absence", async () => {
		const adapter = createS3Adapter(config());
		replies = [
			{
				status: 403,
				text: "<Error><Code>SignatureDoesNotMatch</Code></Error>",
			},
		];

		await expect(adapter.exists("objects/abc")).rejects.toMatchObject({
			name: "StorageRequestError",
			userMessage:
				"S3 rejected the request signature. Check the secret access key or re-import the storage settings.",
		});
	});

	it("reports a conditional write that lost the race", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 200 }, { status: 412 }];
		const body = new Uint8Array([7]);

		expect(await adapter.putIfAbsent("k", body)).toBe(true);
		expect(await adapter.putIfAbsent("k", body)).toBe(false);
		expect(requests[0]?.headers["If-None-Match"]).toBe("*");
	});

	it("does not hash an upload it is about to send", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 200 }];

		await adapter.put("k", new Uint8Array([1, 2, 3]), "application/json");

		expect(requests[0]?.headers["x-amz-content-sha256"]).toBe(
			"UNSIGNED-PAYLOAD",
		);
		expect(requests[0]?.headers["Content-Type"]).toBe("application/json");
		expect(new Uint8Array(requests[0]?.body as ArrayBuffer)).toEqual(
			new Uint8Array([1, 2, 3]),
		);
	});

	it("treats a delete of something already gone as done", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 404 }];

		await expect(adapter.delete("k")).resolves.toBeUndefined();
	});

	it("refuses a 404 that did not come from the bucket", async () => {
		const adapter = createS3Adapter(config());
		// A proxy or captive portal answering 404 is not the bucket saying the
		// object is gone; reading it as absence republishes over a live remote.
		replies = [{ status: 404, text: "<html><body>Not Found</body></html>" }];

		await expect(adapter.get("manifest.json.enc")).rejects.toThrow("HTTP 404");
	});

	it("stops a listing whose backend repeats a continuation token", async () => {
		const adapter = createS3Adapter(config());
		replies = [
			{ status: 200, text: listing(["objects/aa"], "SAME") },
			{ status: 200, text: listing(["objects/bb"], "SAME") },
		];

		await expect(adapter.list("objects/")).rejects.toThrow(/repeated/);
	});

	it("follows the continuation token to the end of a listing", async () => {
		const adapter = createS3Adapter(config());
		replies = [
			{ status: 200, text: listing(["objects/aa", "objects/bb"], "TOKEN") },
			{ status: 200, text: listing(["objects/cc"]) },
		];

		expect(await adapter.list("objects/")).toEqual([
			"objects/aa",
			"objects/bb",
			"objects/cc",
		]);
		expect(requests[0]?.url).toContain("list-type=2&prefix=objects%2F");
		expect(requests[1]?.url).toContain("continuation-token=TOKEN");
	});

	it("returns listed keys without the configured prefix", async () => {
		const adapter = createS3Adapter(config({ prefix: "vaults/mine" }));
		replies = [{ status: 200, text: listing(["vaults/mine/objects/aa"]) }];

		expect(await adapter.list("objects/")).toEqual(["objects/aa"]);
		expect(requests[0]?.url).toContain("prefix=vaults%2Fmine%2Fobjects%2F");
	});

	it("lists each object's etag with its key, across pages", async () => {
		const adapter = createS3Adapter(config({ prefix: "vaults/mine" }));
		const contents = (key: string, etag?: string) =>
			`<Contents><Key>vaults/mine/${key}</Key>${etag ? `<ETag>&quot;${etag}&quot;</ETag>` : ""}</Contents>`;
		replies = [
			{
				status: 200,
				text: `<ListBucketResult>${contents("spaces/a.json.enc", "e1")}${contents("spaces/b.json.enc")}<NextContinuationToken>T</NextContinuationToken></ListBucketResult>`,
			},
			{
				status: 200,
				text: `<ListBucketResult>${contents("spaces/c.json.enc", "e3")}</ListBucketResult>`,
			},
		];

		expect(await adapter.listWithEtags?.("spaces/")).toEqual([
			{ key: "spaces/a.json.enc", etag: '"e1"' },
			{ key: "spaces/b.json.enc", etag: null },
			{ key: "spaces/c.json.enc", etag: '"e3"' },
		]);
		expect(requests[1]?.url).toContain("continuation-token=T");
	});

	it("still refuses a repeated continuation token when listing etags", async () => {
		const adapter = createS3Adapter(config());
		replies = [
			{ status: 200, text: listing(["spaces/a"], "SAME") },
			{ status: 200, text: listing(["spaces/b"], "SAME") },
		];

		await expect(adapter.listWithEtags?.("spaces/")).rejects.toThrow(
			/repeated/,
		);
	});

	it("signs each attempt afresh so a retry is not refused for skew", async () => {
		// Only the clock and the retry delay are faked; signing is real
		// WebCrypto and has to keep resolving on its own.
		vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
		vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
		try {
			const adapter = createS3Adapter(config());
			replies = [{ status: 503 }, { status: 200, text: listing(["k"]) }];

			const pending = adapter.exists("k");
			await until(() => requests.length === 1);
			// A signature carries the minute it was made, and a request replayed
			// after a backoff would be refused for skew.
			vi.setSystemTime(new Date("2026-09-07T10:00:30Z"));
			await vi.advanceTimersByTimeAsync(600);
			await until(() => requests.length === 2);
			await vi.advanceTimersByTimeAsync(0);

			expect(await pending).toBe(true);
			expect(requests[0]?.headers["x-amz-date"]).toBe("20260907T100000Z");
			expect(requests[1]?.headers["x-amz-date"]).toBe("20260907T100030Z");
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries a closed stream PUT preserving bytes and eventual success", async () => {
		const adapter = createS3Adapter(config());
		replies = [
			{
				status: 0,
				error: new Error("Request Failed. IOException Stream closed"),
			},
			{ status: 200 },
		];
		const body = new Uint8Array([8, 9, 10]);

		await adapter.put("k", body);

		expect(requests.length).toBe(2);
		expect(new Uint8Array(requests[0]?.body as ArrayBuffer)).toEqual(body);
		expect(new Uint8Array(requests[1]?.body as ArrayBuffer)).toEqual(body);
	});

	it("exhausted closed stream includes S3 method/key context with bounded retries", async () => {
		const adapter = createS3Adapter(config());
		replies = Array.from({ length: 4 }, () => ({
			status: 0,
			error: new Error("Request Failed. IOException Stream closed"),
		}));

		await expect(adapter.put("k", new Uint8Array([1]))).rejects.toMatchObject({
			name: "StorageRequestError",
			message:
				'S3 PUT to "k" failed: Request Failed. IOException Stream closed',
			userMessage:
				"S3 request failed on this device. Check the connection and try again. See Obsync logs for details.",
		});
		expect(requests.length).toBe(4);
	}, 10_000);

	it.each([
		Object.assign(new Error("aborted"), { name: "AbortError" }),
		new DOMException("aborted", "AbortError"),
	])("preserves cancellation type and adds context: %s", async (abort) => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 0, error: abort }];

		const pending = adapter.get("k");
		await expect(pending).rejects.toThrow('S3 GET to "k" failed: aborted');
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await expect(pending).rejects.not.toBe(abort);
		expect(abort.message).toBe("aborted");
		expect(requests.length).toBe(1);
	});

	it("does not stack request context when the host reuses an error", async () => {
		const adapter = createS3Adapter(config());
		const shared = new DOMException("aborted", "AbortError");
		replies = [
			{ status: 0, error: shared },
			{ status: 0, error: shared },
		];

		await expect(adapter.get("first")).rejects.toThrow(
			'S3 GET to "first" failed: aborted',
		);
		await expect(adapter.get("second")).rejects.toThrow(
			'S3 GET to "second" failed: aborted',
		);
		expect(shared.message).toBe("aborted");
	});

	it("adds listing context to exhausted listing failures", async () => {
		const adapter = createS3Adapter(config());
		const abort = new Error("aborted");
		abort.name = "AbortError"; // non-retryable for quick failure
		replies = [{ status: 0, error: abort }];

		const pending = adapter.list("objects/");
		await expect(pending).rejects.toThrow("S3 GET to listing failed: aborted");
		expect(requests.length).toBe(1);
	});
});

describe("S3 conditional reads", () => {
	it("reports the validator with the body", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 200, headers: { ETag: '"abc"' } }];

		const read = await adapter.getIfChanged?.("manifest.json.enc", null);

		expect(read).toMatchObject({ status: "found", etag: '"abc"' });
		expect(requests[0]?.headers["If-None-Match"]).toBeUndefined();
	});

	it("sends the validator and reports an unchanged object", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 304 }];

		const read = await adapter.getIfChanged?.("manifest.json.enc", '"abc"');

		expect(read).toEqual({ status: "unchanged" });
		expect(requests[0]?.headers["If-None-Match"]).toBe('"abc"');
	});

	it("refuses a 304 nobody asked for, rather than reading it as absence", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 304 }];

		await expect(adapter.get("manifest.json.enc")).rejects.toThrow("304");
	});

	it("still reads a plain object", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 200, arrayBuffer: new Uint8Array([1, 2]).buffer }];

		expect(await adapter.get("objects/abc")).toEqual(new Uint8Array([1, 2]));
	});

	it("still reports a missing object as absent", async () => {
		const adapter = createS3Adapter(config());
		replies = [{ status: 404, text: "<Error><Code>NoSuchKey</Code></Error>" }];

		expect(await adapter.get("objects/abc")).toBeNull();
	});
});

/** A tick budget ran out under load; real time does not. */
const UNTIL_TIMEOUT_MS = 5000;

/** Lets real async work (WebCrypto) settle while the clock is frozen. */
async function until(done: () => boolean): Promise<void> {
	const deadline = performance.now() + UNTIL_TIMEOUT_MS;
	while (!done() && performance.now() < deadline) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	if (!done()) throw new Error("condition never became true");
}
