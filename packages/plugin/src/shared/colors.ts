/** Hue per person (or device), so the same one keeps its colour on every screen. */
const HUE_STEPS = 12;

export interface PersonColors {
	color: string;
	colorLight: string;
}

export function personColors(key: string): PersonColors {
	let hash = 0;
	for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	const hue = (hash % HUE_STEPS) * (360 / HUE_STEPS);
	return {
		color: `hsl(${hue}, 70%, 50%)`,
		colorLight: `hsla(${hue}, 70%, 50%, 0.2)`,
	};
}
