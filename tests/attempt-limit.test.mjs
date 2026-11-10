import assert from 'node:assert/strict';
import test from 'node:test';
import { AttemptLimit } from '../src/server/AttemptLimit.mts';

test('limits attempts per address and allows them after the window', () => {
	const limit = new AttemptLimit(2, 1000, 5);
	assert.equal(limit.allow('a', 0), true);
	assert.equal(limit.allow('a', 1), true);
	assert.equal(limit.allow('a', 2), false);
	assert.equal(limit.allow('b', 2), true);
	assert.equal(limit.allow('a', 1000), true);
});

test('bounds memory and frees expired entries', () => {
	const limit = new AttemptLimit(2, 1000, 2);
	assert.equal(limit.allow('a', 0), true);
	assert.equal(limit.allow('b', 1), true);
	assert.equal(limit.allow('c', 2), false);
	assert.equal(limit.allow('a', 2), true);
	assert.equal(limit.allow('c', 1000), true);
});
