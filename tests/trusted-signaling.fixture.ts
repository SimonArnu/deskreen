import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { io, type Socket } from 'socket.io-client';
import { getDeskreenGlobal } from '../src/main/helpers/getDeskreenGlobal';
import { initGlobals } from '../src/main/helpers/initGlobals';
import { signalingServer } from '../src/server';
import {
	approveTrustedViewer,
	approveViewer,
	isViewerApproved,
	revokeTrustedBrowser,
} from '../src/server/approval';
import { loadCertificates } from '../src/server/certificates.mjs';

app
	.whenReady()
	.then(async () => {
		const directory = mkdtempSync(
			join(tmpdir(), 'deskreen-trusted-signaling-'),
		);
		const certificateDirectory = join(directory, 'certificates');
		const credentials = loadCertificates(
			certificateDirectory,
			'deskreen.local',
		);
		initGlobals(
			directory,
			'deskreen.local',
			join(certificateDirectory, 'ca.crt'),
			'',
		);
		const globals = getDeskreenGlobal();
		const room = await globals.roomIDService.getAvailableRoomID();
		globals.roomIDService.markRoomIDAsTaken(room);
		const server = await signalingServer.start(
			0,
			credentials,
			'deskreen.local',
		);
		const port = (server.address() as { port: number }).port;
		const sockets: Socket[] = [];
		const event = (socket: Socket, name: string) =>
			new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error(`Timed out waiting for ${name}`)),
					5000,
				);
				socket.once(name, () => {
					clearTimeout(timeout);
					resolve();
				});
			});
		const connect = async (auth: Record<string, string>, owner = false) => {
			const socket = io(`https://127.0.0.1:${port}`, {
				ca: credentials.ca,
				transports: ['websocket'],
				reconnection: false,
				query: owner
					? { roomId: room, ownerToken: globals.ownerToken }
					: { roomId: room },
				auth,
				extraHeaders: owner ? { Origin: 'file://' } : undefined,
			});
			sockets.push(socket);
			await event(socket, 'ROOM_READY');
			const entered = event(socket, 'USER_ENTER');
			socket.emit('USER_ENTER', { username: randomBytes(12).toString('hex') });
			await entered;
			return socket;
		};
		try {
			const owner = await connect({ ownerToken: globals.ownerToken }, true);
			const token = randomBytes(32).toString('base64url');
			let viewer = await connect({ candidateToken: token });
			assert.equal(
				await approveViewer(room, viewer.id!, {
					remember: true,
					label: 'Firefox',
					isCurrent: () => false,
				}),
				false,
			);
			assert.deepEqual(globals.trustedBrowsers.list(), []);
			let checks = 0;
			assert.equal(
				await approveViewer(room, viewer.id!, {
					remember: true,
					label: 'Firefox',
					isCurrent: () => ++checks === 1,
				}),
				false,
			);
			assert.deepEqual(globals.trustedBrowsers.list(), []);
			assert.equal(await isViewerApproved(room, viewer.id!), false);
			assert.equal(await approveViewer(room, viewer.id!), true);
			assert.deepEqual(globals.trustedBrowsers.list(), []);
			let exited = event(owner, 'USER_EXIT');
			viewer.disconnect();
			await exited;
			viewer = await connect({ candidateToken: token });
			const remembered = event(viewer, 'BROWSER_REMEMBERED');
			assert.equal(
				await approveViewer(room, viewer.id!, {
					remember: true,
					label: 'Firefox',
					isCurrent: () => true,
				}),
				true,
			);
			await remembered;
			assert.equal(globals.trustedBrowsers.list().length, 1);
			exited = event(owner, 'USER_EXIT');
			viewer.disconnect();
			await exited;
			viewer = await connect({ candidateToken: token });
			assert.equal(
				await approveViewer(room, viewer.id!, {
					remember: true,
					label: 'Impersonated browser',
					isCurrent: () => true,
				}),
				false,
			);
			assert.equal(await isViewerApproved(room, viewer.id!), false);
			assert.equal(globals.trustedBrowsers.list()[0].label, 'Firefox');
			exited = event(owner, 'USER_EXIT');
			viewer.disconnect();
			await exited;
			viewer = await connect({ trustToken: token });
			assert.equal(
				await approveTrustedViewer(room, viewer.id!, () => true),
				true,
			);
			assert.equal(await isViewerApproved(room, viewer.id!), true);
			const disconnected = event(viewer, 'disconnect');
			exited = event(owner, 'USER_EXIT');
			assert.equal(
				revokeTrustedBrowser(globals.trustedBrowsers.list()[0].id),
				true,
			);
			await Promise.all([disconnected, exited]);
			viewer = await connect({ trustToken: token });
			assert.equal(
				await approveTrustedViewer(room, viewer.id!, () => true),
				false,
			);
			assert.equal(await isViewerApproved(room, viewer.id!), false);
			console.log(
				'Trusted viewers require explicit enrollment and can be revoked.',
			);
		} finally {
			for (const socket of sockets) socket.disconnect();
			signalingServer.stop();
		}
		app.quit();
	})
	.catch((error) => {
		console.error(error);
		app.exit(1);
	});
