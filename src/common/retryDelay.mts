export class RetryDelay {
	private delay = 1000;

	next(): number {
		const result = this.delay;
		this.delay = Math.min(this.delay * 2, 30_000);
		return result;
	}

	reset(): void {
		this.delay = 1000;
	}
}
