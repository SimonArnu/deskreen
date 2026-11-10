import getStore from './store';
import socketIOServerStore from './store/socketIOServerStore';
import { roomHash } from './roomHash.mjs';
import { runInRoom } from './roomQueue.mjs';

async function withViewer(
	roomId: string,
	socketId: string,
	approve: boolean,
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
		if (!viewer || !socket?.connected || !socket.rooms.has(id)) return false;
		if (approve) {
			await store.set(
				'rooms',
				id,
				JSON.stringify({ ...room, approvedViewerSocketId: socketId }),
			);
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
): Promise<boolean> {
	return withViewer(roomId, socketId, true);
}

export function isViewerApproved(
	roomId: string,
	socketId: string,
): Promise<boolean> {
	return withViewer(roomId, socketId, false);
}
