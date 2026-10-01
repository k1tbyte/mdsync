import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson } from "@/crypto";
import { shareKey, shareStorage } from "@/spaces/access";
import {
	createShare,
	ownerNameOf,
	ownerStorageConfig,
	renameOwner,
} from "@/spaces/owner";
import {
	isSpaceRecord,
	type ShareLocation,
	shareIdentity,
} from "@/spaces/record";
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

describe("the owner's name", () => {
	it("goes on every open share of theirs and names them there", () => {
		const team = createShare("Team", "laptop", S3, "");
		const closed = {
			...createShare("Old", "laptop", S3, ""),
			closed: true as const,
		};
		expect(shareIdentity(team).name).toBe("Owner");

		const renamed = renameOwner([team, closed], "Kit", "phone");

		expect(renamed[0]).toMatchObject({ rev: 2, author: "phone" });
		expect(shareIdentity(renamed[0] ?? team)).toEqual({
			person: "owner",
			name: "Kit",
		});
		expect(renamed[1]).toBe(closed);
		expect(ownerNameOf(renamed)).toBe("Kit");
		expect(isSpaceRecord(renamed[0])).toBe(true);
	});

	it("carries over to a share made later", () => {
		expect(ownerNameOf([])).toBe("");
		expect(shareIdentity(createShare("Docs", "laptop", S3, "Kit")).name).toBe(
			"Kit",
		);
	});
});

describe("a share its owner creates", () => {
	it("is a whole record named after its folder", () => {
		const share = createShare("Team/Docs", "laptop", S3, "");
		expect(isSpaceRecord(share)).toBe(true);
		expect(share).toMatchObject({ name: "Docs", root: "Team/Docs", rev: 1 });
	});

	it("carries its own key", async () => {
		const share = createShare("Docs", "laptop", S3, "");
		const other = createShare("Docs", "laptop", S3, "");
		const sealed = await encryptJson(await shareKey(share), { a: 1 });

		await expect(decryptJson(await shareKey(share), sealed)).resolves.toEqual({
			a: 1,
		});
		await expect(decryptJson(await shareKey(other), sealed)).rejects.toThrow();
	});

	it("sits under the owner's prefix with the device's own credentials", () => {
		const { location } = createShare("Docs", "laptop", S3, "").access as {
			location: ShareLocation;
		};
		const rotated = { ...S3, secretAccessKey: "new", prefix: "moved" };

		expect(ownerStorageConfig("id", location, rotated)).toEqual({
			...rotated,
			prefix: "vault/shares/id/",
		});
	});

	it("needs the device on S3", () => {
		const share = createShare("Docs", "laptop", S3, "");
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
