export default (peerConnection: PeerConnection): void => {
	if (peerConnection.isSocketRoomLocked) {
		if (peerConnection.reconnectionEnabled) {
			peerConnection.prepareForReconnection();
			return;
		}
		peerConnection.toggleLockRoom(false);
		if (peerConnection.isCallStarted) {
			// TODO: display toast device is gone ....
			peerConnection.selfDestroy();
		}
	}
};
