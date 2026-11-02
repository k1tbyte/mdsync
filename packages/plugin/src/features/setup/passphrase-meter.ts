import { MIN_PASSPHRASE_LENGTH } from "@/core/crypto";

export const METER_BARS = 4;

export interface PassphraseStrength {
	/** Bars to light, 0 to METER_BARS. */
	filled: number;
	label: string;
}

/** Length only: it is what the minimum rests on, and a score from character classes would flatter short ones. */
export function passphraseStrength(passphrase: string): PassphraseStrength {
	const length = [...passphrase].length;
	if (length === 0) {
		return { filled: 0, label: `At least ${MIN_PASSPHRASE_LENGTH} characters` };
	}
	if (length < MIN_PASSPHRASE_LENGTH) {
		return {
			filled: 1,
			label: `${length} of ${MIN_PASSPHRASE_LENGTH} characters`,
		};
	}
	if (length < MIN_PASSPHRASE_LENGTH + 4) return { filled: 2, label: "Okay" };
	if (length < MIN_PASSPHRASE_LENGTH + 10) return { filled: 3, label: "Good" };
	return { filled: METER_BARS, label: "Strong" };
}

/** Returns what to call with each new value: the meter changes in place, so typing is never interrupted. */
export function passphraseMeter(
	parent: HTMLElement,
	initial: string,
): (value: string) => void {
	const meter = parent.createDiv({
		cls: "mdsync-meter",
		attr: {
			role: "meter",
			"aria-label": "Passphrase strength",
			"aria-valuemin": "0",
			"aria-valuemax": String(METER_BARS),
		},
	});
	const bars = meter.createDiv({ cls: "mdsync-meter-bars" });
	const cells = Array.from({ length: METER_BARS }, () =>
		bars.createSpan({ cls: "mdsync-meter-bar" }),
	);
	const label = meter.createSpan({
		cls: "mdsync-meter-label",
		attr: { "aria-live": "polite" },
	});
	const update = (value: string): void => {
		const { filled, label: text } = passphraseStrength(value);
		meter.dataset.filled = String(filled);
		meter.setAttr("aria-valuenow", String(filled));
		meter.setAttr("aria-valuetext", text);
		cells.forEach((cell, at) => {
			cell.toggleClass("is-on", at < filled);
		});
		label.setText(text);
	};
	update(initial);
	return update;
}
