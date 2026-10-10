import type { RelayBundle } from "./bundle";

export interface MigrationUpload {
	old_tag?: string;
	new_tag: string;
	steps: Array<Record<string, unknown>>;
}

/**
 * Wrangler's rule: everything after the deployed tag. An unknown deployed tag is refused rather than
 * replayed from the start, which could recreate or delete a Durable Object class holding live data.
 */
export function pendingMigrations(
	migrations: RelayBundle["migrations"],
	deployedTag: string | undefined,
): MigrationUpload | undefined {
	const last = migrations.at(-1);
	if (!last || deployedTag === last.tag) return undefined;
	const at = deployedTag
		? migrations.findIndex((m) => m.tag === deployedTag)
		: -1;
	if (deployedTag && at === -1) {
		throw new Error(
			`The deployed relay is at migration "${deployedTag}", which this version does not know.`,
		);
	}
	return {
		...(deployedTag ? { old_tag: deployedTag } : {}),
		new_tag: last.tag,
		steps: migrations.slice(at + 1).map(({ tag: _tag, ...step }) => step),
	};
}
