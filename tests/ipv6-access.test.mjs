import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedPeer } from '../src/server/ipv6Access.mts';

const interfaces = [
	{
		family: 'IPv6',
		address: '2001:db8:1234:5678::1',
		cidr: '2001:db8:1234:5678::1/64',
		internal: false,
	},
	{
		family: 'IPv6',
		address: 'fd12:3456:789a::1',
		cidr: 'fd12:3456:789a::1/64',
		internal: false,
	},
	{ family: 'IPv6', address: 'fe80::1%2', cidr: 'fe80::1/64', internal: false },
];

test('IPv6 connections must originate on the subnet of the destination interface', () => {
	assert.equal(
		isAllowedPeer(
			'2001:db8:1234:5678::42',
			'2001:db8:1234:5678::1',
			interfaces,
		),
		true,
	);
	assert.equal(
		isAllowedPeer(
			'2001:db8:1234:9999::42',
			'2001:db8:1234:5678::1',
			interfaces,
		),
		false,
	);
	assert.equal(
		isAllowedPeer('fd12:3456:789a::42', 'fd12:3456:789a::1', interfaces),
		true,
	);
	assert.equal(isAllowedPeer('fe80::42%2', 'fe80::1%2', interfaces), true);
	assert.equal(
		isAllowedPeer('fd12:3456:789a::42', '2001:db8:1234:5678::1', interfaces),
		false,
	);
	assert.equal(
		isAllowedPeer('2001:db8:1234:5678::42', '2001:db8:ffff::1', interfaces),
		false,
	);
	assert.equal(isAllowedPeer('::1', '::1', interfaces), true);
	assert.equal(
		isAllowedPeer('::1', '2001:db8:1234:5678::1', interfaces),
		false,
	);
});

test('IPv4 connections keep existing behavior and invalid IPv6 is rejected', () => {
	assert.equal(isAllowedPeer('192.168.1.5', '192.168.1.1', interfaces), true);
	assert.equal(
		isAllowedPeer('::ffff:192.168.1.5', '::ffff:192.168.1.1', interfaces),
		true,
	);
	assert.equal(isAllowedPeer('not-an-address', '::1', interfaces), false);
	assert.equal(isAllowedPeer('2001:db8:1234:5678::42', '', interfaces), false);
	assert.equal(
		isAllowedPeer('2001:db8:1234:5678::42', '2001:db8:1234:5678::1', []),
		false,
	);
});

test('broad interface prefixes do not permit off-link IPv6 sources', () => {
	const broad = [
		{
			family: 'IPv6',
			address: '2001:db8:1234:5678::1',
			cidr: '2001:db8:1234:5678::1/48',
			internal: false,
		},
	];
	assert.equal(
		isAllowedPeer('2001:db8:1234:5678::2', '2001:db8:1234:5678::1', broad),
		true,
	);
	assert.equal(
		isAllowedPeer('2001:db8:1234:9876::2', '2001:db8:1234:5678::1', broad),
		false,
	);
});
