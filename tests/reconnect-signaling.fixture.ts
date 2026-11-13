import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { io, type Socket } from 'socket.io-client';
import { initGlobals } from '../src/main/helpers/initGlobals';
import { getDeskreenGlobal } from '../src/main/helpers/getDeskreenGlobal';
import { loadCertificates } from '../src/server/certificates.mjs';
import { signalingServer } from '../src/server';
import {
	approveTrustedViewer,
	isViewerApproved,
	revokeTrustedBrowser,
} from '../src/server/approval';
import { roomHash } from '../src/server/roomHash.mjs';
import getStore from '../src/server/store';
import startPollForInactiveRooms from '../src/server/startPollForInactiveRooms';

app
	.whenReady()
	.then(async () => {
		const directory = mkdtempSync(join(tmpdir(), 'deskreen-reconnect-'));
		const certificateDirectory = join(directory, 'certificates');
		const certificates = loadCertificates(
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
		const roomId = await globals.roomIDService.getAvailableRoomID();
		globals.roomIDService.markRoomIDAsTaken(roomId);
		const server = await signalingServer.start(
			0,
			certificates,
			'deskreen.local',
		);
		const port = (server.address() as { port: number }).port;
		const sockets: Socket[] = [];
		const event = (socket: Socket, name: string) =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`Timed out waiting for ${name}`)),
					5000,
				);
				socket.once(name, () => {
					clearTimeout(timer);
					resolve();
				});
			});
		const connect = (auth: Record<string, string>, owner = false) => {
			const socket = io(`https://127.0.0.1:${port}`, {
				ca: certificates.ca,
				transports: ['websocket'],
				reconnection: false,
				query: owner ? { roomId, ownerToken: globals.ownerToken } : { roomId },
				auth,
				extraHeaders: owner ? { Origin: 'file://' } : undefined,
			});
			sockets.push(socket);
			return socket;
		};
		const enter = async (socket: Socket, username: string) => {
			await event(socket, 'ROOM_READY');
			const joined = event(socket, 'USER_ENTER');
			socket.emit('USER_ENTER', { username });
			await joined;
		};
		try {
			const token = randomBytes(32).toString('base64url');
			const browser = globals.trustedBrowsers.remember(token, 'Firefox')!;
			const otherToken = randomBytes(32).toString('base64url');
			globals.trustedBrowsers.remember(otherToken, 'Other browser');
			let owner = connect({ ownerToken: globals.ownerToken }, true);
			await enter(owner, 'owner');
			let viewer = connect({ trustToken: token });
			await enter(viewer, 'viewer');
			assert.equal(
				await approveTrustedViewer(roomId, viewer.id!, () => true),
				true,
			);
			globals.roomIDService.allowReconnection(roomId, browser.id);
			const store = getStore();
			const stored = JSON.parse(
				(await store.get('rooms', roomHash(roomId))) as string,
			);
			await store.set(
				'rooms',
				roomHash(roomId),
				JSON.stringify({ ...stored, updatedAt: Date.now() - 10 * 86400_000 }),
			);
			await startPollForInactiveRooms();
			assert.equal(
				typeof (await store.get('rooms', roomHash(roomId))),
				'string',
				'active capture must not expire while waiting for a viewer',
			);
			owner.emit('TOGGLE_LOCK_ROOM');
			for (let i = 0; i < 40; i++) {
				if (await owner.timeout(2000).emitWithAck('IS_ROOM_LOCKED')) break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert.equal(
				await owner.timeout(2000).emitWithAck('IS_ROOM_LOCKED'),
				true,
			);
			let exited = event(owner, 'USER_EXIT');
			viewer.disconnect();
			await exited;
			for (const auth of [{}, { trustToken: otherToken }]) {
				const unauthorized = connect(auth);
				await event(unauthorized, 'ROOM_LOCKED');
			}
			viewer = connect({ trustToken: token });
			await enter(viewer, 'returning');
			assert.equal(await isViewerApproved(roomId, viewer.id!), true);
			const delivered = event(viewer, 'MESSAGE');
			owner.emit('MESSAGE', {
				type: 'CALL_USER',
				payload: { signalData: 'offer' },
			});
			await delivered;
			const competing = connect({ trustToken: token });
			await event(competing, 'ROOM_READY');
			const busy = event(competing, 'RETRY_LATER');
			competing.emit('USER_ENTER', { username: 'returning' });
			await busy;
			assert.equal(
				await owner
					.timeout(2000)
					.emitWithAck('RECONNECT_PARTNER', 'stale-socket'),
				false,
			);
			assert.equal(viewer.connected, true);
			const retryRequested = event(viewer, 'RETRY_LATER');
			const retryDisconnected = event(viewer, 'disconnect');
			owner.emit('RECONNECT_PARTNER', viewer.id);
			await Promise.all([retryRequested, retryDisconnected]);
			viewer = connect({ trustToken: token });
			await enter(viewer, 'returning');
			const ownerLost = event(viewer, 'RETRY_LATER');
			const viewerDisconnected = event(viewer, 'disconnect');
			owner.io.engine.close();
			await Promise.all([ownerLost, viewerDisconnected]);
			owner = connect({ ownerToken: globals.ownerToken }, true);
			await enter(owner, 'owner');
			viewer = connect({ trustToken: token });
			await enter(viewer, 'returning');
			assert.equal(await isViewerApproved(roomId, viewer.id!), true);
			exited = event(owner, 'USER_EXIT');
			const ended = event(viewer, 'SESSION_ENDED');
			const disconnected = event(viewer, 'disconnect');
			assert.equal(revokeTrustedBrowser(browser.id), true);
			await Promise.all([ended, disconnected, exited]);
			const revoked = connect({ trustToken: token });
			await event(revoked, 'ROOM_LOCKED');
			globals.roomIDService.unmarkRoomIDAsTaken(roomId);
			const stopped = connect({ trustToken: token });
			await event(stopped, 'NOT_ALLOWED');
			console.log(
				'Active sessions admit only the same trusted browser on reconnection.',
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
