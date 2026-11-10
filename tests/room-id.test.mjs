import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomId } from '../src/server/RoomIDService/createRoomId.mts';

test('room capabilities are unique 192-bit URL-safe values', () => {
	const ids = Array.from({ length: 256 }, () => createRoomId());
	assert.equal(new Set(ids).size, ids.length);
	for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{32}$/);
});
