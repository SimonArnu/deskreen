import { createHash } from 'node:crypto';

export function roomHash(id: string): string {
	return createHash('sha256').update(id).digest('hex');
}
