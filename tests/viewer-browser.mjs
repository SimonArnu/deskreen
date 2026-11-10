import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const root = resolve('src/client-viewer/dist');
const types = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
	const pathname = new URL(req.url, 'http://localhost').pathname;
	const path = resolve(
		root,
		`.${extname(pathname) ? pathname : '/index.html'}`,
	);
	if (!path.startsWith(`${root}/`)) {
		res.writeHead(403).end();
		return;
	}
	try {
		const data = await readFile(path);
		res
			.writeHead(200, {
				'content-type': types[extname(path)] || 'application/octet-stream',
			})
			.end(data);
	} catch {
		res.writeHead(404).end();
	}
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const withoutWebRTC = process.argv.includes('--without-webrtc');
const profile = await mkdtemp(join(tmpdir(), 'deskreen-browser-'));
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
		`--user-data-dir=${profile}`,
		'about:blank',
	],
	{ stdio: ['ignore', 'ignore', 'pipe'] },
);
try {
	const endpoint = await new Promise((resolveEndpoint, reject) => {
		let output = '';
		browser.stderr.on('data', (data) => {
			output += data;
			const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
			if (match) resolveEndpoint(match[1]);
		});
		browser.once('error', reject);
		browser.once('exit', (code) =>
			reject(new Error(`Chrome exited: ${code}\n${output}`)),
		);
	});
	const socket = new WebSocket(endpoint);
	await once(socket, 'open');
	let nextId = 0;
	const pending = new Map();
	const requests = [];
	socket.addEventListener('message', ({ data }) => {
		const message = JSON.parse(data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(message.error.message));
			else resolve(message.result);
		}
		if (message.method === 'Network.requestWillBeSent')
			requests.push(message.params.request.url);
		if (message.method === 'Network.webSocketCreated')
			requests.push(message.params.url);
	});
	function send(method, params = {}, sessionId) {
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params, sessionId }));
		});
	}
	const { targetId } = await send('Target.createTarget', {
		url: 'about:blank',
	});
	const { sessionId } = await send('Target.attachToTarget', {
		targetId,
		flatten: true,
	});
	await send('Network.enable', {}, sessionId);
	await send('Page.enable', {}, sessionId);
	await send(
		'Page.addScriptToEvaluateOnNewDocument',
		{
			source: `try { localStorage.setItem('deskreen_ga_consent', 'accepted'); } catch {}
				${withoutWebRTC ? "['RTCPeerConnection', 'mozRTCPeerConnection', 'webkitRTCPeerConnection'].forEach((name) => Object.defineProperty(window, name, { value: undefined, configurable: true }));" : ''}`,
		},
		sessionId,
	);
	await send('Page.navigate', { url: `${origin}/123456` }, sessionId);
	await new Promise((resolveWait) => setTimeout(resolveWait, 4000));
	const result = await send(
		'Runtime.evaluate',
		{ expression: 'document.body.innerText', returnByValue: true },
		sessionId,
	);
	const external = requests.filter((url) => {
		const parsed = new URL(url);
		return (
			parsed.protocol !== 'data:' &&
			parsed.protocol !== 'blob:' &&
			parsed.origin !== origin &&
			parsed.origin !== origin.replace('http:', 'ws:')
		);
	});
	if (external.length)
		throw new Error(`External requests: ${external.join(', ')}`);
	const signaled = requests.some(
		(url) => url.startsWith(origin) && url.includes('/socket.io/'),
	);
	if (/privacy notice|analytics/i.test(result.result.value))
		throw new Error('Analytics consent remains visible');
	if (withoutWebRTC) {
		if (!/WebRTC is unavailable/i.test(result.result.value))
			throw new Error(
				`Viewer did not explain missing WebRTC: ${JSON.stringify(result.result.value)}`,
			);
		if (signaled) throw new Error('Viewer tried to connect without WebRTC');
	} else {
		if (!signaled)
			throw new Error('Viewer did not attempt to signal at the serving origin');
		if (
			!/Waiting for (user to click ALLOW|video stream)/i.test(
				result.result.value,
			)
		)
			throw new Error(
				`Viewer did not display the connection instructions: ${JSON.stringify(result.result.value)}`,
			);
	}
	console.log(
		`Viewer rendered with ${requests.length} same-origin requests and no analytics prompt or external requests.`,
	);
	socket.close();
} finally {
	browser.kill();
	server.close();
}
