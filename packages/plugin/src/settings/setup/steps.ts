import type { PluginHost } from "@/plugin/host";
import {
	canSync,
	isRelayConfigured,
	isStorageConfigured,
} from "@/settings/model";

export const ESetupStep = {
	Start: "start",
	Storage: "storage",
	Passphrase: "passphrase",
	Import: "import",
	Relay: "relay",
	Ready: "ready",
} as const;
export type ESetupStep = (typeof ESetupStep)[keyof typeof ESetupStep];

export const ESetupPath = {
	/** The first device: storage and passphrase made here. */
	New: "new",
	/** Another device already syncs: its setup link brings both. */
	Join: "join",
} as const;
export type ESetupPath = (typeof ESetupPath)[keyof typeof ESetupPath];

export const PATH_STEPS: Record<ESetupPath, readonly ESetupStep[]> = {
	[ESetupPath.New]: [
		ESetupStep.Storage,
		ESetupStep.Passphrase,
		ESetupStep.Relay,
		ESetupStep.Ready,
	],
	[ESetupPath.Join]: [ESetupStep.Import, ESetupStep.Relay, ESetupStep.Ready],
};

/** Computed, never stored, so the wizard always agrees with the settings. */
export function isStepDone(plugin: PluginHost, step: ESetupStep): boolean {
	switch (step) {
		case ESetupStep.Storage:
			return isStorageConfigured(plugin.settings);
		case ESetupStep.Passphrase:
			return plugin.passphrase.isUnlocked();
		case ESetupStep.Import:
			return canSync(plugin.settings) && plugin.passphrase.has();
		case ESetupStep.Relay:
			return isRelayConfigured(plugin.settings);
		default:
			return true;
	}
}

/** Where the wizard opens: the first step this device still lacks. */
export function firstStep(plugin: PluginHost): ESetupStep {
	if (!isStorageConfigured(plugin.settings)) return ESetupStep.Start;
	return (
		PATH_STEPS[ESetupPath.New].find((step) => !isStepDone(plugin, step)) ??
		ESetupStep.Ready
	);
}
