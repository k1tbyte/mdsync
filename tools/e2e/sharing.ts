/**
 * An owner and a friend with vaults of their own on one relay and in-memory S3, plus the share steps
 * scenarios take through the UI.
 */

import {
	CLEAN,
	clickMenuItem,
	closeModals,
	closeSettings,
	confirm,
	field,
	fill,
	loaded,
	openSettings,
	press,
	read,
	sync,
	toggle,
	unlock,
} from "./device";
import { check, poll, runScenario } from "./harness";
import { launchObsidian, type Obsidian } from "./obsidian";
import { startRelay } from "./relay";
import { type S3, startS3 } from "./s3";

const RELAY_PORT = 8799;
const S3_PORT = 8802;
const CDP_PORTS = { owner: 9223, friend: 9224 };
const SECRET = "e2e-secret";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

export interface SentInvite {
	link: string;
	password: string;
}

/** Settings of a vault kept under `prefix` in the scenario's bucket. */
export function s3Vault(s3: S3, prefix: string) {
	return {
		storageConfigs: {
			s3: {
				kind: "s3",
				endpoint: s3.url,
				region: "auto",
				bucket: s3.bucket,
				prefix,
				accessKeyId: prefix,
				secretAccessKey: prefix,
				forcePathStyle: true,
				concurrency: 4,
			},
		},
		activeStorageKind: "s3",
	};
}

/**
 * Both devices launched, unlocked and synced once, then `body`; a `guest` friend has no vault storage and
 * is only loaded.
 */
export function runSharing(
	name: string,
	files: { owner: Record<string, string>; friend: Record<string, string> },
	body: (owner: Obsidian, friend: Obsidian, s3: S3) => Promise<void>,
	{ guest = false } = {},
): Promise<never> {
	return runScenario(name, async () => {
		const relay = await startRelay(RELAY_PORT, SECRET);
		const s3 = await startS3(S3_PORT);
		const devices: Obsidian[] = [];
		try {
			const owner = await launchObsidian({
				port: CDP_PORTS.owner,
				settings: {
					...s3Vault(s3, "owner"),
					realtimeSync: true,
					relayUrl: relay.url,
					relaySecret: SECRET,
				},
				files: files.owner,
			});
			devices.push(owner);
			const friend = await launchObsidian({
				port: CDP_PORTS.friend,
				settings: {
					...(guest ? {} : s3Vault(s3, "friend")),
					realtimeSync: true,
				},
				files: files.friend,
			});
			devices.push(friend);
			await unlock(owner, "owner-passphrase");
			check("the owner syncs", await sync(owner), CLEAN);
			if (guest) await loaded(friend);
			else {
				await unlock(friend, "friend-passphrase");
				check("the friend syncs", await sync(friend), CLEAN);
			}
			await body(owner, friend, s3);
		} finally {
			relay.stop();
			s3.stop();
			await Promise.all(devices.map((device) => device.stop()));
		}
	});
}

/** Shares `folder` from its menu; resolves with the share's id once it is pushed. */
export async function shareFolder(
	owner: Obsidian,
	s3: S3,
	folder: string,
): Promise<string> {
	await clickMenuItem(owner, folder, "MDSync: Share folder");
	const id = (await owner.waitFor(
		"the share's record",
		() => app.plugins.plugins.mdsync.settings.spaces[0]?.id,
		(value: string | undefined) => value !== undefined,
	)) as string;
	await poll(
		"the share pushed",
		async () =>
			s3.keys().includes(`owner/shares/${id}/manifest.json.enc`) || undefined,
	);
	// Sharing opens the share's window for the first invite.
	await closeModals(owner);
	return id;
}

export async function invite(
	owner: Obsidian,
	folder: string,
	person: string,
	readOnly = false,
): Promise<SentInvite> {
	await clickMenuItem(owner, folder, "MDSync: Manage sharing");
	await fill(owner, "Name", person);
	if (readOnly) await toggle(owner, "Read-only");
	await press(owner, "Create invite");
	const link = await field(owner, "Link");
	const password = await field(owner, "Password");
	await closeModals(owner);
	return { link, password };
}

export async function accept(
	friend: Obsidian,
	sent: SentInvite,
	folder?: string,
): Promise<void> {
	await openInvite(friend, sent);
	if (folder) await fill(friend, "Folder", folder);
	await press(friend, "Add shared folder");
}

/** A new link for the share this device already has. */
export async function renew(friend: Obsidian, sent: SentInvite): Promise<void> {
	await openInvite(friend, sent);
	await press(friend, "Use this link");
}

/** What Obsidian runs for an obsidian:// link; the OS never sees this one. */
async function openInvite(
	friend: Obsidian,
	{ link, password }: SentInvite,
): Promise<void> {
	await friend.evaluate((url) => {
		const params = Object.fromEntries(new URL(url).searchParams);
		app.workspace.protocolHandler.handlers.get("mdsync-share")({
			action: "mdsync-share",
			...params,
		});
	}, link);
	await fill(friend, "Password", password);
	await press(friend, "Open invite");
}

export function mounted(device: Obsidian, path: string): Promise<string> {
	return poll(
		`${path} pulled`,
		async () => (await read(device, path)) ?? undefined,
	);
}

/** Stop sharing or Leave on the only open share, from its window in the settings. */
export async function closeFromSettings(
	device: Obsidian,
	action: string,
): Promise<void> {
	await openSettings(device, "Sync");
	await press(device, "Manage");
	await press(device, action);
	await confirm(device, action);
	await device.waitFor(
		"the record closed",
		() =>
			app.plugins.plugins.mdsync.settings.spaces.every(
				(record: { closed?: true }) => record.closed,
			),
		Boolean,
	);
	await closeSettings(device);
}

/** The hash the vault's own remote manifest holds for `path`. */
export function vaultHash(
	device: Obsidian,
	path: string,
): Promise<string | null> {
	return device.evaluate(
		(target) =>
			app.plugins.plugins.mdsync.controller.runtimeState.resultOf({
				id: "vault",
				root: "",
			})?.remote?.files[target]?.hash ?? null,
		path,
	);
}

/** Each failed share of the last refresh, as [root, message]. */
export function spaceErrors(device: Obsidian): Promise<string[][]> {
	return device.evaluate(() =>
		app.plugins.plugins.mdsync.controller
			.getSnapshot()
			.spaceErrors.map((each: { root: string; message: string }) => [
				each.root,
				each.message,
			]),
	);
}

/** The other side's edit, pulled on the share's signal alone. */
export async function arrives(
	device: Obsidian,
	path: string,
	text: string,
): Promise<void> {
	const label = `"${text.trim()}" reaches ${path} by itself`;
	await poll(label, async () =>
		(await read(device, path)) === text ? true : undefined,
	);
	console.log(`ok   ${label}`);
}
