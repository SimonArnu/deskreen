import assert from 'node:assert/strict';
import test from 'node:test';
import { runInRoom } from '../src/server/roomQueue.mts';

test('serializes operations in the same room without blocking other rooms', async () => {
	const events = [];
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const first = runInRoom('a', async () => {
		events.push('first');
		await gate;
		events.push('first done');
	});
	const second = runInRoom('a', async () => {
		events.push('second');
	});
	const other = runInRoom('b', async () => {
		events.push('other');
	});
	await other;
	assert.deepEqual(events, ['first', 'other']);
	release();
	await Promise.all([first, second]);
	assert.deepEqual(events, ['first', 'other', 'first done', 'second']);
});

test('a failed operation does not prevent later operations', async () => {
	const failed = runInRoom('a', async () => {
		throw new Error('expected');
	});
	const next = runInRoom('a', async () => 'ok');
	await assert.rejects(failed, /expected/);
	assert.equal(await next, 'ok');
});
