import handleSocketUserEnter from './handleSocketUserEnter';
import handleSocketUserExit from './handleSocketUserExit';
import { IpcEvents } from '../../../../common/IpcEvents.enum';
import NullUser from './NullUser';
import { RetryDelay } from '../../../../common/retryDelay.mjs';

export default function handleSocket(peerConnection: PeerConnection): void {
	peerConnection.socket.removeAllListeners();
	const retry = new RetryDelay();
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	peerConnection.cancelReconnectTimer = () => {
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
	};

	peerConnection.socket.on('disconnect', () => {
		if (peerConnection.reconnectionEnabled)
			peerConnection.prepareForReconnection();
		else peerConnection.selfDestroy();
	});
	peerConnection.socket.on('RETRY_LATER', () => {
		if (!peerConnection.reconnectionEnabled || retryTimer) return;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			if (peerConnection.reconnectionEnabled) peerConnection.socket.connect();
		}, retry.next());
	});
	peerConnection.socket.on('NOT_ALLOWED', () => peerConnection.selfDestroy());
	peerConnection.socket.on('ROOM_LOCKED', () => peerConnection.selfDestroy());

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
			retry.reset();
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
			if (peerConnection.reconnectionEnabled)
				peerConnection.partnerDeviceDetails =
					{} as typeof peerConnection.partnerDeviceDetails;
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
