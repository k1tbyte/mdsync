type Json = unknown;

/**
 * Base and remote rewritten in local's key order and indent, so a merge shows only real changes. Only for JSON
 * exactly as `JSON.stringify` writes it on every side (Obsidian's config, plugin `data.json`): rewriting such a
 * text loses nothing. Null otherwise.
 */
export function alignJsonSides(
	base: string,
	local: string,
	remote: string,
): { base: string; remote: string } | null {
	const [baseSide, localSide, remoteSide] = [base, local, remote].map(
		canonical,
	);
	if (!baseSide || !localSide || !remoteSide) return null;
	const write = ({ value }: Canonical) =>
		JSON.stringify(ordered(value, localSide.value), null, localSide.indent) +
		localSide.tail;
	return { base: write(baseSide), remote: write(remoteSide) };
}

interface Canonical {
	value: Json;
	indent: string;
	tail: string;
}

function canonical(text: string): Canonical | null {
	let value: Json;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	const indent = /\n([\t ]+)/.exec(text)?.[1] ?? "";
	const tail = text.endsWith("\n") ? "\n" : "";
	// Also refuses what parsing alone would change: big integers, number forms, key order JS reorders.
	if (JSON.stringify(value, null, indent) + tail !== text) return null;
	return { value, indent, tail };
}

/** Template's keys first in its order, then the rest in their own. */
function ordered(value: Json, template: Json): Json {
	if (Array.isArray(value)) {
		return value.map((item, i) =>
			ordered(item, Array.isArray(template) ? template[i] : undefined),
		);
	}
	if (!isRecord(value)) return value;
	const own = new Set(Object.keys(value));
	const first = isRecord(template)
		? Object.keys(template).filter((key) => own.has(key))
		: [];
	// Null prototype: a "__proto__" key stays a key.
	const out: Record<string, Json> = Object.create(null);
	for (const key of new Set([...first, ...own])) {
		out[key] = ordered(
			value[key],
			isRecord(template) ? template[key] : undefined,
		);
	}
	return out;
}

function isRecord(value: Json): value is Record<string, Json> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
