/**
 * An owner and a friend with vaults of their own, on one relay and one
 * in-memory S3, and the share steps their scenarios take through menus,
 * modals and settings.
 */

import {
	CLEAN,
	clickMenuItem,
	closeModals,
	closeSettings,
	confirm,
	field,
	fill,
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

/** Both devices launched, unlocked and synced once, then `body`. */
export function runSharing(
	name: string,
	files: { owner: Record<string, string>; friend: Record<string, string> },
	body: (owner: Obsidian, friend: Obsidian, s3: S3) => Promise<void>,
): Promise<never> {
	return runScenario(name, async () => {
		const relay = await startRelay(RELAY_PORT, SECRET);
		const s3 = await startS3(S3_PORT);
		const devices: Obsidian[] = [];
		const vault = (prefix: string) => ({
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
			realtimeSync: true,
		});
		try {
			const owner = await launchObsidian({
				port: CDP_PORTS.owner,
				settings: {
					...vault("owner"),
					relayUrl: relay.url,
					relaySecret: SECRET,
				},
				files: files.owner,
			});
			devices.push(owner);
			const friend = await launchObsidian({
				port: CDP_PORTS.friend,
				settings: vault("friend"),
				files: files.friend,
			});
			devices.push(friend);
			await unlock(owner, "owner-passphrase");
			await unlock(friend, "friend-passphrase");
			check("the owner syncs", await sync(owner), CLEAN);
			check("the friend syncs", await sync(friend), CLEAN);
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
	await clickMenuItem(owner, folder, "Obsync: Share folder");
	const id = (await owner.waitFor(
		"the share's record",
		() => app.plugins.plugins.obsync.settings.spaces[0]?.id,
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
	await clickMenuItem(owner, folder, "Obsync: Manage sharing");
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
		app.workspace.protocolHandler.handlers.get("obsync-share")({
			action: "obsync-share",
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
			app.plugins.plugins.obsync.settings.spaces.every(
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
			app.plugins.plugins.obsync.controller.runtimeState.resultOf({
				id: "vault",
				root: "",
			})?.remote?.files[target]?.hash ?? null,
		path,
	);
}

/** Each failed share of the last refresh, as [root, message]. */
export function spaceErrors(device: Obsidian): Promise<string[][]> {
	return device.evaluate(() =>
		app.plugins.plugins.obsync.controller
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
