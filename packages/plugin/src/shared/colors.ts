// hsl(hue, 70%, 50%) every 30 degrees: one colour per person on every screen.
// Hex, as y-codemirror tints a selection `color + "33"`: the tint is never sent.
const COLORS = [
	"#d92626",
	"#d98026",
	"#d9d926",
	"#80d926",
	"#26d926",
	"#26d980",
	"#26d9d9",
	"#2680d9",
	"#2626d9",
	"#8026d9",
	"#d926d9",
	"#d92680",
];

export function personColor(key: string): string {
	let hash = 0;
	for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return COLORS[hash % COLORS.length] as string;
}

/** The colour at 20%, as y-codemirror tints that person's selection. */
export function personTint(key: string): string {
	return `${personColor(key)}33`;
}
