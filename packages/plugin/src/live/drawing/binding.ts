import type * as Y from "yjs";

import { type SceneElement, wins } from "@/drawing";

import type { BoundEditor } from "@/live/model";
import { type LiveSession, LOCAL_AWARENESS } from "@/live/session";
import {
	type Collaborator,
	type ExcalidrawView,
	excalidrawLib,
	holds,
	sceneText,
} from "./excalidraw";
import type { DrawingModel } from "./model";

interface PointerState {
	user?: { key?: unknown; name?: unknown };
	pointer?: { x: number; y: number } | null;
}

/**
 * Keeps one Excalidraw view and its room in step, element by element, with
 * everyone's pointers; null while it loads. A reloaded view replaces its API:
 * the first event after that calls `onStale` instead.
 */
export function bindDrawing(
	view: ExcalidrawView,
	session: LiveSession<DrawingModel>,
	onStale: () => void,
): BoundEditor | null {
	const api = view.excalidrawAPI;
	const file = view.file;
	if (!api || !holds(view)) return null;
	const lib = excalidrawLib();
	if (!lib) return null;
	const { model, awareness, doc } = session;
	const NEVER = lib.CaptureUpdateAction.NEVER;
	/** Each element's version as the view last had it: a different one is an edit made here. */
	const seen = new Map<string, number>();
	const staged = new Map<string, SceneElement>();
	let missed = false;
	/** This view's own writes, which its observer skips; another view of the file still shows them. */
	const origin = Symbol("drawing-view");

	const drain = () => {
		const edits = [...staged.values()];
		staged.clear();
		doc.transact(() => {
			for (const edit of edits) model.put(edit);
		}, origin);
	};

	const report = (element: SceneElement) => {
		const held = model.elements.get(element.id);
		// Made over a newer version from elsewhere: the edit still lands, one version past it.
		if (held && wins(held, element)) lib.bumpVersion(element, held.version);
		seen.set(element.id, element.version);
		if (
			held?.version === element.version &&
			held.versionNonce === element.versionNonce
		) {
			return;
		}
		staged.set(element.id, element);
		session.stage(drain);
	};

	// Until the sessions detach it, a view switched to another file must neither take nor give elements.
	const showRoom = (changed?: ReadonlySet<string>) => {
		if (!holds(view, file)) {
			missed = true;
			return;
		}
		const only = missed ? undefined : changed;
		missed = false;
		const room: SceneElement[] = [];
		for (const id of only ?? model.elements.keys()) {
			const held = model.elements.get(id);
			if (held) room.push({ ...held });
		}
		const elements = lib.reconcileElements(
			api.getSceneElementsIncludingDeleted(),
			room,
			api.getAppState(),
		);
		// Y.Map settles concurrent writes by client, not version: the winner the view kept goes back.
		for (const element of elements) {
			if (!only || only.has(element.id)) report(element);
		}
		api.updateScene({ elements, captureUpdate: NEVER });
	};

	const onChange = (elements: readonly SceneElement[]) => {
		if (!holds(view, file)) return;
		for (const element of elements) {
			if (seen.get(element.id) !== element.version) report(element);
		}
	};

	const stale = () => view.excalidrawAPI !== api;
	const alive = (): boolean => {
		if (stale()) onStale();
		return !stale();
	};

	const onRoom = (event: Y.YMapEvent<SceneElement>, tx: Y.Transaction) => {
		if (tx.origin !== origin && alive()) showRoom(event.keysChanged);
	};

	const showPointers = () =>
		api.updateScene({
			collaborators: pointersIn(session),
			captureUpdate: NEVER,
		});
	const onPeers = (_: unknown, origin: unknown) => {
		if (origin !== LOCAL_AWARENESS && alive()) showPointers();
	};
	let frame: number | null = null;
	let latest: PointerEvent;
	const onMove = (event: PointerEvent) => {
		if (!alive()) return;
		latest = event;
		frame ??= window.requestAnimationFrame(() => {
			frame = null;
			awareness.setLocalStateField(
				"pointer",
				lib.viewportCoordsToSceneCoords(latest, api.getAppState()),
			);
		});
	};
	const onLeave = () => {
		if (frame !== null) window.cancelAnimationFrame(frame);
		frame = null;
		awareness.setLocalStateField("pointer", null);
	};

	// Strokes drawn while the room was answering go in before the view follows it.
	session.adopt(sceneText(api));
	showRoom();
	showPointers();
	const offChange = api.onChange(onChange);
	model.elements.observe(onRoom);
	awareness.on("change", onPeers);
	view.contentEl.addEventListener("pointermove", onMove);
	view.contentEl.addEventListener("pointerleave", onLeave);

	return {
		showAuthors() {},
		stale,
		detach() {
			offChange();
			model.elements.unobserve(onRoom);
			session.drainStaged();
			awareness.off("change", onPeers);
			view.contentEl.removeEventListener("pointermove", onMove);
			view.contentEl.removeEventListener("pointerleave", onLeave);
			onLeave();
			try {
				api.updateScene({ collaborators: new Map(), captureUpdate: NEVER });
			} catch {
				// The view was torn down before its binding.
			}
		},
	};
}

function pointersIn({
	awareness,
	doc,
}: LiveSession): Map<string, Collaborator> {
	const out = new Map<string, Collaborator>();
	for (const [client, state] of awareness.getStates()) {
		const { user, pointer } = state as PointerState;
		if (client === doc.clientID || !pointer || typeof user?.key !== "string") {
			continue;
		}
		out.set(String(client), {
			pointer: { ...pointer, tool: "pointer" },
			username: String(user.name ?? ""),
			id: user.key,
		});
	}
	return out;
}
