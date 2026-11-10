import assert from 'node:assert/strict';
import test from 'node:test';
import { mainWindowPosition } from '../src/main/helpers/mainWindowPosition.mts';

test('centres the main window on the primary display work area', () => {
	assert.deepEqual(
		mainWindowPosition({ x: 3840, y: 40, width: 1920, height: 1040 }, 940, 640),
		{ x: 4330, y: 240 },
	);
});

test('keeps the top left in the work area when it is smaller than the window', () => {
	assert.deepEqual(
		mainWindowPosition({ x: -1280, y: 24, width: 800, height: 500 }, 940, 640),
		{ x: -1280, y: 24 },
	);
});
