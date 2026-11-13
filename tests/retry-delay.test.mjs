import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RetryDelay } from '../src/common/retryDelay.mts';

test('retry delays increase to a cap and reset after successful admission', () => {
	const retry = new RetryDelay();
	assert.deepEqual(
		Array.from({ length: 8 }, () => retry.next()),
		[1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
	);
	retry.reset();
	assert.equal(retry.next(), 1000);
});
