import handleSocketUserEnter from './handleSocketUserEnter';
import handleSocketUserExit from './handleSocketUserExit';
import { IpcEvents } from '../../../../common/IpcEvents.enum';
import NullUser from './NullUser';

export default function handleSocket(peerConnection: PeerConnection): void {
	peerConnection.socket.removeAllListeners();

	peerConnection.socket.on('disconnect', () => {
		peerConnection.selfDestroy();
	});

	peerConnection.socket.on('error', (error: Error) => {
		console.error('peerConnection socket error', error);
		peerConnection.selfDestroy();
	});

	peerConnection.socket.on('ROOM_READY', () => {
		peerConnection.emitUserEnter();
	});

	peerConnection.socket.on(
		'USER_ENTER',
		(payload: { users: PartnerPeerUser[] }) => {
			handleSocketUserEnter(peerConnection, payload);
		},
	);

	peerConnection.socket.on('USER_EXIT', (users: { socketId: string }[]) => {
		const socketId = peerConnection.partner.socketId;
		if (
			socketId &&
			Array.isArray(users) &&
			!users.some((user) => user.socketId === socketId)
		) {
			peerConnection.partner = NullUser;
			void window.electron.ipcRenderer.invoke(
				IpcEvents.ReportPendingViewerDisconnected,
				{
					sharingSessionId: peerConnection.sharingSessionID,
					socketId,
				},
			);
		}
		handleSocketUserExit(peerConnection);
	});

	peerConnection.socket.on(
		'MESSAGE',
		(payload: ReceiveEncryptedMessagePayload) => {
			peerConnection.receiveEncryptedMessage(payload);
		},
	);

	peerConnection.socket.on('USER_DISCONNECT', () => {
		peerConnection.toggleLockRoom(false);
	});
}
