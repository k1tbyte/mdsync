import type { Editor } from "obsidian";

import type { WatchedCursor } from "@/live/text/cursors";

/** This device's own input in the editor: the view is its own again. */
const TAKE_BACK = ["keydown", "pointerdown", "wheel", "touchstart"] as const;

export interface FollowTarget {
	room: object;
	key: string;
	editor: Editor;
	/** Where this device's own input takes the view back. */
	input: HTMLElement;
	cursor: WatchedCursor;
	/** False once the view shows another note or the room closed: offsets would land in the wrong text. */
	shown(): boolean;
}

interface Following extends FollowTarget {
	end(): void;
}

/** One person's cursor kept in view in one editor, until this device's input there or their leaving. */
export class CursorFollow {
	private current: Following | null = null;

	/** Whom this editor follows in this room, if anyone. */
	of(room: object, editor: Editor): string | null {
		return this.current?.room === room && this.current.editor === editor
			? this.current.key
			: null;
	}

	start(target: FollowTarget): void {
		this.stop();
		const { editor, input, cursor, shown } = target;
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
			...target,
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
