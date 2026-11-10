export class AttemptLimit {
	private entries = new Map<string, { started: number; count: number }>();
	private limit: number;
	private windowMs: number;
	private capacity: number;

	constructor(limit: number, windowMs: number, capacity: number) {
		this.limit = limit;
		this.windowMs = windowMs;
		this.capacity = capacity;
	}

	allow(address: string, now = Date.now()): boolean {
		const current = this.entries.get(address);
		if (
			current &&
			now >= current.started &&
			now - current.started < this.windowMs
		) {
			if (current.count >= this.limit) return false;
			current.count += 1;
			return true;
		}
		if (current) this.entries.delete(address);
		if (this.entries.size >= this.capacity) {
			for (const [key, entry] of this.entries) {
				if (now < entry.started || now - entry.started >= this.windowMs)
					this.entries.delete(key);
			}
		}
		if (this.entries.size >= this.capacity) return false;
		this.entries.set(address, { started: now, count: 1 });
		return true;
	}
}
