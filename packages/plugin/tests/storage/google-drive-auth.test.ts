import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultGoogleDriveConfig,
	googleLoginUrl,
	handleGoogleDriveProtocol,
} from "@/storage/adapters/google-drive-auth";

const TOKENS = { access_token: "at", refresh_token: "rt", expires_in: "3600" };
const AUTH = "https://auth.example";

afterEach(() => {
	vi.restoreAllMocks();
});

function nonceOf(url: string): string {
	return new URL(url).searchParams.get("nonce") ?? "";
}

async function callback(params: Record<string, string>) {
	const config = defaultGoogleDriveConfig();
	const save = vi.fn(async () => {});
	const outcome = await handleGoogleDriveProtocol(
		{ action: "obsync-auth", ...params },
		config,
		save,
	);
	return { outcome, config, save };
}

describe("Google Drive sign-in callback", () => {
	it("takes the tokens of the sign-in this device started, once", async () => {
		const nonce = nonceOf(googleLoginUrl({ authServerUrl: AUTH }));

		const first = await callback({ ...TOKENS, nonce });
		const replay = await callback({ ...TOKENS, nonce });
		// Nothing pending and no nonce: refused, not a TypeError.
		const bare = await callback(TOKENS);

		expect(first.outcome).toMatchObject({ ok: true });
		expect(first.config.refreshToken).toBe("rt");
		expect(replay.outcome).toMatchObject({ ok: false });
		expect(replay.save).not.toHaveBeenCalled();
		expect(bare.outcome).toMatchObject({ ok: false });
	});

	it("ignores tokens from a link this device did not start", async () => {
		googleLoginUrl({ authServerUrl: AUTH });

		for (const params of [TOKENS, { ...TOKENS, nonce: "f".repeat(32) }]) {
			const { outcome, config, save } = await callback(params);
			expect(outcome).toMatchObject({ ok: false });
			expect(config.refreshToken).toBe("");
			expect(save).not.toHaveBeenCalled();
		}
	});

	it("ignores a sign-in that took longer than the relay keeps its state", async () => {
		const nonce = nonceOf(googleLoginUrl({ authServerUrl: AUTH }));
		const later = Date.now() + 11 * 60 * 1000;
		vi.spyOn(Date, "now").mockReturnValue(later);

		const { outcome, save } = await callback({ ...TOKENS, nonce });

		expect(outcome).toMatchObject({ ok: false });
		expect(save).not.toHaveBeenCalled();
	});
});
