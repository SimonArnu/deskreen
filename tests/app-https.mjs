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
	START_MINIMIZED: 'true',
};
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(
	process.env.ELECTRON_BINARY || 'node_modules/.bin/electron',
	['.', '--port', String(port), '--remote-debugging-port=0'],
	{ env, stdio: ['ignore', 'pipe', 'pipe'] },
);
const closed = new Promise((resolve) => {
	app.once('close', resolve);
	app.once('error', resolve);
});
let output = '';
let errors = '';
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
		const result = await devtools.send(
			'Runtime.evaluate',
			{ expression, awaitPromise: true, returnByValue: true },
			sessionId,
		);
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
			await waitFor(
				"window.electron.ipcRenderer.invoke('get-trusted-browsers')",
				(value) => value.length === 0,
				'The browser trust was not revoked',
			);
			await waitFor(
				"window.electron.ipcRenderer.invoke('get-pending-connection-device')",
				(value) => !value?.id,
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
				'Firefox verified HTTPS, paired, reconnected and required approval after revocation.';
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
		replacement.disconnect();
		await waitFor(
			"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
			(value) => value.length === 0,
			'The device slot was not released after disconnect',
		);
		const nextRoom = await waitFor(
			"window.electron.ipcRenderer.invoke('get-waiting-for-connection-sharing-session-room-id')",
			(value) => Boolean(value && value !== replacementRoom),
			'A new room was not created for the returning browser',
		);
		returning = io(`https://127.0.0.1:${port}`, {
			...socketOptions,
			query: { roomId: nextRoom },
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
		assert.equal(
			(
				await evaluate(
					"window.electron.ipcRenderer.invoke('get-connected-devices-list')",
				)
			).length,
			0,
			'Trust must not start sharing automatically',
		);
		assert.equal(
			await evaluate(
				"window.electron.ipcRenderer.invoke('start-sharing-on-waiting-for-connection-sharing-session')",
			),
			true,
		);
		const revokedDisconnect = new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Revocation did not disconnect viewer')),
				5000,
			);
			returning.once('disconnect', () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		assert.equal(
			await evaluate(
				`window.electron.ipcRenderer.invoke('revoke-trusted-browser', ${JSON.stringify(trusted[0].id)})`,
			),
			true,
		);
		await revokedDisconnect;
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
		successMessage =
			'The HTTPS viewer, connection instructions and local signaling helper are available.';
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
			`Unexpected application output:\n${unexpected.join('\n')}`,
		);
		failure = failure
			? new AggregateError([failure, outputError], 'Application test failed')
			: outputError;
	}
}
if (failure) throw failure;
console.log(successMessage);
