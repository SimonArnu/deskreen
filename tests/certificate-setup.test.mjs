import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCertificates } from '../src/server/certificates.mts';
import {
	CertificateSetup,
	isLocalIPv4,
	getSetupInterfaces,
	getViewerInterfaces,
} from '../src/server/certificateSetup.mts';

const directory = mkdtempSync(join(tmpdir(), 'deskreen-setup-test-'));
const credentials = loadCertificates(
	join(directory, 'certificates'),
	'deskreen.local',
);

test('setup addresses are private or link-local IPv4, never loopback or public', () => {
	for (const address of [
		'10.0.0.5',
		'172.16.0.1',
		'172.31.255.254',
		'192.168.1.3',
		'169.254.1.2',
	])
		assert.equal(isLocalIPv4(address), true, address);
	for (const address of [
		'127.0.0.1',
		'172.15.1.1',
		'172.32.1.1',
		'8.8.8.8',
		'::1',
		'0.0.0.0',
		'invalid',
	])
		assert.equal(isLocalIPv4(address), false, address);
	for (const entry of getSetupInterfaces())
		assert.equal(isLocalIPv4(entry.address), true);
});

test('only currently present certificate-backed addresses are offered to viewers', () => {
	const current = [
		{ name: 'wifi', address: '192.168.1.25' },
		{ name: 'bridge', address: '172.18.0.1' },
	];
	assert.deepEqual(
		getViewerInterfaces(current, ['172.18.0.1', '192.168.1.25']),
		{
			viewerInterfaces: current,
			viewerAddressesChanged: false,
		},
	);
	assert.deepEqual(getViewerInterfaces(current, ['192.168.1.25', '10.0.0.2']), {
		viewerInterfaces: [current[0]],
		viewerAddressesChanged: true,
	});
	assert.deepEqual(getViewerInterfaces([], ['192.168.1.25']), {
		viewerInterfaces: [],
		viewerAddressesChanged: true,
	});
});

function get(url, options = {}) {
	return new Promise((resolve, reject) => {
		const req = request(url, options, (response) => {
			const chunks = [];
			response.on('data', (chunk) => chunks.push(chunk));
			response.on('end', () =>
				resolve({
					status: response.statusCode,
					headers: response.headers,
					body: Buffer.concat(chunks),
				}),
			);
		});
		req.on('error', reject);
		req.end();
	});
}

test('the temporary HTTP server serves only instructions and the public CA', async () => {
	const setup = new CertificateSetup();
	try {
		const info = await setup.start('127.0.0.1', credentials.ca);
		assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
		const page = await get(info.url);
		assert.equal(page.status, 200);
		assert.match(page.body.toString(), /fingerprint/i);
		assert.match(page.body.toString(), /independent|trusted/i);
		assert.doesNotMatch(page.body.toString(), /PRIVATE KEY|https:\/\/|roomId/i);
		assert.equal(page.headers['cache-control'], 'no-store');
		assert.match(page.headers['content-security-policy'], /default-src 'none'/);
		const certificate = await get(new URL('ca.cer', info.url));
		assert.equal(certificate.status, 200);
		assert.equal(
			certificate.headers['content-type'],
			'application/octet-stream',
		);
		assert.match(certificate.headers['content-disposition'], /attachment/);
		assert.equal(
			new X509Certificate(certificate.body).fingerprint256,
			new X509Certificate(credentials.ca).fingerprint256,
		);
		assert.deepEqual(certificate.body, new X509Certificate(credentials.ca).raw);
		assert.equal((await get(new URL('ca.key', info.url))).status, 404);
		assert.equal((await get(new URL('socket.io/', info.url))).status, 404);
		assert.equal((await get(info.url, { method: 'POST' })).status, 405);
		assert.equal(
			(await get(info.url, { headers: { host: 'attacker.example' } })).status,
			400,
		);
		assert.equal(
			(await get(info.url, { headers: { origin: 'https://attacker.example' } }))
				.status,
			403,
		);
		const otherAddress = new URL(info.url);
		otherAddress.hostname = '127.0.0.2';
		await assert.rejects(get(otherAddress));
		await assert.rejects(setup.start('127.0.0.1', credentials.cert));
		assert.equal((await get(info.url)).status, 200);
		await setup.stop();
		assert.equal(setup.status(), null);
		await assert.rejects(get(info.url));
	} finally {
		await setup.stop();
	}
});

test('setup expires and does not leave the download endpoint open', async () => {
	const setup = new CertificateSetup();
	const closed = once(setup, 'closed');
	const info = await setup.start('127.0.0.1', credentials.ca, 300);
	assert.equal((await get(info.url)).status, 200);
	await closed;
	assert.equal(setup.status(), null);
	await assert.rejects(get(info.url));
});

test('a stop queued during startup cannot leave a server running', async () => {
	const setup = new CertificateSetup();
	const starting = setup.start('127.0.0.1', credentials.ca);
	const stopping = setup.stop();
	const info = await starting;
	await stopping;
	assert.equal(setup.status(), null);
	await assert.rejects(get(info.url));
});

test('setup refuses wildcard or public bind addresses', async () => {
	const setup = new CertificateSetup();
	try {
		await assert.rejects(
			setup.start('0.0.0.0', credentials.ca),
			/Invalid setup address/,
		);
		await assert.rejects(
			setup.start('8.8.8.8', credentials.ca),
			/Invalid setup address/,
		);
		assert.equal(setup.status(), null);
	} finally {
		await setup.stop();
	}
});

test('restarting setup closes the previous endpoint without expiring the replacement', async () => {
	const setup = new CertificateSetup();
	try {
		const first = await setup.start('127.0.0.1', credentials.ca, 80);
		const second = await setup.start('127.0.0.1', credentials.ca, 1000);
		if (first.url !== second.url) await assert.rejects(get(first.url));
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal((await get(second.url)).status, 200);
		assert.equal(setup.status().url, second.url);
	} finally {
		await setup.stop();
	}
});
