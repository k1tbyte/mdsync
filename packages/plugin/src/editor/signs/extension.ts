import type { Extension } from "@codemirror/state";

import { computePlugin } from "./compute";
import { hunkFocus } from "./focus";
import { buildSignsGutter, signsField } from "./gutter";
import type { SignsProvider } from "./provider";
import { chunksField, compareTextField } from "./state";
import { subscriberPlugin } from "./subscriber";

export function buildSignsExtensions(provider: SignsProvider): Extension[] {
	return [
		compareTextField,
		chunksField,
		hunkFocus,
		signsField,
		computePlugin,
		buildSignsGutter(provider),
		subscriberPlugin(provider),
	];
}
