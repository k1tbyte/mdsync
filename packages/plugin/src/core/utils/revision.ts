/** A record several devices may edit: every edit raises `rev` and names its device. */
export interface Revised {
	rev: number;
	author: string;
}

/** Last writer wins, deterministically on every device. */
export function isNewer(a: Revised, b: Revised): boolean {
	return a.rev !== b.rev ? a.rev > b.rev : a.author > b.author;
}
