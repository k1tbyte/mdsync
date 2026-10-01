import type { Person } from "@/presence";
import { personColor } from "@/shared/colors";
import { withDevices } from "@/shared/format";

/** More faces than this collapse into a "+N". */
const STACK_MAX = 3;

/** A person as a ring in their colour around their initial: nothing to fetch or store. */
export function renderAvatar(
	parent: HTMLElement | DocumentFragment,
	person: Pick<Person, "key" | "name" | "idle">,
): HTMLElement {
	const avatar = parent.createSpan({
		cls: "obsync-avatar",
		text: initialOf(person.name),
	});
	avatar.setCssProps({ "--obsync-person": personColor(person.key) });
	avatar.toggleClass("is-idle", person.idle);
	return avatar;
}

export function renderAvatarStack(
	parent: HTMLElement,
	people: readonly Person[],
): HTMLElement {
	const stack = parent.createSpan({ cls: "obsync-avatars" });
	for (const person of people.slice(0, STACK_MAX)) renderAvatar(stack, person);
	if (people.length > STACK_MAX) {
		stack.createSpan({
			cls: "obsync-avatar is-more",
			text: `+${people.length - STACK_MAX}`,
		});
	}
	return stack;
}

/** "Alex · Laptop, Sam (away)" */
export function describePeople(people: readonly Person[]): string {
	return people
		.map(({ name, devices, idle }) => {
			const label = withDevices(name, devices);
			return idle ? `${label} (away)` : label;
		})
		.join(", ");
}

function initialOf(name: string): string {
	return ([...name.trim()][0] ?? "?").toLocaleUpperCase();
}
