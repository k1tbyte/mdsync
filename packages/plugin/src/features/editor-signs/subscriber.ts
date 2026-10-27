import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { shouldRedeliverBaseline } from "./helpers";
import type { SignsProvider } from "./provider";
import { compareTextField, pathFromState } from "./state";

/**
 * The path is taken once, with the state: Obsidian points the view at the next note before its text
 * arrives, and the state that brings the text builds this plugin anew. Renames go through the provider.
 */
export const subscriberPlugin = (provider: SignsProvider) =>
	ViewPlugin.fromClass(
		class {
			constructor(private readonly view: EditorView) {
				const path = pathFromState(view.state);
				if (path) provider.registerView(view, path);
			}

			update(u: ViewUpdate): void {
				const path = provider.getViewPath(this.view);
				if (path && this.needsRedeliver(u, path)) {
					provider.redeliver(this.view, path);
				}
			}

			destroy(): void {
				provider.unregisterView(this.view);
			}

			private needsRedeliver(u: ViewUpdate, path: string): boolean {
				return shouldRedeliverBaseline(
					u.startState.field(compareTextField, false) ?? null,
					u.state.field(compareTextField, false) ?? null,
					provider.hasCached(path),
				);
			}
		},
	);
