/**
 * A live note whose folder becomes a share, in two real Obsidians of one owner: both end in the share's
 * room with every edit once.
 */

import { CLEAN, clickMenuItem, closeModals, sync, unlock } from "./device";
import { converged, open, type } from "./editor";
import { check, runScenario } from "./harness";
import { launchObsidian, type Obsidian } from "./obsidian";
import { type Relay, startRelay } from "./relay";
import { type S3, startS3 } from "./s3";

const RELAY_PORT = 8799;
const S3_PORT = 8802;
const CDP_PORTS = [9223, 9224];
const SECRET = "e2e-secret";
const PASSPHRASE = "e2e-passphrase";
const PLAN = "Team/plan.md";
const SHARE_ITEM = "MDSync: Share folder";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

await runScenario("live into share e2e", async () => {
	let relay: Relay | null = null;
	let s3: S3 | null = null;
	const devices: Obsidian[] = [];
	try {
		relay = await startRelay(RELAY_PORT, SECRET);
		s3 = await startS3(S3_PORT);
		const settings = {
			storageConfigs: {
				s3: {
					kind: "s3",
					endpoint: s3.url,
					region: "auto",
					bucket: s3.bucket,
					prefix: "vault",
					accessKeyId: "e2e",
					secretAccessKey: "e2e",
					forcePathStyle: true,
					concurrency: 4,
				},
			},
			activeStorageKind: "s3",
			realtimeSync: true,
			liveEditing: true,
			relayUrl: relay.url,
			relaySecret: SECRET,
		};
		const files: Record<string, string>[] = [{ [PLAN]: "plan\n" }, {}];
		for (const [index, port] of CDP_PORTS.entries()) {
			const device = await launchObsidian({
				port,
				settings,
				files: files[index],
			});
			devices.push(device);
			await unlock(device, PASSPHRASE);
			check(`device ${index + 1} syncs the vault`, await sync(device), CLEAN);
		}
		for (const device of devices) await open(device, PLAN);
		const [laptop, desktop] = devices as [Obsidian, Obsidian];
		await scenario(laptop, desktop);
	} finally {
		relay?.stop();
		s3?.stop();
		await Promise.all(devices.map((device) => device.stop()));
	}
});

async function scenario(laptop: Obsidian, desktop: Obsidian): Promise<void> {
	await type(laptop, "end", "laptop before\n");
	const before = await converged(laptop, desktop);

	const typing = type(desktop, "end", "desktop during\n");
	await clickMenuItem(laptop, "Team", SHARE_ITEM);
	// Sharing opens the share's window for the first invite.
	await closeModals(laptop);
	await type(laptop, "start", "laptop during\n");
	await typing;

	const rooms = await Promise.all(
		[laptop, desktop].map((device) =>
			device.waitFor(
				"the note in the share's room",
				() => app.plugins.plugins.mdsync.realtime.live.spaceOf("Team/plan.md"),
				(space: string | null) => space !== null && space !== "vault",
			),
		),
	);
	check("both devices move into the share's room", rooms[0], rooms[1]);
	check(
		"every edit lands once",
		await converged(laptop, desktop),
		`laptop during\n${before}desktop during\n`,
	);
}
