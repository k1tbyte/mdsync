import { FakeStorage } from "@tests/helpers/fake-storage";
import { describe, expect, it } from "vitest";
import { rememberUpload, uploadedHere } from "@/features/sync/remote/uploads";

describe("upload log", () => {
	it("keeps the newest 20 000 uploads, a re-upload counting as new", () => {
		const storage = new FakeStorage();
		rememberUpload(storage, "first");
		rememberUpload(storage, "second");
		for (let index = 0; index < 19_998; index++) {
			rememberUpload(storage, `chunks/${index}`);
		}
		rememberUpload(storage, "first");
		rememberUpload(storage, "newest");

		expect(uploadedHere(storage, "second")).toBe(false);
		expect(uploadedHere(storage, "first")).toBe(true);
		expect(uploadedHere(storage, "newest")).toBe(true);
	});
});
