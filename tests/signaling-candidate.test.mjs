import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEndOfCandidates } from '../src/common/signalingCandidate.mts';

test('recognizes an empty ICE candidate without dropping offers or real candidates', () => {
	assert.equal(
		isEndOfCandidates({ candidate: { candidate: '', sdpMid: '0' } }),
		true,
	);
	assert.equal(
		isEndOfCandidates({
			candidate: { candidate: 'candidate:1 1 UDP 1 127.0.0.1 42 typ host' },
		}),
		false,
	);
	assert.equal(isEndOfCandidates({ type: 'offer', sdp: 'v=0' }), false);
	assert.equal(isEndOfCandidates(null), false);
	assert.equal(isEndOfCandidates({ candidate: null }), false);
});
