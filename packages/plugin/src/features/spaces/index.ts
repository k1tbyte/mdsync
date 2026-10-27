export { shareKey, shareStorage } from "./access";
export { ADMIN_HEADER, type BrokerAdmin } from "./broker/share-broker";
export { INVITE_ACTION, invitePassword } from "./invite";
export { lastEditLabel, lastEditor } from "./last-edit";
export { pauseOf } from "./partition";
export { isSpaceRecord, type SpaceRecord, shareIdentity } from "./record";
export { SpaceRecords } from "./records";
export { createMoveFollower, registerShareRenames } from "./share-moves";
export { createShareRegistration } from "./share-registration";
export {
	createSpaceAccess,
	type SpaceAccess,
	type SpaceAccessHost,
} from "./space-access";
export { createAccessEnded } from "./ui/access-ended";
export { openInvite } from "./ui/invites/invite-action";
export { registerReadOnlyLock, watchReadOnlyRoots } from "./ui/read-only";
export { sharesSection } from "./ui/shares-section";
export { askSpaceGone, createSpaceGone } from "./ui/space-gone";
export { addShareMenuItem, openShareWindow } from "./ui/window/share-window";
