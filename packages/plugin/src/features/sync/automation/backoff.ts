const SCHEDULER_BACKOFF_THRESHOLD = 3;

const SCHEDULER_BACKOFF_BASE_MS = 2 * 60_000;

const SCHEDULER_BACKOFF_MAX_MS = 60 * 60_000;

export class Backoff {
	private failures = 0;
	private until = 0;

	fail(now = Date.now()): void {
		this.failures++;
		if (this.failures < SCHEDULER_BACKOFF_THRESHOLD) return;
		const exp = this.failures - SCHEDULER_BACKOFF_THRESHOLD;
		const delay = Math.min(
			SCHEDULER_BACKOFF_BASE_MS * 2 ** exp,
			SCHEDULER_BACKOFF_MAX_MS,
		);
		this.until = now + delay;
	}

	succeed(): void {
		this.failures = 0;
		this.until = 0;
	}

	blocks(now = Date.now()): boolean {
		return now < this.until;
	}
}
