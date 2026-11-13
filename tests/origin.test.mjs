import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedOrigin, isLoopback } from '../src/server/origin.mts';

test('only exact loopback addresses identify a local connection', () => {
	for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
		assert.equal(isLoopback(address), true);
	for (const address of [
		'',
		'192.168.1.2',
		'::ffff:192.168.1.2',
		'evil127.0.0.1',
	])
		assert.equal(isLoopback(address), false);
});

test('allows the advertised HTTPS origin and local helper, not foreign pages', () => {
	assert.equal(
		isAllowedOrigin(
			'https://deskreen.local:3131',
			'192.168.1.2',
			'deskreen.local',
			3131,
		),
		true,
	);
	assert.equal(
		isAllowedOrigin('null', '127.0.0.1', 'deskreen.local', 3131, true),
		true,
	);
	assert.equal(
		isAllowedOrigin('null', '127.0.0.1', 'deskreen.local', 3131, false),
		false,
	);
	assert.equal(
		isAllowedOrigin('file://', '127.0.0.1', 'deskreen.local', 3131, true),
		true,
	);
	assert.equal(
		isAllowedOrigin('file://', '127.0.0.1', 'deskreen.local', 3131, false),
		false,
	);
	assert.equal(
		isAllowedOrigin('file://', '192.168.1.2', 'deskreen.local', 3131, true),
		false,
	);
	assert.equal(
		isAllowedOrigin(undefined, '192.168.1.2', 'deskreen.local', 3131),
		true,
	);
	for (const origin of [
		'null',
		'https://evil.local:3131',
		'http://deskreen.local:3131',
		'https://deskreen.local:3132',
		'https://deskreen.local.evil:3131',
	]) {
		assert.equal(
			isAllowedOrigin(origin, '192.168.1.2', 'deskreen.local', 3131),
			false,
		);
	}
	assert.equal(
		isAllowedOrigin(
			'https://deskreen.local',
			'192.168.1.2',
			'deskreen.local',
			443,
		),
		true,
	);
});

test('allows only the issued LAN IP origins on the configured HTTPS port', () => {
	const allowed = ['192.168.1.25', '10.2.3.4'];
	assert.equal(
		isAllowedOrigin(
			'https://192.168.1.25:3131',
			'192.168.1.2',
			'deskreen.local',
			3131,
			false,
			allowed,
		),
		true,
	);
	assert.equal(
		isAllowedOrigin(
			'https://192.168.1.25',
			'192.168.1.2',
			'deskreen.local',
			443,
			false,
			allowed,
		),
		true,
	);
	assert.equal(
		isAllowedOrigin(
			'https://10.2.3.4:3131',
			'192.168.1.2',
			'deskreen.local',
			3131,
			false,
			allowed,
		),
		true,
	);
	for (const origin of [
		'https://192.168.1.26:3131',
		'http://192.168.1.25:3131',
		'https://192.168.1.25:3132',
		'https://192.168.1.25.evil:3131',
	]) {
		assert.equal(
			isAllowedOrigin(
				origin,
				'192.168.1.2',
				'deskreen.local',
				3131,
				false,
				allowed,
			),
			false,
		);
	}
});
