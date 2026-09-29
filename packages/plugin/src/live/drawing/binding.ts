import type * as Y from "yjs";

import { type SceneElement, wins } from "@/drawing";

import type { BoundEditor } from "../model";
import { LOCAL_AWARENESS } from "../room-awareness";
import type { LiveSession } from "../session";
import {
	type Collaborator,
	type ExcalidrawView,
	excalidrawLib,
	holds,
	sceneText,
} from "./excalidraw";
import type { DrawingModel } from "./model";

/** The origin y-protocols gives this device's own awareness changes. */

interface PointerState {
	user?: { key?: unknown; name?: unknown };
	pointer?: { x: number; y: number } | null;
}

/**
 * Keeps one Excalidraw view and its room in step, element by element, with
 * everyone's pointers; null while it loads. A view that reloads replaces its
 * API: the first event after that calls `onStale` instead.
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
	/** This view's own writes, which its observer skips; another view of the file still shows them. */
	const origin = Symbol("drawing-view");

	const push = (elements: readonly SceneElement[]) =>
		doc.transact(() => {
			for (const element of elements) model.put(element);
		}, origin);

	// Until the sessions detach it, a view switched to another file must neither take nor give elements.
	const showRoom = () => {
		if (!holds(view, file)) return;
		const room = [...model.elements.values()].map((element) => ({
			...element,
		}));
		const elements = lib.reconcileElements(
			api.getSceneElementsIncludingDeleted(),
			room,
			api.getAppState(),
		);
		for (const { id, version } of elements) seen.set(id, version);
		api.updateScene({ elements, captureUpdate: NEVER });
		// Y.Map settles concurrent writes by client, not version: the winner the view kept goes back.
		push(elements);
	};

	const onChange = (elements: readonly SceneElement[]) => {
		if (!holds(view, file)) return;
		const edited = elements.filter(
			({ id, version }) => seen.get(id) !== version,
		);
		if (edited.length === 0) return;
		for (const element of edited) {
			const held = model.elements.get(element.id);
			// Made over a newer version from elsewhere: the edit still lands, one version past it.
			if (held && wins(held, element)) lib.bumpVersion(element, held.version);
			seen.set(element.id, element.version);
		}
		push(edited);
	};

	const stale = () => view.excalidrawAPI !== api;
	const alive = (): boolean => {
		if (stale()) onStale();
		return !stale();
	};

	const onRoom = (_: unknown, tx: Y.Transaction) => {
		if (tx.origin !== origin && alive()) showRoom();
	};

	const showPointers = () =>
		api.updateScene({
			collaborators: pointersIn(session),
			captureUpdate: NEVER,
		});
	const onPeers = (_: unknown, origin: unknown) => {
		if (origin !== LOCAL_AWARENESS && alive()) showPointers();
	};
	const onMove = (event: PointerEvent) => {
		if (!alive()) return;
		awareness.setLocalStateField(
			"pointer",
			lib.viewportCoordsToSceneCoords(event, api.getAppState()),
		);
	};
	const onLeave = () => awareness.setLocalStateField("pointer", null);

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
