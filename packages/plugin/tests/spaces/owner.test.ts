import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson } from "@/crypto";
import { shareKey, shareStorage } from "@/spaces/access";
import { createShare, ownerStorageConfig } from "@/spaces/owner";
import { isSpaceRecord, type ShareLocation } from "@/spaces/record";
import { EStorageBackend, type S3StorageConfig } from "@/storage";

const S3: S3StorageConfig = {
	kind: EStorageBackend.S3,
	endpoint: "https://s3.example",
	region: "auto",
	bucket: "notes",
	prefix: "/vault/",
	accessKeyId: "id",
	secretAccessKey: "secret",
	forcePathStyle: true,
	concurrency: 4,
};

describe("a share its owner creates", () => {
	it("is a whole record named after its folder", () => {
		const share = createShare("Team/Docs", "laptop", S3);
		expect(isSpaceRecord(share)).toBe(true);
		expect(share).toMatchObject({ name: "Docs", root: "Team/Docs", rev: 1 });
	});

	it("carries its own key", async () => {
		const share = createShare("Docs", "laptop", S3);
		const other = createShare("Docs", "laptop", S3);
		const sealed = await encryptJson(await shareKey(share), { a: 1 });

		await expect(decryptJson(await shareKey(share), sealed)).resolves.toEqual({
			a: 1,
		});
		await expect(decryptJson(await shareKey(other), sealed)).rejects.toThrow();
	});

	it("sits under the owner's prefix with the device's own credentials", () => {
		const { location } = createShare("Docs", "laptop", S3).access as {
			location: ShareLocation;
		};
		const rotated = { ...S3, secretAccessKey: "new", prefix: "moved" };

		expect(ownerStorageConfig("id", location, rotated)).toEqual({
			...rotated,
			prefix: "vault/shares/id/",
		});
	});

	it("needs the device on S3", () => {
		const share = createShare("Docs", "laptop", S3);
		const webdav = {
			kind: EStorageBackend.WebDAV,
			baseUrl: "https://dav.example",
			basePath: "",
			username: "u",
			password: "p",
			concurrency: 4,
		};
		expect(shareStorage(share, webdav, share.root)).toBeNull();
	});
});
