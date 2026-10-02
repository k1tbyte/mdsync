import { toHex } from "@obsync/protocol";
import type { ObsidianProtocolData } from "obsidian";
import { randomBytes } from "@/crypto";
import { relayBase } from "@/shared";
import {
	EStorageBackend,
	type GoogleDriveStorageConfig,
} from "@/storage/config";
import {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "@/storage/field-spec";
import type { StorageAuthOutcome } from "@/storage/types";

export function googleAuthUrl(
	config: Pick<GoogleDriveStorageConfig, "authServerUrl">,
	route: "/auth" | "/refresh",
): string {
	return `${relayBase(config.authServerUrl)}${route}`;
}

/** Matches the relay's state lifetime. */
const LOGIN_TTL_MS = 10 * 60 * 1000;

/** The sign-in this device started; stored, since a phone may evict Obsidian while the browser is in front. */
const PENDING_LOGIN_KEY = "obsync-google-login";

interface PendingLogin {
	nonce: string;
	until: number;
}

export function googleLoginUrl(
	config: Pick<GoogleDriveStorageConfig, "authServerUrl">,
): string {
	const pending: PendingLogin = {
		nonce: toHex(randomBytes(16)),
		until: Date.now() + LOGIN_TTL_MS,
	};
	window.localStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify(pending));
	return `${googleAuthUrl(config, "/auth")}?nonce=${pending.nonce}`;
}

/** One use: a replayed link finds nothing pending. */
function takeLogin(nonce: string | undefined): boolean {
	const stored = window.localStorage.getItem(PENDING_LOGIN_KEY);
	const pending = stored ? (JSON.parse(stored) as PendingLogin) : null;
	if (!nonce || pending?.nonce !== nonce || Date.now() > pending.until) {
		return false;
	}
	window.localStorage.removeItem(PENDING_LOGIN_KEY);
	return true;
}

export function computeExpiresAt(
	expiresIn: string | number | undefined,
): number {
	const seconds = Number(expiresIn);
	return Number.isFinite(seconds) ? Date.now() + seconds * 1000 : 0;
}

export async function handleGoogleDriveProtocol(
	params: ObsidianProtocolData,
	config: GoogleDriveStorageConfig,
	saveCallback: () => Promise<void>,
): Promise<StorageAuthOutcome | false> {
	if (!params.error && !params.access_token && !params.refresh_token) {
		return false;
	}
	// Any link can open obsidian://obsync-auth; a token from one would point this vault at another Drive.
	if (!takeLogin(params.nonce)) {
		return {
			ok: false,
			message: "Ignored a Google Drive sign-in this device did not start.",
		};
	}
	if (params.error) {
		return {
			ok: false,
			message: "Google Drive auth failed",
			detail: params.error,
		};
	}

	const accessToken = params.access_token;
	const refreshToken = params.refresh_token;
	if (!accessToken) {
		return {
			ok: false,
			message: "Google Drive auth failed - no access token received.",
		};
	}

	config.accessToken = accessToken;
	if (refreshToken) config.refreshToken = refreshToken;
	config.expiresAt = computeExpiresAt(params.expires_in);

	await saveCallback();
	// Success without refresh token leaves backend unconfigured and sync hanging.
	if (!config.refreshToken) {
		return {
			ok: false,
			message:
				"Google Drive returned no refresh token. Remove Obsync from your Google account permissions and connect again.",
		};
	}
	return { ok: true, message: "Connected to Google Drive." };
}

export function defaultGoogleDriveConfig(): GoogleDriveStorageConfig {
	return {
		kind: EStorageBackend.GoogleDrive,
		folderName: "ObsidianSync",
		authServerUrl: "",
		accessToken: "",
		refreshToken: "",
		expiresAt: 0,
		concurrency: 8,
	};
}

export function isGoogleDriveConfigured(
	config: GoogleDriveStorageConfig,
): boolean {
	return Boolean(
		config.folderName && config.authServerUrl && config.refreshToken,
	);
}

export function describeGoogleDriveTarget(
	config: GoogleDriveStorageConfig,
): string {
	return `Google Drive (${config.folderName})`;
}

export function googleDriveIdentity(config: GoogleDriveStorageConfig): string {
	return `gdrive|${config.folderName}`;
}

export const GOOGLE_DRIVE_FIELDS: ReadonlyArray<SettingsFieldSpec> = [
	{
		key: "folderName",
		name: "Folder Name",
		desc: "The name of the folder in your Google Drive root where data will be stored.",
		kind: EFieldKind.Text,
		placeholder: "ObsidianSync",
	},
	{
		key: "authServerUrl",
		name: "Auth server URL",
		desc: "Your relay (packages/relay) with GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET set. It exchanges Google auth codes for tokens.",
		kind: EFieldKind.Text,
		placeholder: "https://obsync-relay...workers.dev",
	},
	CONCURRENCY_FIELD,
];
