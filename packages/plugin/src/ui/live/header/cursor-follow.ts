import { FileView, MarkdownView, type WorkspaceLeaf } from "obsidian";

import type { LiveSession } from "@/live";
import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence";
import { openNote } from "@/ui/common";

import { showFollowBanner } from "./follow-banner";
import { trackCursor } from "./follow-scroll";

interface Following {
	leaf: WorkspaceLeaf;
	space: string;
	key: string;
	name: string;
	/** The note this tab follows them in: another one opened here by hand ends following. */
	path: string;
	opening: boolean;
	cursor: { session: LiveSession; stop(): void } | null;
	banner: HTMLElement | null;
	unsubscribe(): void;
}

/** One tab follows one person of a space: into each note they open, then their cursor there. */
export class CursorFollow {
	private current: Following | null = null;

	constructor(private readonly plugin: PluginHost) {}

	of(leaf: WorkspaceLeaf): string | null {
		return this.current?.leaf === leaf ? this.current.key : null;
	}

	/** From outside a note: opens theirs, then follows in that tab. */
	async follow(
		space: string,
		person: Pick<Person, "key" | "name" | "note">,
	): Promise<boolean> {
		const leaf = person.note && (await openNote(this.plugin.app, person.note));
		if (leaf) this.start(leaf, space, person);
		return Boolean(leaf);
	}

	start(
		leaf: WorkspaceLeaf,
		space: string,
		{ key, name }: Pick<Person, "key" | "name">,
	): void {
		this.stop();
		const path = pathIn(leaf);
		if (path === null) return;
		const { app, realtime } = this.plugin;
		const sync = (): void => this.sync();
		const unsubscribe = [
			realtime.people.subscribe(sync),
			realtime.live.subscribe(sync),
		];
		const opened = app.workspace.on("file-open", sync);
		this.current = {
			leaf,
			space,
			key,
			name,
			path,
			opening: false,
			cursor: null,
			banner: null,
			unsubscribe: () => {
				for (const off of unsubscribe) off();
				app.workspace.offref(opened);
			},
		};
		app.workspace.setActiveLeaf(leaf, { focus: true });
		this.sync();
	}

	stop(): void {
		const following = this.current;
		this.current = null;
		if (!following) return;
		following.unsubscribe();
		following.cursor?.stop();
		following.banner?.remove();
	}

	private sync(): void {
		const following = this.current;
		if (!following || following.opening) return;
		if (pathIn(following.leaf) !== following.path) {
			this.stop();
			return;
		}
		const person = this.plugin.realtime.people
			.online(following.space)
			.find(({ key }) => key === following.key);
		if (!person) {
			this.stop();
			return;
		}
		this.showBanner(following);
		if (person.note !== null && person.note !== following.path) {
			void this.open(following, person.note);
			return;
		}
		this.track(following);
	}

	private async open(following: Following, path: string): Promise<void> {
		// Not on this device yet: it may still arrive.
		const file = this.plugin.app.vault.getFileByPath(path);
		if (!file) return;
		following.opening = true;
		following.cursor?.stop();
		following.cursor = null;
		try {
			await following.leaf.openFile(file);
			following.path = path;
		} finally {
			following.opening = false;
		}
		if (this.current === following) this.sync();
	}

	/** Again after a note of another kind replaced the view, and the banner with it. */
	private showBanner(following: Following): void {
		const { containerEl } = following.leaf.view;
		if (following.banner?.parentElement === containerEl) return;
		following.banner?.remove();
		following.banner = showFollowBanner(containerEl, following, () =>
			this.stop(),
		);
	}

	private track(following: Following): void {
		const { view } = following.leaf;
		const session = this.plugin.realtime.live.roomOf(following.path);
		if (following.cursor && following.cursor.session === session) return;
		following.cursor?.stop();
		following.cursor =
			view instanceof MarkdownView && session
				? { session, stop: trackCursor(view, session, following.key) }
				: null;
	}
}

function pathIn(leaf: WorkspaceLeaf): string | null {
	const { view } = leaf;
	return view instanceof FileView ? (view.file?.path ?? null) : null;
}
