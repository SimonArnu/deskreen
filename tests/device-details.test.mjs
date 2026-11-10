import assert from 'node:assert/strict';
import test from 'node:test';
import { canAcceptDeviceDetails } from '../src/renderer/src/features/PeerConnection/deviceDetails.mts';

test('device details are accepted only for the current partner once', () => {
	assert.equal(canAcceptDeviceDetails('current', '', '', 'current'), true);
	assert.equal(
		canAcceptDeviceDetails('current', 'current', 'device-id', 'current'),
		false,
	);
	assert.equal(
		canAcceptDeviceDetails('replacement', 'old', 'old-id', 'old'),
		false,
	);
	assert.equal(canAcceptDeviceDetails('', '', '', ''), false);
	assert.equal(
		canAcceptDeviceDetails('replacement', 'old', 'old-id', 'replacement'),
		true,
	);
});
