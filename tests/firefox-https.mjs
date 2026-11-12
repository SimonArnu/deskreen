import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function openTrustedFirefox({ hostname, port, room, caPath }) {
	const directory = await mkdtemp(
		join(
			process.env.FIREFOX_PROFILE_ROOT || tmpdir(),
			'deskreen-firefox-test-',
		),
	);
	const untrustedProfile = join(directory, 'untrusted');
	const trustedProfile = join(directory, 'trusted');
	let driver;
	let driverClosed;
	let driverOutput = '';
	let base;
	let activeSession;
	async function call(path, method = 'GET', body) {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: { 'content-type': 'application/json' },
			body: body && JSON.stringify(body),
		});
		const { value } = await response.json();
		if (!response.ok) {
			const error = new Error(value.message);
			error.code = value.error;
			throw error;
		}
		return value;
	}
	async function createSession(profile) {
		const result = await call('/session', 'POST', {
			capabilities: {
				alwaysMatch: {
					browserName: 'firefox',
					acceptInsecureCerts: false,
					'moz:firefoxOptions': {
						args: ['-headless', '-profile', profile],
						prefs: { 'network.dns.localDomains': `${hostname},wrong.local` },
					},
				},
			},
		});
		activeSession = result.sessionId;
	}
	async function navigate(url) {
		return call(`/session/${activeSession}/url`, 'POST', { url });
	}
	async function closeSession() {
		if (!activeSession) return;
		await call(`/session/${activeSession}`, 'DELETE');
		activeSession = undefined;
	}
	async function cleanup() {
		if (driver) {
			if (driver.exitCode === null && driver.signalCode === null) driver.kill();
			await driverClosed;
		}
		await rm(directory, { recursive: true, force: true });
	}
	try {
		await mkdir(untrustedProfile, { mode: 0o700 });
		await mkdir(trustedProfile, { mode: 0o700 });
		const certutil = process.env.CERTUTIL || 'certutil';
		for (const profile of [untrustedProfile, trustedProfile]) {
			execFileSync(
				certutil,
				['-N', '-d', `sql:${profile}`, '--empty-password'],
				{ stdio: 'pipe' },
			);
		}
		execFileSync(
			certutil,
			[
				'-A',
				'-d',
				`sql:${trustedProfile}`,
				'-n',
				'Deskreen test CA',
				'-t',
				'C,,',
				'-a',
				'-i',
				caPath,
			],
			{ stdio: 'pipe' },
		);
		driver = spawn(
			process.env.GECKODRIVER || 'geckodriver',
			['--host', '127.0.0.1', '--port', '0'],
			{ stdio: ['ignore', 'pipe', 'pipe'] },
		);
		driverClosed = new Promise((resolve) => {
			driver.once('close', resolve);
			driver.once('error', resolve);
		});
		const address = await new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`geckodriver did not start: ${driverOutput}`)),
				15000,
			);
			for (const stream of [driver.stdout, driver.stderr])
				stream.on('data', (data) => {
					driverOutput += data;
					const match = driverOutput.match(/Listening on (127\.0\.0\.1:\d+)/);
					if (match) {
						clearTimeout(timeout);
						resolve(match[1]);
					}
				});
			driver.once('error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			driver.once('exit', (code) => {
				clearTimeout(timeout);
				reject(new Error(`geckodriver exited ${code}: ${driverOutput}`));
			});
		});
		base = `http://${address}`;
		const url = `https://${hostname}:${port}/${room}`;
		await createSession(untrustedProfile);
		await assert.rejects(navigate(url), { code: 'insecure certificate' });
		await closeSession();
		await createSession(trustedProfile);
		await assert.rejects(navigate(`https://wrong.local:${port}/${room}`), {
			code: 'insecure certificate',
		});
		await navigate(url);
		return {
			async execute(script) {
				return call(`/session/${activeSession}/execute/sync`, 'POST', {
					script,
					args: [],
				});
			},
			async navigate(url) {
				return navigate(url);
			},
			async text() {
				return call(`/session/${activeSession}/execute/sync`, 'POST', {
					script: 'return document.body.innerText',
					args: [],
				});
			},
			async close() {
				try {
					await closeSession();
				} finally {
					await cleanup();
				}
			},
		};
	} catch (error) {
		await closeSession().catch(() => {});
		await cleanup();
		throw new Error(`Firefox HTTPS test failed: ${driverOutput}`, {
			cause: error,
		});
	}
}
