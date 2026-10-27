export { shareKey, shareStorage } from "./access";
export { type BrokerAdmin, relayAdmin } from "./broker/share-broker";
export type { SpacesHost } from "./host";
export { INVITE_ACTION, invitePassword } from "./invite";
export { pauseOf } from "./partition";
export {
	isSpaceRecord,
	parseSpaceRecords,
	type SpaceRecord,
	shareIdentity,
} from "./record";
export { SpaceRecords } from "./records";
export { createMoveFollower, registerShareRenames } from "./share-moves";
export { createShareRegistration } from "./share-registration";
export {
	createSpaceAccess,
	type SpaceAccess,
	type SpaceAccessHost,
} from "./space-access";
export { createAccessEnded } from "./ui/access-ended";
export { createInertWarning } from "./ui/inert-warning";
export { openInvite } from "./ui/invites/invite-action";
export { lastEditLabel, lastEditor } from "./ui/last-edit";
export { registerReadOnlyLock, watchReadOnlyRoots } from "./ui/read-only";
export { sharesSection } from "./ui/shares-section";
export { askSpaceGone, createSpaceGone } from "./ui/space-gone";
export { addShareMenuItem, openShareWindow } from "./ui/window/share-window";
