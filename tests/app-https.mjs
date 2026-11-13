import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { getLocalHostname } from '../src/main/helpers/localHostname.mts';
import { connectDevtools } from './devtools.mjs';
import { openTrustedFirefox } from './firefox-https.mjs';

const directory = await mkdtemp(join(tmpdir(), 'deskreen-app-test-'));
const config = join(directory, 'deskreen-ce');
await mkdir(config, { mode: 0o755 });
await chmod(config, 0o755);
const hostname = getLocalHostname();
const certificatePath = join(config, 'security', 'certificates', 'ca.crt');
const freePort = createServer();
freePort.listen(0, '127.0.0.1');
await once(freePort, 'listening');
const { port } = freePort.address();
await new Promise((resolve) => freePort.close(resolve));
const env = {
	...process.env,
	XDG_CONFIG_HOME: directory,
	START_MINIMIZED: process.argv.includes('--live') ? 'false' : 'true',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(
	process.env.ELECTRON_BINARY || 'node_modules/.bin/electron',
	[
		'.',
		'--port',
		String(port),
		'--remote-debugging-port=0',
		...(process.argv.includes('--live') &&
		process.env.XDG_SESSION_TYPE === 'x11'
			? ['--disable-gpu']
			: []),
	],
	{ env, stdio: ['ignore', 'pipe', 'pipe'] },
);
const closed = new Promise((resolve) => {
	app.once('close', resolve);
	app.once('error', resolve);
});
let output = '';
let errors = '';
const errorTimes = [];
const phases = [];
let devtools;
let viewer;
let observer;
let replacement;
let returning;
let failure;
let successMessage;
const signalingEvents = [];
app.stdout.on('data', (data) => {
	output += data;
});
app.stderr.on('data', (data) => {
	errors += data;
	if (process.argv.includes('--live'))
		errorTimes.push({ time: Date.now(), text: String(data).trim() });
});
try {
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() =>
				reject(new Error(`Application did not start:\n${output}\n${errors}`)),
			10000,
		);
		app.stdout.on('data', () => {
			if (output.includes('signaling server is online')) {
				clearTimeout(timeout);
				resolve();
			}
		});
		app.once('error', (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		app.once('exit', (code) => {
			clearTimeout(timeout);
			reject(new Error(`Application exited ${code}:\n${output}\n${errors}`));
		});
	});
	const certificates = { ca: await readFile(certificatePath, 'utf8') };
	const status = await new Promise((resolve, reject) => {
		const req = request(
			{ host: '127.0.0.1', port, servername: hostname, ca: certificates.ca },
			(res) => {
				res.resume();
				res.on('end', () => resolve(res.statusCode));
			},
		);
		req.once('error', reject);
		req.end();
	});
	assert.equal(status, 200);
	await assert.rejects(
		new Promise((resolve, reject) => {
			const req = httpRequest({ host: '127.0.0.1', port }, resolve);
			req.once('error', reject);
			req.end();
		}),
	);
	await assert.rejects(
		new Promise((resolve, reject) => {
			const req = request(
				{ host: '127.0.0.1', port, servername: hostname },
				resolve,
			);
			req.once('error', reject);
			req.end();
		}),
	);
	const unknownPath = await new Promise((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port,
				servername: hostname,
				ca: certificates.ca,
				path: '/certificates/ca.key',
			},
			(res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (data) => {
					body += data;
				});
				res.on('end', () => resolve(body));
			},
		);
		req.once('error', reject);
		req.end();
	});
	assert.doesNotMatch(unknownPath, /PRIVATE KEY/);
	const endpoint = await new Promise((resolve, reject) => {
		const check = () => {
			const match = errors.match(/DevTools listening on (ws:\/\/\S+)/);
			if (match) {
				clearTimeout(timeout);
				resolve(match[1]);
			}
		};
		const timeout = setTimeout(
			() => reject(new Error('DevTools endpoint not available')),
			10000,
		);
		app.stderr.on('data', check);
		check();
	});
	devtools = await connectDevtools(endpoint);
	const target = await new Promise(async (resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error('Main window did not load')),
			10000,
		);
		const check = (info) => {
			if (info.type === 'page' && info.url.endsWith('/renderer/index.html')) {
				clearTimeout(timeout);
				unsubscribe();
				resolve(info.targetId);
			}
		};
		const unsubscribe = devtools.onEvent((event) => {
			if (
				event.method === 'Target.targetCreated' ||
				event.method === 'Target.targetInfoChanged'
			)
				check(event.params.targetInfo);
		});
		try {
			await devtools.send('Target.setDiscoverTargets', { discover: true });
			const { targetInfos } = await devtools.send('Target.getTargets');
			for (const info of targetInfos) check(info);
		} catch (error) {
			clearTimeout(timeout);
			unsubscribe();
			reject(error);
		}
	});
	const { sessionId } = await devtools.send('Target.attachToTarget', {
		targetId: target,
		flatten: true,
	});
	const evaluate = async (expression) => {
		let result;
		try {
			result = await devtools.send(
				'Runtime.evaluate',
				{ expression, awaitPromise: true, returnByValue: true },
				sessionId,
			);
		} catch (error) {
			throw new Error(`Evaluation failed: ${expression}`, { cause: error });
		}
		if (result.exceptionDetails)
			throw new Error(JSON.stringify(result.exceptionDetails));
		return result.result.value;
	};
	const waitFor = async (expression, predicate, message, timeoutMs = 8000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const value = await evaluate(expression);
			if (predicate(value)) return value;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(message);
	};
	const connection = await waitFor(
		"(async () => window.electron?.ipcRenderer ? { room: await window.electron.ipcRenderer.invoke('get-waiting-for-connection-sharing-session-room-id'), visible: document.body?.innerText || '', text: document.body?.textContent || '' } : null)()",
		(value) =>
			value?.room && value.visible.includes(`https://${hostname}:${port}/`),
		'Connection information was not shown',
	);
	const { room, text } = connection;
	assert.ok(text.includes(new X509Certificate(certificates.ca).fingerprint256));
	assert.match(room, /^[A-Za-z0-9_-]{32}$/);
	const interfaces = await evaluate(
		"window.electron.ipcRenderer.invoke('get-certificate-setup-interfaces')",
	);
	assert.ok(
		interfaces.length,
		'No private IPv4 interface was available for certificate setup',
	);
	assert.equal(
		await evaluate(
			"window.electron.ipcRenderer.invoke('start-certificate-setup', '127.0.0.1')",
		),
		null,
	);
	await evaluate("document.getElementById('certificate-setup-open').click()");
	await waitFor(
		"document.getElementById('certificate-setup-interface')?.options.length",
		(value) => value > 1,
		'Certificate setup interface selection was not displayed',
	);
	assert.equal(
		await evaluate(
			"Boolean(document.querySelector('#certificate-setup-dialog .bp6-dialog-body-scroll-container'))",
		),
		true,
		'The certificate setup instructions must remain scrollable',
	);
	await evaluate(`(() => {
		const select = document.getElementById('certificate-setup-interface');
		select.value = ${JSON.stringify(interfaces[0].address)};
		select.dispatchEvent(new Event('change', { bubbles: true }));
	})()`);
	await evaluate("document.getElementById('certificate-setup-start').click()");
	const setup = await waitFor(
		"window.electron.ipcRenderer.invoke('get-certificate-setup-status')",
		(value) => Boolean(value?.url),
		'The certificate setup endpoint did not start',
	);
	assert.equal(new URL(setup.url).hostname, interfaces[0].address);
	assert.equal(
		await evaluate(
			"Boolean(document.querySelector('#certificate-setup-dialog svg'))",
		),
		true,
		'The setup QR code was not displayed',
	);
	const setupCertificate = await new Promise((resolve, reject) => {
		const req = httpRequest(new URL('/ca.cer', setup.url), (res) => {
			const parts = [];
			res.on('data', (part) => parts.push(part));
			res.on('end', () =>
				resolve({ status: res.statusCode, bytes: Buffer.concat(parts) }),
			);
		});
		req.on('error', reject);
		req.end();
	});
	assert.equal(setupCertificate.status, 200);
	assert.equal(
		new X509Certificate(setupCertificate.bytes).fingerprint256,
		new X509Certificate(certificates.ca).fingerprint256,
	);
	await evaluate("document.getElementById('certificate-setup-stop').click()");
	await waitFor(
		"window.electron.ipcRenderer.invoke('get-certificate-setup-status')",
		(value) => value === null,
		'The setup endpoint did not stop',
	);
	await assert.rejects(
		new Promise((resolve, reject) => {
			const req = httpRequest(new URL('/ca.cer', setup.url), resolve);
			req.on('error', reject);
			req.end();
		}),
	);
	await waitFor(
		"Boolean(document.getElementById('certificate-setup-start') && !document.getElementById('certificate-setup-start').disabled)",
		Boolean,
		'The certificate setup button did not reset',
	);
	await evaluate("document.getElementById('certificate-setup-start').click()");
	const restartedSetup = await waitFor(
		"window.electron.ipcRenderer.invoke('get-certificate-setup-status')",
		(value) => Boolean(value?.url),
		'Certificate setup did not restart',
	);
	await waitFor(
		"Boolean(document.getElementById('certificate-setup-close') && !document.getElementById('certificate-setup-close').disabled)",
		Boolean,
		'The certificate setup dialog could not be closed',
	);
	await evaluate("document.getElementById('certificate-setup-close').click()");
	await waitFor(
		"window.electron.ipcRenderer.invoke('get-certificate-setup-status')",
		(value) => value === null,
		'Closing the dialog did not stop certificate setup',
	);
	await assert.rejects(
		new Promise((resolve, reject) => {
			const req = httpRequest(new URL('/ca.cer', restartedSetup.url), resolve);
			req.on('error', reject);
			req.end();
		}),
	);
	const wayland =
		process.argv.includes('--live') &&
		(await evaluate(
			"window.electron.ipcRenderer.invoke('get-is-linux-wayland-session')",
		));
	const liveSources =
		process.argv.includes('--live') && !wayland
			? await evaluate(
					"window.electron.ipcRenderer.invoke('get-desktop-sharing-source-ids', {isEntireScreenToShareChosen: true})",
				)
			: [];
	if (process.argv.includes('--firefox')) {
		const firefox = await openTrustedFirefox({
			hostname,
			port,
			room,
			caPath: certificatePath,
		});
		try {
			const pending = await waitFor(
				"window.electron.ipcRenderer.invoke('get-pending-connection-device')",
				(device) => Boolean(device?.id),
				'Firefox did not reach the approval prompt',
			);
			assert.match(pending.deviceBrowser, /Firefox/);
			assert.match(await firefox.text(), /waiting/i);
			assert.equal(
				await firefox.execute(
					"return localStorage.getItem('deskreen-trusted-browser')",
				),
				null,
			);
			assert.equal(
				(
					await evaluate(
						"window.electron.ipcRenderer.invoke('get-trusted-browsers')",
					)
				).length,
				0,
			);
			await waitFor(
				"Boolean([...document.querySelectorAll('label')].find(label => label.textContent.includes('Remember this browser')))",
				Boolean,
				'The remember browser checkbox was not displayed',
			);
			assert.equal(
				await evaluate(`(() => {
				const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes('Remember this browser'));
				label.querySelector('input').click();
				return label.querySelector('input').checked;
			})()`),
				true,
			);
			await evaluate(`(() => {
				const label = [...document.querySelectorAll('label')].find(item => item.textContent.includes('Remember this browser'));
				const alert = label.closest('[role="alertdialog"]');
				const button = [...alert.querySelectorAll('button')].find(item => item.textContent.trim().toLowerCase() === 'allow');
				button.click();
			})()`);
			const trustDeadline = Date.now() + 8000;
			let saved = false;
			while (Date.now() < trustDeadline) {
				saved = await firefox.execute(
					"return !!localStorage.getItem('deskreen-trusted-browser')",
				);
				if (saved) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.equal(
				saved,
				true,
				`Firefox did not save its credential. Host: ${await evaluate('document.body.innerText')}; viewer: ${await firefox.text()}; trust count: ${(await evaluate("window.electron.ipcRenderer.invoke('get-trusted-browsers')")).length}`,
			);
			assert.equal(
				(
					await evaluate(
						"window.electron.ipcRenderer.invoke('get-trusted-browsers')",
					)
				).length,
				1,
			);
			const firefoxSetup = await evaluate(
				`window.electron.ipcRenderer.invoke('start-certificate-setup', ${JSON.stringify(interfaces[0].address)})`,
			);
			await firefox.navigate(firefoxSetup.url);
			assert.match(await firefox.text(), /independent certificate viewer/i);
			await firefox.execute(
				'document.querySelector(\'a[href="/ca.cer"]\').click()',
			);
			const downloadDeadline = Date.now() + 10000;
			let firefoxCertificate;
			while (Date.now() < downloadDeadline) {
				try {
					firefoxCertificate = await readFile(
						join(firefox.downloadDirectory, 'deskreen-ca.cer'),
					);
					if (firefoxCertificate.length) break;
				} catch (error) {
					if (error.code !== 'ENOENT') throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.ok(firefoxCertificate, 'Firefox did not download the public CA');
			assert.equal(
				new X509Certificate(firefoxCertificate).fingerprint256,
				new X509Certificate(certificates.ca).fingerprint256,
			);
			await evaluate(
				"window.electron.ipcRenderer.invoke('stop-certificate-setup')",
			);
			await firefox.navigate('about:blank');
			const newRoom = await waitFor(
				"window.electron.ipcRenderer.invoke('get-waiting-for-connection-sharing-session-room-id')",
				(value) => Boolean(value && value !== room),
				'A new room was not created after Firefox disconnected',
			);
			await firefox.navigate(`https://${hostname}:${port}/${newRoom}`);
			await waitFor(
				'document.body.innerText',
				(value) => /choose entire screen or app window/i.test(value),
				'Trusted Firefox did not reach source selection',
			);
			assert.equal(
				(
					await evaluate(
						"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
					)
				).length,
				0,
			);
			const live = process.argv.includes('--live');
			const waitForVideo = async () => {
				const deadline = Date.now() + 20000;
				while (Date.now() < deadline) {
					const playing = await firefox.execute(
						"return [...document.querySelectorAll('video')].some(video => video.videoWidth > 0 && video.currentTime > 0)",
					);
					if (playing) return;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				throw new Error(
					`Firefox did not receive live video: ${await firefox.text()}`,
				);
			};
			if (live) {
				phases.push({ phase: 'selecting source', time: Date.now() });
				let source = liveSources[0];
				if (wayland) {
					await evaluate(`(() => {
						window.__portalResult = { pending: true };
						window.electron.ipcRenderer.invoke('request-desktop-capturer-portal-source', { mode: 'screen' })
							.then(source => { window.__portalResult = { source }; })
							.catch(error => { window.__portalResult = { error: String(error) }; });
					})()`);
					const result = await waitFor(
						'window.__portalResult',
						(value) => value && !value.pending,
						'The screen-sharing portal did not respond',
						120000,
					);
					if (result.error) throw new Error(result.error);
					source = result.source;
				}
				assert.ok(source, 'No screen capture source was available');
				phases.push({ phase: 'source selected', time: Date.now() });
				await evaluate(
					`window.electron.ipcRenderer.invoke('set-desktop-capturer-source-id', ${JSON.stringify(source)})`,
				);
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
			assert.equal(
				await evaluate(
					"window.electron.ipcRenderer.invoke('start-sharing-on-waiting-for-connection-sharing-session')",
				),
				true,
			);
			const beforeReload = await waitFor(
				"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
				(value) => value.length === 1,
				'Firefox did not start a sharing session',
			);
			if (live) {
				await waitForVideo();
				phases.push({ phase: 'video started', time: Date.now() });
			}
			await firefox.navigate(`https://${hostname}:${port}/${newRoom}`);
			if (live) phases.push({ phase: 'viewer reloaded', time: Date.now() });
			const afterReload = await waitFor(
				"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
				(value) =>
					value.length === 1 &&
					value[0].socketId !== beforeReload[0].socketId &&
					!value[0].isReconnecting,
				'Firefox did not reconnect to the active session after reload',
				15000,
			);
			assert.equal(
				afterReload[0].sharingSessionID,
				beforeReload[0].sharingSessionID,
			);
			if (live) {
				await waitForVideo();
				phases.push({ phase: 'video resumed', time: Date.now() });
			}
			await evaluate(
				"[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Trusted browsers').click()",
			);
			await waitFor(
				'document.body.innerText',
				(value) => /Firefox.*Ubuntu/.test(value),
				'The trusted browser was not listed',
			);
			await evaluate(
				"[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Revoke').click()",
			);
			if (live) phases.push({ phase: 'trust revoked', time: Date.now() });
			await waitFor(
				"window.electron.ipcRenderer.invoke('get-trusted-browsers')",
				(value) => value.length === 0,
				'The browser trust was not revoked',
			);
			await waitFor(
				"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
				(value) => value.length === 0,
				'Revoking trust did not disconnect Firefox',
			);
			await evaluate(
				"[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Close').click()",
			);
			const revokedRoom = await waitFor(
				"window.electron.ipcRenderer.invoke('get-waiting-for-connection-sharing-session-room-id')",
				(value) => Boolean(value && value !== newRoom),
				'A new room was not created after revocation',
			);
			await firefox.navigate(`https://${hostname}:${port}/${revokedRoom}`);
			await waitFor(
				'document.body.innerText',
				(value) => /someone is trying to connect/i.test(value),
				'Revoked Firefox was not asked for approval',
			);
			successMessage =
				'Firefox downloaded the CA, verified HTTPS, paired and reconnected.';
		} finally {
			await firefox.close();
		}
	} else {
		const socketOptions = {
			ca: certificates.ca,
			transports: ['websocket'],
			query: { roomId: room },
			extraHeaders: { Origin: `https://${hostname}:${port}` },
			reconnection: false,
		};
		observer = io(`https://127.0.0.1:${port}`, socketOptions);
		const observed = [];
		observer.on('USER_ENTER', () => observed.push('USER_ENTER'));
		observer.on('MESSAGE', () => observed.push('MESSAGE'));
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Observer did not become ready')),
				5000,
			);
			observer.on('ROOM_READY', () => {
				clearTimeout(timeout);
				resolve();
			});
			observer.on('connect_error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			observer.on('disconnect', () => {
				clearTimeout(timeout);
				reject(new Error('Observer disconnected before ready'));
			});
		});
		viewer = io(`https://127.0.0.1:${port}`, {
			...socketOptions,
			auth: { ownerToken: 'incorrect' },
		});
		viewer.onAny((event, payload) => signalingEvents.push({ event, payload }));
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() =>
					reject(
						new Error(
							`Local helper did not join the signaling room: ${JSON.stringify(signalingEvents)}\n${output}`,
						),
					),
				10000,
			);
			viewer.on('ROOM_READY', () =>
				viewer.emit('USER_ENTER', { username: 'integration-test' }),
			);
			viewer.on('USER_ENTER', (payload) => {
				if (payload.users.length >= 2) {
					clearTimeout(timeout);
					const testUser = payload.users.find(
						(user) => user.username === 'integration-test',
					);
					const owner = payload.users.find(
						(user) => user.username !== 'integration-test',
					);
					if (!testUser || testUser.isOwner || !owner?.isOwner)
						reject(new Error('Loopback viewer acquired owner privileges'));
					else resolve();
				}
			});
			viewer.on('connect_error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			viewer.on('NOT_ALLOWED', () => {
				clearTimeout(timeout);
				reject(new Error('Viewer was not allowed into the room'));
			});
		});
		let injected = false;
		viewer.on('MESSAGE', (payload) => {
			if (payload.type === 'INTEGRATION_INJECTED') injected = true;
		});
		viewer.emit('MESSAGE', { type: 'INTEGRATION_PROBE', payload: {} });
		observer.emit('MESSAGE', { type: 'INTEGRATION_INJECTED', payload: {} });
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.deepEqual(
			observed,
			[],
			'unadmitted sockets must not see room events',
		);
		assert.equal(
			injected,
			false,
			'unadmitted sockets must not inject room messages',
		);
		await assert.rejects(
			viewer.timeout(1000).emitWithAck('GET_IP_BY_SOCKET_ID', viewer.id),
		);
		const foreignOrigin = io(`https://127.0.0.1:${port}`, {
			ca: certificates.ca,
			transports: ['websocket'],
			query: { roomId: room },
			extraHeaders: { Origin: 'https://untrusted.example' },
			reconnection: false,
		});
		try {
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Foreign origin was not rejected')),
					10000,
				);
				foreignOrigin.on('connect', () => {
					clearTimeout(timeout);
					reject(new Error('Foreign origin was accepted'));
				});
				foreignOrigin.on('connect_error', () => {
					clearTimeout(timeout);
					resolve();
				});
			});
		} finally {
			foreignOrigin.disconnect();
		}
		viewer.emit('MESSAGE', {
			type: 'DEVICE_DETAILS',
			payload: {
				deviceType: 'tablet',
				os: 'Android',
				browser: 'Firefox',
				deviceScreenWidth: 1280,
				deviceScreenHeight: 800,
			},
		});
		const displayedDevice = await waitFor(
			"window.electron.ipcRenderer.invoke('get-pending-connection-device')",
			(device) => device?.socketId === viewer.id,
			'Pending device was not shown',
		);
		assert.equal(displayedDevice.deviceBrowser, 'Firefox');
		const displayedSocketId = viewer.id;
		viewer.disconnect();
		let cleared = false;
		const deadline = Date.now() + 4000;
		while (Date.now() < deadline) {
			const state = await devtools.send(
				'Runtime.evaluate',
				{
					expression:
						"window.electron.ipcRenderer.invoke('get-pending-connection-device')",
					awaitPromise: true,
					returnByValue: true,
				},
				sessionId,
			);
			if (!state.result.value?.id) {
				cleared = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(
			cleared,
			true,
			'disconnected pending device should be cleared',
		);
		if (observer.connected) {
			const rejected = new Promise((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Revoked room did not reject replacement')),
					5000,
				);
				for (const event of ['NOT_ALLOWED', 'ROOM_LOCKED', 'disconnect'])
					observer.once(event, () => {
						clearTimeout(timeout);
						resolve();
					});
				observer.once('USER_ENTER', () => {
					clearTimeout(timeout);
					reject(new Error('Revoked room admitted replacement'));
				});
			});
			observer.emit('USER_ENTER', { username: 'replacement' });
			await rejected;
		}
		const approval = await devtools.send(
			'Runtime.evaluate',
			{
				expression: `window.electron.ipcRenderer.invoke('set-device-connected-status', ${JSON.stringify({ socketId: displayedSocketId, sharingSessionId: displayedDevice.sharingSessionID })})`,
				awaitPromise: true,
				returnByValue: true,
			},
			sessionId,
		);
		assert.equal(
			approval.result.value,
			false,
			'stale device approval must fail',
		);
		let replacementRoom;
		const roomDeadline = Date.now() + 8000;
		while (Date.now() < roomDeadline) {
			const state = await devtools.send(
				'Runtime.evaluate',
				{
					expression:
						"window.electron.ipcRenderer.invoke('get-waiting-for-connection-sharing-session-room-id')",
					awaitPromise: true,
					returnByValue: true,
				},
				sessionId,
			);
			if (state.result.value && state.result.value !== room) {
				replacementRoom = state.result.value;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(
			replacementRoom,
			'a new room should be created after a pending viewer disconnects',
		);
		const trustToken = randomBytes(32).toString('base64url');
		replacement = io(`https://127.0.0.1:${port}`, {
			...socketOptions,
			query: { roomId: replacementRoom },
			auth: { candidateToken: trustToken },
		});
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Replacement did not become ready')),
				5000,
			);
			replacement.once('ROOM_READY', () => {
				clearTimeout(timeout);
				resolve();
			});
			replacement.once('connect_error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
		const replacementJoined = new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Replacement did not join')),
				5000,
			);
			replacement.on('USER_ENTER', (payload) => {
				if (payload.users.length >= 2) {
					clearTimeout(timeout);
					resolve();
				}
			});
		});
		replacement.emit('USER_ENTER', { username: 'replacement' });
		await replacementJoined;
		replacement.emit('MESSAGE', {
			type: 'DEVICE_DETAILS',
			payload: {
				deviceType: 'tablet',
				os: 'Android',
				browser: 'Firefox',
				deviceScreenWidth: 1280,
				deviceScreenHeight: 800,
			},
		});
		const replacementDevice = await waitFor(
			"window.electron.ipcRenderer.invoke('get-pending-connection-device')",
			(device) => device?.socketId === replacement.id,
			'Replacement device was not shown',
		);
		const allowedMessage = new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Approved viewer did not receive approval')),
				5000,
			);
			replacement.on('MESSAGE', (payload) => {
				if (payload.type === 'ALLOWED_TO_CONNECT') {
					clearTimeout(timeout);
					resolve();
				}
			});
		});
		const remembered = new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Browser was not remembered')),
				5000,
			);
			replacement.once('BROWSER_REMEMBERED', () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		const accepted = await devtools.send(
			'Runtime.evaluate',
			{
				expression: `window.electron.ipcRenderer.invoke('set-device-connected-status', ${JSON.stringify({ socketId: replacement.id, sharingSessionId: replacementDevice.sharingSessionID, remember: true })})`,
				awaitPromise: true,
				returnByValue: true,
			},
			sessionId,
		);
		assert.equal(
			accepted.result.value,
			true,
			'the displayed connected device should be approved',
		);
		await Promise.all([allowedMessage, remembered]);
		const trusted = await evaluate(
			"window.electron.ipcRenderer.invoke('get-trusted-browsers')",
		);
		assert.equal(trusted.length, 1);
		const sharing = await evaluate(
			"window.electron.ipcRenderer.invoke('start-sharing-on-waiting-for-connection-sharing-session')",
		);
		assert.equal(sharing, true, 'the approved device should start sharing');
		const devices = await evaluate(
			"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
		);
		assert.equal(devices.length, 1);
		replacement.emit('MESSAGE', {
			type: 'DEVICE_DETAILS',
			payload: {
				deviceType: 'tablet',
				os: 'Android',
				browser: 'Firefox',
				deviceScreenWidth: 1280,
				deviceScreenHeight: 800,
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		replacement.io.engine.close();
		await waitFor(
			"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
			(value) => value.length === 1 && value[0].isReconnecting,
			'The active sharing session was not retained after interruption',
		);
		returning = io(`https://127.0.0.1:${port}`, {
			...socketOptions,
			query: { roomId: replacementRoom },
			auth: { trustToken },
		});
		const returningAllowed = new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Trusted browser was not approved')),
				8000,
			);
			returning.on('MESSAGE', (payload) => {
				if (payload.type === 'ALLOWED_TO_CONNECT') {
					clearTimeout(timeout);
					resolve();
				}
			});
		});
		returning.on('ROOM_READY', () =>
			returning.emit('USER_ENTER', { username: 'returning' }),
		);
		returning.on('USER_ENTER', (payload) => {
			if (payload.users.length >= 2)
				returning.emit('MESSAGE', {
					type: 'DEVICE_DETAILS',
					payload: {
						deviceType: 'tablet',
						os: 'Android',
						browser: 'Firefox',
						deviceScreenWidth: 1280,
						deviceScreenHeight: 800,
					},
				});
		});
		await returningAllowed;
		const resumed = await waitFor(
			"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
			(value) =>
				value.length === 1 &&
				value[0].socketId === returning.id &&
				!value[0].isReconnecting,
			'The original sharing session did not resume',
		);
		assert.equal(
			resumed[0].sharingSessionID,
			replacementDevice.sharingSessionID,
		);
		returning.io.engine.close();
		await waitFor(
			"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
			(value) => value.length === 1 && value[0].isReconnecting,
			'The resumed session was not retained when disconnected again',
		);
		assert.equal(
			await evaluate(
				`window.electron.ipcRenderer.invoke('revoke-trusted-browser', ${JSON.stringify(trusted[0].id)})`,
			),
			true,
		);
		await waitFor(
			"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
			(value) => value.length === 0,
			'Revocation did not stop the active session',
		);
		assert.deepEqual(
			await evaluate(
				"window.electron.ipcRenderer.invoke('get-trusted-browsers')",
			),
			[],
		);
		const revoked = io(`https://127.0.0.1:${port}`, {
			...socketOptions,
			query: { roomId: replacementRoom },
			auth: { trustToken },
		});
		try {
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Revoked session was not rejected')),
					5000,
				);
				revoked.on('NOT_ALLOWED', () => {
					clearTimeout(timeout);
					resolve();
				});
				revoked.on('ROOM_READY', () => {
					clearTimeout(timeout);
					reject(new Error('Revoked session was admitted'));
				});
			});
		} finally {
			revoked.disconnect();
		}
		successMessage =
			'The certificate setup, HTTPS viewer and local signaling helper are available.';
	}
} catch (error) {
	failure = error;
} finally {
	viewer?.disconnect();
	observer?.disconnect();
	replacement?.disconnect();
	returning?.disconnect();
	devtools?.close();
	app.kill('SIGTERM');
	const exited = await Promise.race([
		closed.then(() => true),
		new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
	]);
	if (!exited) {
		app.kill('SIGKILL');
		await Promise.race([
			closed,
			new Promise((resolve) => setTimeout(resolve, 2000)),
		]);
	}
	const expectedVsyncWarning =
		/^\[\d+:\d+\/\d+\.\d+:ERROR:ui\/gl\/gl_surface_presentation_helper\.cc:\d+\] GetVSyncParametersIfAvailable\(\) failed for \d+ times!$/;
	const unexpected = errors
		.split('\n')
		.filter(
			(line) =>
				line &&
				!/^DevTools listening on ws:\/\//.test(line) &&
				!expectedVsyncWarning.test(line),
		);
	if (unexpected.length) {
		const outputError = new Error(
			`Unexpected application output:\n${unexpected.join('\n')}${process.argv.includes('--live') ? `\nTimeline: ${JSON.stringify({ phases, errorTimes })}` : ''}`,
		);
		failure = failure
			? new AggregateError([failure, outputError], 'Application test failed')
			: outputError;
	}
}
if (failure) throw failure;
console.log(successMessage);
