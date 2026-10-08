import { FakeStorage } from "@tests/helpers/fake-storage";
import { describe, expect, it } from "vitest";
import { decryptBytes, encryptBytes } from "@/crypto";
import { REMOTE_KEYFILE_KEY } from "@/sync/constants";
import {
	type Keyfile,
	PassphraseRotatedError,
	readKeyfile,
	resolveContentKey,
	rotatePassphrase,
} from "@/sync/keyfile";

async function roundTrip(storage: FakeStorage, passphrase: string) {
	const { contentKey } = await resolveContentKey(storage, passphrase);
	const blob = await encryptBytes(contentKey, new TextEncoder().encode("hi"));
	return new TextDecoder().decode(await decryptBytes(contentKey, blob));
}

describe("keyfile envelope", () => {
	it("creates a keyfile on first resolve and round-trips content", async () => {
		const storage = new FakeStorage();
		expect(await roundTrip(storage, "long enough pw")).toBe("hi");

		const kf = (await readKeyfile(storage)) as Keyfile;
		expect(kf.epoch).toBe(1);
		expect(kf.version).toBe(1);
		expect(kf.wrapped.length).toBeGreaterThan(0);
	});

	it("returns the same data key across resolves with the same passphrase", async () => {
		const storage = new FakeStorage();
		const a = await resolveContentKey(storage, "long enough pw");
		const b = await resolveContentKey(storage, "long enough pw");
		const blob = await encryptBytes(
			a.contentKey,
			new TextEncoder().encode("x"),
		);
		expect(
			new TextDecoder().decode(await decryptBytes(b.contentKey, blob)),
		).toBe("x");
	});

	it("rejects a wrong passphrase with PassphraseRotatedError", async () => {
		const storage = new FakeStorage();
		await resolveContentKey(storage, "the right passphrase");
		await expect(
			resolveContentKey(storage, "the wrong passphrase"),
		).rejects.toBeInstanceOf(PassphraseRotatedError);
	});

	it("rotation re-wraps the same data key under a new passphrase", async () => {
		const storage = new FakeStorage();
		const before = await resolveContentKey(storage, "the old passphrase");
		const seeded = await encryptBytes(
			before.contentKey,
			new TextEncoder().encode("payload"),
		);

		const newEpoch = await rotatePassphrase(
			storage,
			"the old passphrase",
			"the new passphrase",
		);
		expect(newEpoch).toBe(2);

		await expect(
			resolveContentKey(storage, "the old passphrase"),
		).rejects.toBeInstanceOf(PassphraseRotatedError);

		const after = await resolveContentKey(storage, "the new passphrase");
		expect(after.epoch).toBe(2);
		expect(
			new TextDecoder().decode(await decryptBytes(after.contentKey, seeded)),
		).toBe("payload");
	});

	it("rotation with a wrong current passphrase throws and does not change the keyfile", async () => {
		const storage = new FakeStorage();
		await resolveContentKey(storage, "the old passphrase");
		const original = storage.map.get(REMOTE_KEYFILE_KEY);

		await expect(
			rotatePassphrase(storage, "bogus passphrase", "the new passphrase"),
		).rejects.toBeInstanceOf(PassphraseRotatedError);
		expect(storage.map.get(REMOTE_KEYFILE_KEY)).toBe(original);
	});
});

describe("passphrase strength", () => {
	it("refuses a short passphrase for a new key and for a new wrapping", async () => {
		const storage = new FakeStorage();
		await expect(resolveContentKey(storage, "short")).rejects.toThrow(
			/at least 12 characters/,
		);
		expect(await readKeyfile(storage)).toBeNull();

		await resolveContentKey(storage, "long enough pw");
		await expect(
			rotatePassphrase(storage, "long enough pw", "short"),
		).rejects.toThrow(/at least 12 characters/);
	});

	it("opens the key with a passphrase typed in another Unicode form", async () => {
		const storage = new FakeStorage();
		const composed = "mot de passe déjà plus long";
		const { contentKey } = await resolveContentKey(storage, composed);
		const blob = await encryptBytes(contentKey, new Uint8Array([1]));

		const other = await resolveContentKey(storage, composed.normalize("NFD"));

		expect(composed.normalize("NFD")).not.toBe(composed);
		expect(await decryptBytes(other.contentKey, blob)).toEqual(
			new Uint8Array([1]),
		);
	});
});
