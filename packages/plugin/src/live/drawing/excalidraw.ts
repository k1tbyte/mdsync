/**
 * The slice of the Excalidraw plugin a live drawing uses. Undeclared by it,
 * checked against 2.x: its view keeps the React API on `excalidrawAPI`, and the
 * library it bundles sits on `window.ExcalidrawLib`.
 */

import type { TextFileView, TFile, View } from "obsidian";

import type { SceneElement } from "@/drawing";

import { LIVE_VIEWS } from "../doc-types";

/** Another device's pointer, as Excalidraw draws it. */
export interface Collaborator {
	pointer: { x: number; y: number; tool: "pointer" };
	username: string;
	/** What Excalidraw derives the pointer's colour from. */
	id: string;
}

type AppState = Record<string, unknown>;

export interface ExcalidrawApi {
	getSceneElementsIncludingDeleted(): readonly SceneElement[];
	getAppState(): AppState;
	updateScene(scene: {
		elements?: readonly SceneElement[];
		collaborators?: Map<string, Collaborator>;
		captureUpdate: string;
	}): void;
	/** Every render, with deleted elements; returns the unsubscribe. */
	onChange(listener: (elements: readonly SceneElement[]) => void): () => void;
}

export interface ExcalidrawView extends TextFileView {
	/** Set once the drawing has loaded, a while after the file opened. */
	excalidrawAPI?: ExcalidrawApi;
	/** Names the file whose scene the view holds. */
	excalidrawData?: { file?: TFile | null };
	save(preventReload?: boolean, force?: boolean): Promise<void>;
}

export interface ExcalidrawLib {
	/** Remote wins where newer, unless this view is editing that element. */
	reconcileElements(
		local: readonly SceneElement[],
		remote: readonly SceneElement[],
		appState: AppState,
	): SceneElement[];
	viewportCoordsToSceneCoords(
		at: { clientX: number; clientY: number },
		appState: AppState,
	): { x: number; y: number };
	/** Mutates: one past `version`, with a fresh nonce. */
	bumpVersion(element: SceneElement, version?: number): void;
	CaptureUpdateAction: { NEVER: string };
}

export function drawingView(view: View): ExcalidrawView | null {
	return view.getViewType() === LIVE_VIEWS.drawing
		? (view as ExcalidrawView)
		: null;
}

/** Whether the view shows `file`'s scene: a switched view names the next file a moment before it shows it. */
export function holds(view: ExcalidrawView, file = view.file): boolean {
	return (
		file !== null && view.file === file && view.excalidrawData?.file === file
	);
}

export function excalidrawLib(): ExcalidrawLib | null {
	return (window as { ExcalidrawLib?: ExcalidrawLib }).ExcalidrawLib ?? null;
}

/** Deleted elements too: a deletion is a version like any edit. */
export function sceneText(api: ExcalidrawApi): string {
	return JSON.stringify({ elements: api.getSceneElementsIncludingDeleted() });
}

/** Null while the view is loading: its file is as new. */
export function readDrawing(view: ExcalidrawView): string | null {
	const api = view.excalidrawAPI;
	return api && holds(view) ? sceneText(api) : null;
}

/** Forced: a scene the room just changed may not have marked the view dirty yet. */
export function saveDrawing(view: ExcalidrawView): Promise<void> {
	return view.save(true, true);
}
