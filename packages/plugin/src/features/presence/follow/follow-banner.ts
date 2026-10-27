import { ButtonComponent } from "obsidian";
import { personColor } from "@/core/shared";
import { renderAvatar } from "../ui/avatars";
import type { Person } from "../views";

/** The strip under a following tab's header: whom it follows, and the way out. */
export function showFollowBanner(
	view: HTMLElement,
	person: Pick<Person, "key" | "name">,
	stop: () => void,
): HTMLElement {
	const banner = createDiv({ cls: "mdsync-follow-banner" });
	banner.setCssProps({ "--mdsync-person": personColor(person.key) });
	renderAvatar(banner, { ...person, idle: false });
	const text = banner.createSpan({ cls: "mdsync-follow-text" });
	text.appendText("Following ");
	text.createEl("strong", { text: person.name });
	text.createSpan({
		cls: "mdsync-follow-why",
		text: ": this tab opens the notes they open.",
	});
	new ButtonComponent(banner).setButtonText("Stop following").onClick(stop);
	const header = view.querySelector(":scope > .view-header");
	if (header) header.after(banner);
	else view.prepend(banner);
	return banner;
}
