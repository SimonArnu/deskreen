/*
 * original JS code from darkwire.io
 * translated and adapted to typescript for Deskreen CE app
 * */

/* eslint-disable no-async-promise-executor */
import _ from 'lodash';
import Io from 'socket.io';
import getStore from './store';
import socketIOServerStore from './store/socketIOServerStore';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';
import { canQueueRoomLock, isOwnerCredential } from './origin.mjs';
import { runInRoom } from './roomQueue.mjs';

interface SocketOPTS {
	roomId: string;
	socket: Io.Socket;
	room: Room;
	roomIdOriginal: string;
}

function isOwnerSocket(socket: Io.Socket) {
	const remoteAddress = socket.request.socket.remoteAddress ?? '';
	return isOwnerCredential(
		remoteAddress,
		socket.handshake.auth?.ownerToken,
		getDeskreenGlobal().ownerToken,
	);
}

export default class Socket implements SocketOPTS {
	roomId: string;

	socket: Io.Socket;

	room: Room;

	roomIdOriginal: string;
	admitted = false;
	enterPending = false;
	lockChangesPending = 0;
	sensitiveMessagesPending = 0;
	enterTimeout: NodeJS.Timeout | null = null;

	constructor(opts: SocketOPTS) {
		const { roomId, socket, room, roomIdOriginal } = opts;

		this.roomId = roomId;
		this.socket = socket;
		this.roomIdOriginal = roomIdOriginal;
		this.room = room;
		if (room.isLocked) {
			this.sendRoomLocked();
			return;
		}

		this.init();
	}

	init(): void {
		this.handleSocket();
		this.enterTimeout = setTimeout(() => {
			if (!this.admitted) this.socket.disconnect(true);
		}, 10_000);
		this.socket.emit('ROOM_READY');
	}

	sendRoomLocked(): void {
		this.socket.emit('ROOM_LOCKED');
		setTimeout(() => this.socket.disconnect(true), 0);
	}

	async saveRoom(room: Room): Promise<number> {
		const json = {
			...room,
			updatedAt: Date.now(),
		};
		return getStore().set('rooms', this.roomId, JSON.stringify(json));
	}

	async destroyRoom(): Promise<0 | 1> {
		return getStore().del('rooms', this.roomId);
	}

	async fetchRoom(): Promise<unknown> {
		const res = await getStore().get('rooms', this.roomId);
		if (typeof res !== 'string') {
			return {};
		}
		return JSON.parse(res);
	}

	joinRoom(): Promise<unknown> {
		return new Promise((resolve) => {
			this.socket.join(this.roomId);
			resolve(undefined);
		});
	}

	handleSocket(): void {
		this.socket.on('GET_MY_IP', (acknowledgeFunction) => {
			if (typeof acknowledgeFunction === 'function') {
				acknowledgeFunction(this.socket.request.socket.remoteAddress ?? '');
			}
		});

		this.socket.on('GET_IP_BY_SOCKET_ID', (socketID, acknowledgeFunction) => {
			if (
				!isOwnerSocket(this.socket) ||
				typeof socketID !== 'string' ||
				typeof acknowledgeFunction !== 'function'
			) {
				return;
			}
			const target = socketIOServerStore
				.getServer()
				.sockets.sockets.get(socketID);
			acknowledgeFunction(target?.request.socket.remoteAddress);
		});

		this.socket.on('IS_ROOM_LOCKED', async (acknowledgeFunction) => {
			if (typeof acknowledgeFunction !== 'function') return;
			const room: Room = (await this.fetchRoom()) as Room;
			acknowledgeFunction(room.isLocked);
		});

		this.socket.on('PING', (acknowledgeFunction) => {
			if (typeof acknowledgeFunction === 'function')
				acknowledgeFunction('PONG');
		});

		this.socket.on('MESSAGE', (payload) => {
			if (
				!this.admitted ||
				!payload ||
				typeof payload !== 'object' ||
				Array.isArray(payload)
			)
				return;
			payload.fromSocketID = this.socket.id;
			const owner = isOwnerSocket(this.socket);
			if (
				(owner &&
					(payload.type === 'CALL_USER' ||
						payload.type === 'ALLOWED_TO_CONNECT')) ||
				(!owner && payload.type === 'CALL_ACCEPTED')
			) {
				if (
					(!owner && this.socket.data.approvedRoom !== this.roomId) ||
					this.sensitiveMessagesPending >= 64
				)
					return;
				this.sensitiveMessagesPending += 1;
				void runInRoom(this.roomId, async () => {
					const room = (await this.fetchRoom()) as Room;
					const approved = room.approvedViewerSocketId;
					if (!approved || (!owner && approved !== this.socket.id)) return;
					const viewer = (room.users || []).find(
						(user) => user.socketId === approved && !user.isOwner,
					);
					const targetUser = owner
						? viewer
						: (room.users || []).find((user) => user.isOwner);
					const id = targetUser?.socketId;
					const target = id
						? socketIOServerStore.getServer().sockets.sockets.get(id)
						: undefined;
					if (id && viewer && target?.connected)
						this.socket.to(id).emit('MESSAGE', payload);
				})
					.catch((error) =>
						console.error('Failed to deliver approved message:', error),
					)
					.finally(() => {
						this.sensitiveMessagesPending -= 1;
					});
				return;
			}
			this.socket.to(this.roomId).emit('MESSAGE', payload);
		});

		this.socket.on('DISCONNECT_PARTNER', async () => {
			const room: Room = (await this.fetchRoom()) as Room;
			const ownerUser = (room.users || []).find(
				(u) => u.socketId === this.socket.id && u.isOwner,
			);
			if (!ownerUser) return;
			const partner = (room.users || []).find((user) => !user.isOwner);
			if (!partner) return;
			const target = socketIOServerStore
				.getServer()
				.sockets.sockets.get(partner.socketId);
			if (target && target.id !== this.socket.id) target.disconnect(true);
		});

		this.socket.on('USER_ENTER', (payload) => {
			if (this.admitted || this.enterPending) return;
			this.enterPending = true;
			void runInRoom(this.roomId, () => this.handleUserEnter(payload))
				.catch((error) => {
					console.error('Failed to admit room user:', error);
					this.socket.disconnect(true);
				})
				.finally(() => {
					this.enterPending = false;
				});
		});

		this.socket.on('TOGGLE_LOCK_ROOM', () => {
			if (
				!canQueueRoomLock(
					this.admitted,
					this.socket.request.socket.remoteAddress ?? '',
					this.socket.handshake.auth?.ownerToken,
					getDeskreenGlobal().ownerToken,
					this.lockChangesPending,
				)
			)
				return;
			this.lockChangesPending += 1;
			void runInRoom(this.roomId, async () => {
				// TODO: in here if there is somehow already more than ONE client connected, then we were spoofed! Need to add code to interrupt connection immediately.
				const room: Room = (await this.fetchRoom()) as Room;
				const user = (room.users || []).find(
					(u) => u.socketId === this.socket.id && u.isOwner,
				);

				if (!user) {
					return;
				}

				await this.saveRoom({
					...room,
					isLocked: !room.isLocked,
				});
			})
				.catch((error) => console.error('Failed to change room lock:', error))
				.finally(() => {
					this.lockChangesPending -= 1;
				});
		});

		this.socket.on('disconnect', () => {
			if (this.enterTimeout) clearTimeout(this.enterTimeout);
			void runInRoom(this.roomId, () =>
				this.handleDisconnect(this.socket),
			).catch((error) =>
				console.error('Failed to disconnect room user:', error),
			);
		});

		this.socket.on('USER_DISCONNECT', () => {
			this.socket.disconnect(true);
		});
	}

	async handleUserEnter(payload: {
		username?: unknown;
		ip?: unknown;
	}): Promise<void> {
		if (this.admitted || !this.socket.connected) return;
		if (
			!payload ||
			typeof payload.username !== 'string' ||
			payload.username.length === 0 ||
			payload.username.length > 128
		) {
			this.socket.disconnect(true);
			return;
		}
		let room: Room = (await this.fetchRoom()) as Room;
		if (_.isEmpty(room)) {
			room = {
				id: this.roomId,
				users: [],
				isLocked: false,
				createdAt: Date.now(),
			};
		} else if (room.isLocked) {
			this.sendRoomLocked();
			return;
		} else if (room.users.some((user) => user.username === payload.username)) {
			this.socket.emit('NOT_ALLOWED');
			setTimeout(() => this.socket.disconnect(true), 0);
			return;
		}
		const owner = isOwnerSocket(this.socket);
		if (!owner && (room.users || []).some((user) => !user.isOwner)) {
			this.socket.emit('NOT_ALLOWED');
			setTimeout(() => this.socket.disconnect(true), 0);
			return;
		}
		if (!this.socket.connected) return;
		if (!getDeskreenGlobal().roomIDService.isRoomIDTaken(this.roomIdOriginal)) {
			this.socket.emit('NOT_ALLOWED');
			setTimeout(() => this.socket.disconnect(true), 0);
			return;
		}
		const newRoom: Room = {
			...room,
			users: [
				...(room.users || []),
				{
					socketId: this.socket.id,
					username: payload.username,
					isOwner: owner,
					ip: typeof payload.ip === 'string' ? payload.ip : '', // TODO: remove as it is not used
				},
			],
		};
		await this.joinRoom();
		if (
			!this.socket.connected ||
			!getDeskreenGlobal().roomIDService.isRoomIDTaken(this.roomIdOriginal)
		) {
			void this.socket.leave(this.roomId);
			this.socket.disconnect(true);
			return;
		}
		await this.saveRoom(newRoom);
		this.admitted = true;
		if (this.enterTimeout) clearTimeout(this.enterTimeout);
		socketIOServerStore
			.getServer()
			.to(this.roomId)
			.emit('USER_ENTER', { ...newRoom, id: this.roomIdOriginal });
	}

	async handleDisconnect(socket: Io.Socket): Promise<void> {
		const room: Room = (await this.fetchRoom()) as Room;
		if (!(room.users || []).some((user) => user.socketId === socket.id)) return;
		this.admitted = false;
		const isOwnerUser = !!(room.users || []).find(
			(u) => u.socketId === socket.id && u.isOwner,
		);

		const newRoom = {
			...room,
			users: (room.users || []).filter((u) => u.socketId !== socket.id),
			approvedViewerSocketId:
				room.approvedViewerSocketId === socket.id
					? undefined
					: room.approvedViewerSocketId,
		};

		if (isOwnerUser) {
			this.disconnectAllUsers(newRoom);
			await this.destroyRoom();
		} else {
			await this.saveRoom(newRoom);
		}

		socketIOServerStore
			.getServer()
			.to(this.roomId)
			.emit('USER_EXIT', newRoom.users);

		socket.disconnect(true);
	}

	disconnectAllUsers(room: Room): void {
		room.users.forEach((u) => {
			socketIOServerStore
				.getServer()
				.sockets.sockets.get(u.socketId)
				?.disconnect(true);
		});
	}
}
