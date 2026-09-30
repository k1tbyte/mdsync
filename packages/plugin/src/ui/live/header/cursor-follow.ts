import type { Editor, MarkdownView, WorkspaceLeaf } from "obsidian";

import { type LiveSession, type WatchedCursor, watchCursor } from "@/live";
import type { PluginHost } from "@/plugin/host";

const TAKE_BACK = ["keydown", "pointerdown", "wheel", "touchstart"] as const;

export interface FollowTarget {
	room: object;
	key: string;
	editor: Editor;
	/** Its own input here takes the view back. */
	input: HTMLElement;
	cursor: WatchedCursor;
	/** False once the view shows another note or the room closed: offsets would land in other text. */
	shown(): boolean;
}

interface Following {
	room: object;
	key: string;
	editor: Editor;
	end(): void;
}

/** Scrolls only, never moves the caret: the keystroke that ends following types where it already was. */
export class CursorFollow {
	private current: Following | null = null;

	of(room: object, editor: Editor): string | null {
		return this.current?.room === room && this.current.editor === editor
			? this.current.key
			: null;
	}

	start(target: FollowTarget): void {
		this.stop();
		const { room, key, editor, input, cursor, shown } = target;
		let last: number | null = null;
		const show = (): void => {
			if (!shown() || !cursor.present()) {
				this.stop();
				return;
			}
			const at = cursor.at();
			if (at === null || at === last) return;
			last = at;
			const pos = editor.offsetToPos(at);
			editor.scrollIntoView({ from: pos, to: pos });
		};
		let frame: number | null = null;
		// Out of the event: y-codemirror changes awareness inside an editor update, where a scroll throws.
		const changed = (): void => {
			frame ??= window.requestAnimationFrame(() => {
				frame = null;
				show();
			});
		};
		const takeBack = (): void => this.stop();
		const unwatch = cursor.watch(changed);
		for (const type of TAKE_BACK) {
			input.addEventListener(type, takeBack, { passive: true });
		}
		this.current = {
			room,
			key,
			editor,
			end() {
				unwatch();
				if (frame !== null) window.cancelAnimationFrame(frame);
				for (const type of TAKE_BACK) input.removeEventListener(type, takeBack);
			},
		};
		show();
	}

	stop(): void {
		const ending = this.current;
		this.current = null;
		ending?.end();
	}
}

interface FollowRequest {
	plugin: PluginHost;
	leaf: WorkspaceLeaf;
	markdown: MarkdownView;
	session: LiveSession;
	key: string;
	offset: number;
	follows: CursorFollow;
}

export function followCursor({
	plugin,
	leaf,
	markdown,
	session,
	key,
	offset,
	follows,
}: FollowRequest): void {
	const { editor, file } = markdown;
	const at = editor.offsetToPos(offset);
	plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
	editor.scrollIntoView({ from: at, to: at }, true);
	follows.start({
		room: session,
		key,
		editor,
		input: markdown.contentEl,
		cursor: watchCursor(session, key),
		shown: () =>
			leaf.view === markdown &&
			markdown.file === file &&
			file !== null &&
			plugin.realtime.live.roomOf(file.path) === session,
	});
}
