import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export interface TrustedBrowser {
	id: string;
	label: string;
}

interface Entry extends TrustedBrowser {
	hash: string;
}

function tokenHash(token: unknown): string | undefined {
	if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
		return undefined;
	const bytes = Buffer.from(token, 'base64url');
	if (bytes.length !== 32 || bytes.toString('base64url') !== token)
		return undefined;
	return createHash('sha256').update(bytes).digest('hex');
}

export class TrustedBrowsers {
	private entries: Entry[];
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
		let contents: string;
		try {
			contents = readFileSync(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			this.entries = [];
			return;
		}
		const entries: unknown = JSON.parse(contents);
		if (
			!Array.isArray(entries) ||
			!entries.every(
				(entry) =>
					entry &&
					typeof entry.id === 'string' &&
					typeof entry.label === 'string' &&
					typeof entry.hash === 'string' &&
					/^[a-f0-9]{64}$/.test(entry.hash),
			)
		)
			throw new Error('Invalid trusted browser data');
		this.entries = entries as Entry[];
	}

	list(): TrustedBrowser[] {
		return this.entries.map(({ id, label }) => ({ id, label }));
	}

	find(token: unknown): TrustedBrowser | undefined {
		const hash = tokenHash(token);
		if (!hash) return undefined;
		const entry = this.entries.find((item) => item.hash === hash);
		return entry && { id: entry.id, label: entry.label };
	}

	remember(token: unknown, label: string): TrustedBrowser | undefined {
		const hash = tokenHash(token);
		if (!hash || this.entries.some((entry) => entry.hash === hash))
			return undefined;
		const entry = { id: randomUUID(), label: label.slice(0, 128), hash };
		this.save([...this.entries, entry]);
		return { id: entry.id, label: entry.label };
	}

	revoke(id: string): boolean {
		const entries = this.entries.filter((entry) => entry.id !== id);
		if (entries.length === this.entries.length) return false;
		this.save(entries);
		return true;
	}

	private save(entries: Entry[]): void {
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify(entries), {
				mode: 0o600,
				flag: 'wx',
			});
			renameSync(temporary, this.file);
		} catch (error) {
			try {
				unlinkSync(temporary);
			} catch (cleanupError) {
				if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT')
					throw new AggregateError([error, cleanupError]);
			}
			throw error;
		}
		this.entries = entries;
	}
}
