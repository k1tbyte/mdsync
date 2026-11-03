import { VAULT_SPACE } from "../remote/space";

export interface RefreshRequest {
	spaces: Set<string> | null;
	pull: boolean;
	push: boolean;
	only?: ReadonlySet<string>;
}

/** No `spaces`, or the vault among them: every space. */
export interface RefreshAsk {
	spaces?: ReadonlySet<string>;
	pull?: boolean;
	push?: boolean;
	only?: ReadonlySet<string>;
}

export class RefreshQueue {
	private pending: { request: RefreshRequest; done: Promise<void> } | null =
		null;

	constructor(
		private readonly enqueue: (run: () => Promise<void>) => Promise<void>,
		private readonly run: (request: RefreshRequest) => Promise<void>,
	) {}

	request({
		spaces,
		pull = false,
		push = false,
		only,
	}: RefreshAsk = {}): Promise<void> {
		const targets =
			spaces && !spaces.has(VAULT_SPACE.id) ? new Set(spaces) : null;
		const pending = this.pending;
		if (pending) {
			if (targets === null) pending.request.spaces = null;
			else if (pending.request.spaces)
				for (const id of targets) pending.request.spaces.add(id);
			pending.request.pull ||= pull;
			if (push) {
				pending.request.only = pending.request.push
					? unionPaths(pending.request.only, only)
					: only;
				pending.request.push = true;
			}
			return pending.done;
		}
		const request = { spaces: targets, pull, push, only };
		const done = this.enqueue(async () => {
			this.pending = null;
			await this.run(request);
		});
		this.pending = { request, done };
		return done;
	}
}

function unionPaths(
	a?: ReadonlySet<string>,
	b?: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
	return a && b ? new Set([...a, ...b]) : undefined;
}
