import getStore from './store';
import socketIOServerStore from './store/socketIOServerStore';
import { roomHash } from './roomHash.mjs';
import { runInRoom } from './roomQueue.mjs';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';

interface ApprovalOptions {
	remember?: boolean;
	label?: string;
	isCurrent?: () => boolean;
	trusted?: boolean;
}

async function withViewer(
	roomId: string,
	socketId: string,
	approve: boolean,
	options: ApprovalOptions = {},
): Promise<boolean> {
	const id = roomHash(roomId);
	return runInRoom(id, async () => {
		const store = getStore();
		const stored = await store.get('rooms', id);
		if (typeof stored !== 'string') return false;
		const room = JSON.parse(stored) as Room;
		const viewer = room.users?.find(
			(user) => user.socketId === socketId && !user.isOwner,
		);
		const socket = socketIOServerStore
			.getServer()
			.sockets.sockets.get(socketId);
		const isCurrent = options.isCurrent ?? (() => true);
		if (!viewer || !socket?.connected || !socket.rooms.has(id) || !isCurrent())
			return false;
		if (approve) {
			await store.set(
				'rooms',
				id,
				JSON.stringify({ ...room, approvedViewerSocketId: socketId }),
			);
			const browsers = getDeskreenGlobal().trustedBrowsers;
			const trusted = options.trusted
				? browsers.find(socket.handshake.auth?.trustToken)
				: undefined;
			if (
				!socket.connected ||
				!socket.rooms.has(id) ||
				!isCurrent() ||
				(options.trusted && !trusted)
			) {
				await store.set('rooms', id, JSON.stringify(room));
				return false;
			}
			if (options.remember) {
				let remembered;
				try {
					remembered = browsers.remember(
						socket.handshake.auth?.candidateToken,
						options.label ?? 'Browser',
					);
				} catch (error) {
					await store.set('rooms', id, JSON.stringify(room));
					throw error;
				}
				if (!remembered) {
					await store.set('rooms', id, JSON.stringify(room));
					return false;
				}
				socket.data.trustedBrowserId = remembered.id;
				socket.emit('BROWSER_REMEMBERED');
			} else if (trusted) {
				socket.data.trustedBrowserId = trusted.id;
			}
			socket.data.approvedRoom = id;
			return true;
		}
		return (
			room.approvedViewerSocketId === socketId &&
			socket.data.approvedRoom === id
		);
	});
}

export function approveViewer(
	roomId: string,
	socketId: string,
	options?: ApprovalOptions,
): Promise<boolean> {
	return withViewer(roomId, socketId, true, options);
}

export function approveTrustedViewer(
	roomId: string,
	socketId: string,
	isCurrent: () => boolean,
): Promise<boolean> {
	return withViewer(roomId, socketId, true, { trusted: true, isCurrent });
}

export function revokeTrustedBrowser(id: string): boolean {
	if (!getDeskreenGlobal().trustedBrowsers.revoke(id)) return false;
	for (const socket of socketIOServerStore
		.getServer()
		.sockets.sockets.values()) {
		if (socket.data.trustedBrowserId === id) socket.disconnect(true);
	}
	return true;
}

export function trustedBrowserForSocket(socketId: string): string | undefined {
	return socketIOServerStore.getServer().sockets.sockets.get(socketId)?.data
		.trustedBrowserId;
}

export function hasTrustedCredential(socketId: string): boolean {
	const socket = socketIOServerStore.getServer().sockets.sockets.get(socketId);
	return Boolean(
		socket?.connected &&
			getDeskreenGlobal().trustedBrowsers.find(
				socket.handshake.auth?.trustToken,
			),
	);
}

export function isApprovedSocket(roomId: string, socketId: string): boolean {
	const socket = socketIOServerStore.getServer().sockets.sockets.get(socketId);
	const id = roomHash(roomId);
	return Boolean(
		socket?.connected &&
			socket.rooms.has(id) &&
			socket.data.approvedRoom === id,
	);
}

export function isViewerApproved(
	roomId: string,
	socketId: string,
): Promise<boolean> {
	return withViewer(roomId, socketId, false);
}
