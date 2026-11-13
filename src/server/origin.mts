import { timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';

export function isLoopback(address: string): boolean {
	return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

export function isOwnerCredential(
	address: string,
	token: unknown,
	expected: string,
): boolean {
	if (!isLoopback(address) || typeof token !== 'string') return false;
	const actualBytes = Buffer.from(token);
	const expectedBytes = Buffer.from(expected);
	return (
		actualBytes.length === expectedBytes.length &&
		timingSafeEqual(actualBytes, expectedBytes)
	);
}

export function canQueueRoomLock(
	admitted: boolean,
	address: string,
	token: unknown,
	expected: string,
	pending: number,
): boolean {
	return admitted && pending < 8 && isOwnerCredential(address, token, expected);
}

export function isAllowedOrigin(
	origin: string | undefined,
	address: string,
	hostname: string,
	port: number,
	ownerAuthenticated = false,
	viewerAddresses: readonly string[] = [],
): boolean {
	if (origin === undefined) return true;
	if (origin === 'null' || origin === 'file://')
		return isLoopback(address) && ownerAuthenticated;
	return (
		origin === new URL(`https://${hostname}:${port}`).origin ||
		viewerAddresses.some(
			(ip) => isIPv4(ip) && origin === new URL(`https://${ip}:${port}`).origin,
		)
	);
}
