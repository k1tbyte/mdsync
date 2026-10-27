/** Sessions of a docId still closing: their Unsub, landing after a reopened session's Sub, would unsubscribe it. */
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
