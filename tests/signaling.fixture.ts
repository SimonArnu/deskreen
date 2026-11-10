import assert from 'node:assert/strict';
import { app } from 'electron';
import { io, type Socket } from 'socket.io-client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initGlobals } from '../src/main/helpers/initGlobals';
import { getDeskreenGlobal } from '../src/main/helpers/getDeskreenGlobal';
import { loadCertificates } from '../src/server/certificates.mjs';
import { signalingServer } from '../src/server';
import { approveViewer, isViewerApproved } from '../src/server/approval';

app
	.whenReady()
	.then(async () => {
		const directory = mkdtempSync(join(tmpdir(), 'deskreen-signaling-test-'));
		const credentials = loadCertificates(
			join(directory, 'certificates'),
			'deskreen.local',
		);
		initGlobals(
			directory,
			'deskreen.local',
			join(directory, 'certificates', 'ca.crt'),
			'',
		);
		const globals = getDeskreenGlobal();
		const roomId = await globals.roomIDService.getAvailableRoomID();
		globals.roomIDService.markRoomIDAsTaken(roomId);
		const server = await signalingServer.start(
			0,
			credentials,
			'deskreen.local',
		);
		const port = (server.address() as { port: number }).port;
		const sockets: Socket[] = [];
		const connect = async (token?: string, expectReady = true) => {
			const owner = token === globals.ownerToken;
			const socket = io(`https://127.0.0.1:${port}`, {
				ca: credentials.ca,
				query: owner ? { roomId, ownerToken: token } : { roomId },
				transports: ['websocket'],
				reconnection: false,
				auth: token ? { ownerToken: token } : {},
				extraHeaders: owner ? { Origin: 'file://' } : undefined,
			});
			sockets.push(socket);
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Server did not become ready')),
					5000,
				);
				socket.once(expectReady ? 'ROOM_READY' : 'connect', () => {
					clearTimeout(timeout);
					resolve();
				});
				socket.once('connect_error', (error) => {
					clearTimeout(timeout);
					reject(error);
				});
			});
			return socket;
		};
		try {
			for (const origin of ['null', 'file://']) {
				const opaque = io(`https://127.0.0.1:${port}`, {
					ca: credentials.ca,
					query: { roomId },
					transports: ['websocket'],
					extraHeaders: { Origin: origin },
					reconnection: false,
				});
				sockets.push(opaque);
				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(
						() => reject(new Error('Opaque origin was not rejected')),
						5000,
					);
					opaque.once('connect', () => {
						clearTimeout(timeout);
						reject(new Error('Opaque origin was accepted'));
					});
					opaque.once('connect_error', () => {
						clearTimeout(timeout);
						resolve();
					});
				});
			}
			const owner = await connect(globals.ownerToken);
			const ownerEntered = new Promise<void>((resolve) =>
				owner.once('USER_ENTER', () => resolve()),
			);
			owner.emit('USER_ENTER', { username: 'owner' });
			await ownerEntered;
			const pending = await connect();
			globals.roomIDService.unmarkRoomIDAsTaken(roomId);
			const revoked = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() =>
						reject(new Error('Revoked room did not reject pending visitor')),
					5000,
				);
				pending.once('NOT_ALLOWED', () => {
					clearTimeout(timeout);
					resolve();
				});
				pending.once('USER_ENTER', () => {
					clearTimeout(timeout);
					reject(new Error('Revoked room admitted visitor'));
				});
			});
			pending.emit('USER_ENTER', { username: 'revoked' });
			await revoked;
			globals.roomIDService.markRoomIDAsTaken(roomId);
			const first = await connect();
			const second = await connect('incorrect');
			first.emit('GET_MY_IP');
			first.emit('PING');
			first.emit('IS_ROOM_LOCKED');
			first.emit('GET_IP_BY_SOCKET_ID', {});
			for (let i = 0; i < 2000; i += 1) first.emit('TOGGLE_LOCK_ROOM');
			assert.equal(await first.timeout(2000).emitWithAck('PING'), 'PONG');
			const outcome = (socket: Socket) =>
				new Promise<string>((resolve, reject) => {
					const timeout = setTimeout(
						() => reject(new Error('No room admission result')),
						5000,
					);
					socket.once('USER_ENTER', () => {
						clearTimeout(timeout);
						resolve('admitted');
					});
					socket.once('NOT_ALLOWED', () => {
						clearTimeout(timeout);
						resolve('rejected');
					});
				});
			const results = Promise.all([outcome(first), outcome(second)]);
			first.emit('USER_ENTER', { username: 'first' });
			second.emit('USER_ENTER', { username: 'second' });
			const outcomes = await results;
			assert.deepEqual([...outcomes].sort(), ['admitted', 'rejected']);
			const admitted = outcomes[0] === 'admitted' ? first : second;
			const admittedId = admitted.id!;
			let unapprovedAnswer = false;
			owner.on('MESSAGE', (payload) => {
				if (payload.type === 'CALL_ACCEPTED') unapprovedAnswer = true;
			});
			admitted.emit('MESSAGE', {
				type: 'CALL_ACCEPTED',
				payload: { signalData: 'unapproved' },
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(
				unapprovedAnswer,
				false,
				'an unapproved viewer must not send WebRTC answers',
			);
			assert.equal(await approveViewer(roomId, 'not-a-viewer'), false);
			assert.equal(await approveViewer(roomId, admittedId), true);
			assert.equal(await isViewerApproved(roomId, admittedId), true);
			const approvedAnswer = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Approved answer was not delivered')),
					5000,
				);
				owner.on('MESSAGE', (payload) => {
					if (payload.type === 'CALL_ACCEPTED') {
						clearTimeout(timeout);
						resolve();
					}
				});
			});
			admitted.emit('MESSAGE', {
				type: 'CALL_ACCEPTED',
				payload: { signalData: 'approved' },
			});
			await approvedAnswer;
			const allowed = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Approved viewer did not receive approval')),
					5000,
				);
				admitted.on('MESSAGE', (payload) => {
					if (payload.type === 'ALLOWED_TO_CONNECT') {
						clearTimeout(timeout);
						resolve();
					}
				});
			});
			owner.emit('MESSAGE', { type: 'ALLOWED_TO_CONNECT', payload: {} });
			await allowed;
			owner.emit('TOGGLE_LOCK_ROOM');
			await new Promise((resolve) => setTimeout(resolve, 200));
			const blocked = await connect(undefined, false);
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Locked room did not disconnect the visitor')),
					5000,
				);
				let notified = false;
				blocked.on('ROOM_LOCKED', () => {
					notified = true;
				});
				blocked.on('disconnect', () => {
					clearTimeout(timeout);
					if (notified) resolve();
					else
						reject(
							new Error('Locked visitor disconnected without an explanation'),
						);
				});
			});
			const disconnected = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Owner did not disconnect its viewer')),
					5000,
				);
				admitted.once('disconnect', () => {
					clearTimeout(timeout);
					resolve();
				});
			});
			const exited = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Owner did not observe viewer departure')),
					5000,
				);
				owner.once('USER_EXIT', () => {
					clearTimeout(timeout);
					resolve();
				});
			});
			owner.emit('DISCONNECT_PARTNER');
			await Promise.all([disconnected, exited]);
			assert.equal(owner.connected, true);
			assert.equal(await isViewerApproved(roomId, admittedId), false);
			owner.emit('TOGGLE_LOCK_ROOM');
			let unlocked = false;
			for (let i = 0; i < 40; i += 1) {
				if (!(await owner.timeout(2000).emitWithAck('IS_ROOM_LOCKED'))) {
					unlocked = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(unlocked, true);
			const replacement = await connect();
			const replacementEntered = new Promise<void>((resolve) =>
				replacement.once('USER_ENTER', () => resolve()),
			);
			replacement.emit('USER_ENTER', { username: 'replacement' });
			await replacementEntered;
			let leakedOffer = false;
			replacement.on('MESSAGE', (payload) => {
				if (payload.type === 'CALL_USER') leakedOffer = true;
			});
			owner.emit('MESSAGE', {
				type: 'CALL_USER',
				payload: { signalData: 'private-offer' },
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(
				leakedOffer,
				false,
				'a replacement viewer must not receive an earlier approval or offer',
			);
			console.log('Concurrent viewers cannot both enter the signaling room.');
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
