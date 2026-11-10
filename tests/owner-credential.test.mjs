import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { isOwnerCredential, canQueueRoomLock } from '../src/server/origin.mts';

test('accepts the exact owner token only from loopback', () => {
	const expected = randomBytes(32).toString('base64url');
	assert.equal(isOwnerCredential('127.0.0.1', expected, expected), true);
	assert.equal(isOwnerCredential('192.168.1.2', expected, expected), false);
	assert.equal(isOwnerCredential('127.0.0.1', 'incorrect', expected), false);
	assert.equal(isOwnerCredential('127.0.0.1', null, expected), false);
});

test('only an admitted owner can queue a bounded number of lock changes', () => {
	const token = randomBytes(32).toString('base64url');
	assert.equal(canQueueRoomLock(true, '127.0.0.1', token, token, 0), true);
	assert.equal(canQueueRoomLock(false, '127.0.0.1', token, token, 0), false);
	assert.equal(canQueueRoomLock(true, '127.0.0.1', 'invalid', token, 0), false);
	assert.equal(canQueueRoomLock(true, '192.168.1.2', token, token, 0), false);
	assert.equal(canQueueRoomLock(true, '127.0.0.1', token, token, 8), false);
});
