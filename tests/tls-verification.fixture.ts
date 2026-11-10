import assert from 'node:assert/strict';
import { app, session } from 'electron';
import { createServer } from 'node:https';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { loadCertificates } from '../src/server/certificates.mjs';
import { verifyLocalCertificate } from '../src/main/helpers/verifyLocalCertificate.mjs';

app
	.whenReady()
	.then(async () => {
		const directory = mkdtempSync(join(tmpdir(), 'deskreen-tls-test-'));
		const trusted = loadCertificates(
			join(directory, 'trusted'),
			'deskreen.local',
		);
		const sameAuthority = loadCertificates(
			join(directory, 'trusted'),
			'renamed.local',
		);
		const other = loadCertificates(join(directory, 'other'), 'other.local');
		const makeServer = async (cert: string, key: string) => {
			const server = createServer({ cert, key }, (_req, res) => res.end('ok'));
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			return server;
		};
		const goodServer = await makeServer(trusted.cert, trusted.key);
		const badServer = await makeServer(other.cert, other.key);
		const renewedServer = await makeServer(
			sameAuthority.cert,
			sameAuthority.key,
		);
		try {
			const internal = session.fromPartition('internal-tls-test');
			internal.setCertificateVerifyProc((request, callback) => {
				callback(
					verifyLocalCertificate(
						request.hostname,
						request.certificate.data,
						trusted.cert,
					),
				);
			});
			const goodUrl = `https://127.0.0.1:${(goodServer.address() as { port: number }).port}/`;
			const badUrl = `https://127.0.0.1:${(badServer.address() as { port: number }).port}/`;
			const renewedUrl = `https://127.0.0.1:${(renewedServer.address() as { port: number }).port}/`;
			assert.equal(await (await internal.fetch(goodUrl)).text(), 'ok');
			await assert.rejects(internal.fetch(badUrl));
			await assert.rejects(internal.fetch(renewedUrl));
			assert.equal(
				verifyLocalCertificate('example.com', trusted.cert, trusted.cert),
				-3,
			);
			assert.equal(
				verifyLocalCertificate('127.0.0.1', 'invalid', trusted.cert),
				-2,
			);
			console.log('Local TLS trusts only the expected loopback certificate.');
		} finally {
			goodServer.close();
			badServer.close();
			renewedServer.close();
		}
		app.quit();
	})
	.catch((error) => {
		console.error(error);
		app.exit(1);
	});
