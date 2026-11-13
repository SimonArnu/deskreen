import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CertificateSetup } from '../src/server/certificateSetup.mts';
import { loadCertificates } from '../src/server/certificates.mts';
import { connectDevtools } from './devtools.mjs';

const directory = await mkdtemp(join(tmpdir(), 'deskreen-setup-browser-'));
const credentials = loadCertificates(
	join(directory, 'certificates'),
	'deskreen.local',
);
const setup = new CertificateSetup();
const info = await setup.start('127.0.0.1', credentials.ca);
const browser = spawn(
	process.env.CHROME_BIN || '/opt/google/chrome/chrome',
	[
		'--headless',
		'--disable-gpu',
		'--disable-background-networking',
		'--disable-sync',
		'--no-first-run',
		'--disable-default-apps',
		'--remote-debugging-port=0',
		`--user-data-dir=${join(directory, 'profile')}`,
		'about:blank',
	],
	{ stdio: ['ignore', 'ignore', 'pipe'] },
);
const browserClosed = once(browser, 'close');
let output = '';
browser.stderr.on('data', (data) => {
	output += data;
});
let devtools;
let failure;
let downloadTimeout;
let removeDownloadListener;
try {
	const endpoint = await new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`Chrome did not start: ${output}`)),
			10000,
		);
		browser.stderr.on('data', () => {
			const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
			if (match) {
				clearTimeout(timeout);
				resolve(match[1]);
			}
		});
		browser.once('error', reject);
		browser.once('exit', (code) =>
			reject(new Error(`Chrome exited ${code}: ${output}`)),
		);
	});
	devtools = await connectDevtools(endpoint);
	await devtools.send('Browser.setDownloadBehavior', {
		behavior: 'allow',
		downloadPath: directory,
		eventsEnabled: true,
	});
	const { targetId } = await devtools.send('Target.createTarget', {
		url: 'about:blank',
	});
	const { sessionId } = await devtools.send('Target.attachToTarget', {
		targetId,
		flatten: true,
	});
	await devtools.send('Page.enable', {}, sessionId);
	await devtools.send('Page.navigate', { url: info.url }, sessionId);
	const deadline = Date.now() + 10000;
	let ready = false;
	while (Date.now() < deadline) {
		const result = await devtools.send(
			'Runtime.evaluate',
			{
				expression: 'Boolean(document.querySelector(\'a[href="/ca.cer"]\'))',
				returnByValue: true,
			},
			sessionId,
		);
		if (result.result.value) {
			ready = true;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(ready, true, 'The setup page was not displayed');
	let guid;
	let suggestedFilename;
	const download = new Promise((resolve, reject) => {
		downloadTimeout = setTimeout(
			() => reject(new Error('Certificate download timed out')),
			10000,
		);
		removeDownloadListener = devtools.onEvent((event) => {
			if (event.method === 'Browser.downloadWillBegin') {
				guid = event.params.guid;
				suggestedFilename = event.params.suggestedFilename;
			}
			if (
				event.method === 'Browser.downloadProgress' &&
				event.params.guid === guid
			) {
				if (event.params.state === 'completed') {
					clearTimeout(downloadTimeout);
					resolve();
				}
				if (event.params.state === 'canceled') {
					clearTimeout(downloadTimeout);
					reject(new Error('Download was canceled'));
				}
			}
		});
	});
	await devtools.send(
		'Runtime.evaluate',
		{ expression: 'document.querySelector(\'a[href="/ca.cer"]\').click()' },
		sessionId,
	);
	await download;
	assert.equal(suggestedFilename, 'deskreen-ca.cer');
	const downloaded = await readFile(join(directory, suggestedFilename));
	assert.equal(
		new X509Certificate(downloaded).fingerprint256,
		new X509Certificate(credentials.ca).fingerprint256,
	);
	assert.ok(downloaded.length > 0);
} catch (error) {
	failure = error;
} finally {
	clearTimeout(downloadTimeout);
	removeDownloadListener?.();
	devtools?.close();
	if (browser.exitCode === null && browser.signalCode === null) browser.kill();
	await browserClosed;
	await setup.stop();
}
const unexpected = output
	.split('\n')
	.filter(
		(line) =>
			line &&
			!/^DevTools listening on ws:\/\//.test(line) &&
			!/^\[\d+\/\d+\.\d+:WARNING:chrome\/app\/chrome_main_linux\.cc:\d+\] Read channel stable from /.test(
				line,
			),
	);
if (unexpected.length) {
	const error = new Error(
		`Unexpected browser output:\n${unexpected.join('\n')}`,
	);
	failure = failure
		? new AggregateError([failure, error], 'Browser setup test failed')
		: error;
}
if (failure) throw failure;
console.log(
	'A real browser downloaded the public CA certificate from the setup page.',
);
