import { randomBytes } from 'node:crypto';

export function createRoomId(): string {
	return randomBytes(24).toString('base64url');
}
