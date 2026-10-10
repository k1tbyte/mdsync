/** A fresh install opens the setup wizard; one device starts a vault through it, a second joins by its link. */

import { fill, loaded, press, read } from "./device";
import { check, runScenario, sleep } from "./harness";
import { launchObsidian, type Obsidian } from "./obsidian";
import { startS3 } from "./s3";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;
declare const activeDocument: Document;

const CDP_PORTS = [9241, 9242];
const S3_PORT = 8841;
const PASSPHRASE = "correct horse battery staple";
const NOTE = "note.md";

await runScenario("setup wizard e2e", async () => {
	const s3 = await startS3(S3_PORT);
	const devices: Obsidian[] = [];
	try {
		const first = await launchObsidian({
			port: CDP_PORTS[0] as number,
			settings: null,
			files: { [NOTE]: "from the first device\n" },
		});
		devices.push(first);
		await loaded(first);
		await wizardShown(first);
		await first.shot("setup-start", ".mdsync-setup");

		await press(first, "Start");
		await press(first, "Choose");
		await fill(first, "Endpoint", s3.url);
		await fill(first, "Region", "auto");
		await fill(first, "Bucket", s3.bucket);
		await fill(first, "Prefix", "vault");
		await fill(first, "Access key ID", "e2e");
		await fill(first, "Secret access key", "e2e");
		await press(first, "Continue");

		await fill(first, "Passphrase", "short");
		await fill(first, "Confirm passphrase", "short");
		await press(first, "Set passphrase");
		check("a weak new passphrase is refused", await warned(first), true);
		await fill(first, "Passphrase", PASSPHRASE);
		await fill(first, "Confirm passphrase", PASSPHRASE);
		await press(first, "Set passphrase");

		await press(first, "Skip");
		await first.shot("setup-ready", ".mdsync-setup");
		await press(first, "Sync now");
		await first.waitFor(
			"the first sync",
			() => activeDocument.querySelector(".mdsync-setup-body")?.textContent,
			(text) => text?.includes("In sync.") ?? false,
		);
		check(
			"the first device keeps its passphrase unlocked",
			await first.evaluate(() =>
				app.plugins.plugins.mdsync.passphrase.isUnlocked(),
			),
			true,
		);
		check(
			"the note reached the storage",
			s3.keys().some((key) => key.startsWith("vault/")),
			true,
		);
		await press(first, "Done");
		check("Done closes the wizard", await wizardOpen(first), false);

		const link = await first.evaluate(async () => {
			const pack = await app.plugins.plugins.mdsync.transfer.createPackage({
				storageMode: "active",
				includeSyncScope: true,
				includeAutomation: true,
				includeRealtime: true,
			});
			return pack.url as string;
		});

		await first.evaluate(async () => {
			await app.plugins.disablePlugin("mdsync");
			await app.plugins.enablePlugin("mdsync");
		});
		await loaded(first);
		await sleep(2000);
		check(
			"a configured device does not open the wizard",
			await wizardOpen(first),
			false,
		);

		const second = await launchObsidian({
			port: CDP_PORTS[1] as number,
			settings: null,
		});
		devices.push(second);
		await loaded(second);
		await wizardShown(second);
		await press(second, "Connect");
		await fill(second, "Setup link", link);
		await fill(second, "Passphrase", "wrong passphrase here");
		await press(second, "Import");
		check(
			"a wrong passphrase leaves the link step",
			await warned(second),
			true,
		);
		await fill(second, "Passphrase", PASSPHRASE);
		await press(second, "Import");
		await press(second, "Skip");
		await press(second, "Sync now");
		await second.waitFor(
			"the joining sync",
			() => activeDocument.querySelector(".mdsync-setup-body")?.textContent,
			(text) => text?.includes("In sync.") ?? false,
		);
		check(
			"the joining device pulled the note",
			await read(second, NOTE),
			"from the first device\n",
		);
	} finally {
		for (const device of devices) await device.stop();
		s3.stop();
	}
});

/** A fresh vault's trust prompt opens Community plugins, a document of its own over the wizard. */
async function wizardShown(device: Obsidian): Promise<boolean> {
	await device.waitFor(
		"Community plugins",
		() => activeDocument.querySelector(".mod-settings") !== null,
		Boolean,
	);
	await device.evaluate(() => app.setting.close());
	return device.waitFor(
		"the setup wizard",
		() => activeDocument.querySelector(".mdsync-setup") !== null,
		Boolean,
	);
}

function wizardOpen(device: Obsidian): Promise<boolean> {
	return device.evaluate(
		() => activeDocument.querySelector(".mdsync-setup") !== null,
	);
}

/** The current step shows a problem. */
function warned(device: Obsidian): Promise<boolean> {
	return device.waitFor(
		"a warning in the step",
		() =>
			activeDocument.querySelector(".mdsync-setup-body .mod-warning") !== null,
		Boolean,
	);
}
