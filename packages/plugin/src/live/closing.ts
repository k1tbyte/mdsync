/**
 * Sessions of a docId still closing on this device. Their Unsub goes out after
 * their last edit is sealed and sent; landing after a reopened session's Sub,
 * it would unsubscribe the socket that session shares.
 */
const closing = new Map<string, Promise<void>>();

export function closedBefore(docId: string): Promise<void> | undefined {
	return closing.get(docId);
}

export function closingUntil(docId: string, closed: Promise<void>): void {
	closing.set(docId, closed);
	void closed.then(() => {
		if (closing.get(docId) === closed) closing.delete(docId);
	});
}
