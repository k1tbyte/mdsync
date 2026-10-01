import {
	FileView,
	ItemView,
	MarkdownView,
	type Notice,
	type WorkspaceLeaf,
} from "obsidian";

import type { LiveSession } from "@/live";
import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence";

import { showFollowNudge } from "./follow-nudge";
import { trackCursor } from "./follow-scroll";

const NUDGED_BY = ["keydown", "pointerdown", "wheel", "touchstart"] as const;

interface Following {
	leaf: WorkspaceLeaf;
	space: string;
	key: string;
	name: string;
	/** The note this tab follows them in: another one opened here by hand ends following. */
	path: string;
	opening: boolean;
	cursor: { session: LiveSession; stop(): void } | null;
	input: HTMLElement | null;
	unsubscribe(): void;
}

/** One tab follows one person of a space: into each note they open, then their cursor there. */
export class CursorFollow {
	private current: Following | null = null;
	private nudge: Notice | null = null;

	constructor(private readonly plugin: PluginHost) {}

	of(leaf: WorkspaceLeaf): string | null {
		return this.current?.leaf === leaf ? this.current.key : null;
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
			input: null,
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
		this.nudge?.hide();
		this.nudge = null;
		if (!following) return;
		following.unsubscribe();
		following.cursor?.stop();
		this.listen(following, null);
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
		if (person.note !== null && person.note !== following.path) {
			void this.open(following, person.note);
			return;
		}
		const { view } = following.leaf;
		this.listen(following, view instanceof ItemView ? view.contentEl : null);
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

	private listen(following: Following, input: HTMLElement | null): void {
		if (following.input === input) return;
		for (const type of NUDGED_BY) {
			following.input?.removeEventListener(type, this.onInput);
			input?.addEventListener(type, this.onInput, { passive: true });
		}
		following.input = input;
	}

	/** A stray click or key would end following by surprise: it only asks. */
	private readonly onInput = (): void => {
		const following = this.current;
		if (!following || this.nudge?.messageEl.isConnected) return;
		this.nudge = showFollowNudge(following.name, () => this.stop());
	};
}

function pathIn(leaf: WorkspaceLeaf): string | null {
	const { view } = leaf;
	return view instanceof FileView ? (view.file?.path ?? null) : null;
}
