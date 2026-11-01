import type { Plugin } from "obsidian";
import type { DeviceKey } from "@/core/crypto";
import type { MdsyncSettings } from "@/core/settings";
import { SettingsEnvelope } from "./envelope";
import { mergeSettings } from "./index";

/**
 * Where a new install starts beyond the defaults. Not the defaults themselves: a setup link leaves
 * default values out, so a changed default would flip the setting for links made before.
 */
const FRESH_INSTALL: Partial<MdsyncSettings> = { fileHistoryEnabled: true };

/** `data.json` through the envelope, one write at a time. */
export class SettingsStore {
	private readonly envelope: SettingsEnvelope;
	/** Two writes in flight may land the older one last. */
	private saving: Promise<void> = Promise.resolve();
	private fresh = false;

	constructor(
		private readonly plugin: Pick<Plugin, "loadData" | "saveData">,
		deviceKey: DeviceKey,
	) {
		this.envelope = new SettingsEnvelope(deviceKey);
	}

	/** Set by {@link load}: there was no `data.json` yet. */
	get freshInstall(): boolean {
		return this.fresh;
	}

	unreadable(): boolean {
		return this.envelope.unreadable();
	}

	async load(): Promise<MdsyncSettings> {
		const data = (await this.plugin.loadData()) as Record<
			string,
			unknown
		> | null;
		this.fresh = data === null;
		const { stored, inTheClear } = await this.envelope.open(data);
		const settings = mergeSettings(
			this.fresh ? { ...stored, ...FRESH_INSTALL } : stored,
		);
		// Sealed now, not at the next change: the secrets of an earlier build must not linger in the clear.
		if (inTheClear) await this.write(settings);
		return settings;
	}

	write(settings: MdsyncSettings): Promise<void> {
		const save = this.saving.then(async () =>
			this.plugin.saveData(await this.envelope.seal(settings)),
		);
		this.saving = save.catch(() => undefined);
		return save;
	}
}
