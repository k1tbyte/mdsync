import { formatBytes } from "@/core/shared";
import { textButton } from "@/core/ui";
import type { FileDiffModel } from "@/features/sync";

export function renderBinaryDiff(
	parent: HTMLElement,
	model: FileDiffModel,
	forceText: boolean,
	onForceText: () => void,
): void {
	const wrap = parent.createDiv({ cls: "mdsync-diff-binary" });
	const delta = model.rightSize - model.leftSize;
	const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
	const deltaText =
		delta === 0 ? "no size change" : `${sign}${formatBytes(Math.abs(delta))}`;
	wrap.createDiv({
		text: `Not shown as a text diff — ${formatBytes(model.leftSize)} → ${formatBytes(model.rightSize)} (${deltaText})`,
	});
	if (model.forceTextAvailable && !forceText) {
		textButton(wrap, "Show differences anyway").onClick(onForceText);
	} else if (forceText) {
		wrap.createDiv({
			cls: "mdsync-diff-hint",
			text: "File is too large or not text to diff.",
		});
	}
}
