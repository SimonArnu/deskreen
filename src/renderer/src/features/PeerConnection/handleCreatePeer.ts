// import SimplePeer from 'simple-peer';
import createDesktopCapturerStream from './createDesktopCapturerStream';
import handlePeerOnData from './handlePeerOnData';
import NullSimplePeer from './NullSimplePeer';
// import simplePeerHandleSdpTransform from './simplePeerHandleSdpTransform';

export default function handleCreatePeer(
	peerConnection: PeerConnection,
	retainStream = false,
): Promise<void> {
	return new Promise((resolve, reject) => {
		// cleanup existing peer before creating new one
		if (peerConnection.peer !== NullSimplePeer) {
			try {
				peerConnection.peer.removeAllListeners();
				peerConnection.peer.destroy();
			} catch (error) {
				console.error('Error cleaning up existing peer:', error);
			}
			peerConnection.peer = NullSimplePeer;
		}

		// cleanup existing stream before creating new one
		if (peerConnection.localStream && !retainStream) {
			peerConnection.localStream.getTracks().forEach((track) => {
				track.stop();
			});
			peerConnection.localStream = null;
		}

		// clear old signals and reset call state when recreating peer
		peerConnection.signalsDataToCallUser = [];
		peerConnection.isCallStarted = false;

		(retainStream
			? Promise.resolve()
			: createDesktopCapturerStream(
					peerConnection,
					peerConnection.desktopCapturerSourceID,
				)
		)
			.then(() => {
				const partnerSocketId = peerConnection.partner.socketId;
				// if (peerConnection.peer === NullSimplePeer) {
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-ignore
				peerConnection.peer = new SimplePeer({
					initiator: true,
					// trickle: false,
					// wrtc: window.api.wrtc,
					config: { iceServers: [] },
					// sdpTransform: simplePeerHandleSdpTransform,
				});
				// }

				// TODO: basically here we need a client side simple peer, but we get a nodejs side simple peer
				if (peerConnection.localStream !== null) {
					peerConnection.peer.addStream(peerConnection.localStream);
				}

				peerConnection.peer.on('signal', (data: string) => {
					// fired when simple peer and webrtc done preparation to start call on peerConnection machine
					if (peerConnection.isCallStarted) {
						void peerConnection.sendEncryptedMessage({
							type: 'CALL_USER',
							payload: { signalData: data },
						});
					} else peerConnection.signalsDataToCallUser.push(data);
				});

				peerConnection.peer.on('data', (data) => {
					handlePeerOnData(peerConnection, data);
				});

				// ensure cleanup on peer end/error to prevent dangling helper window
				peerConnection.peer.on('close', () => {
					if (peerConnection.reconnectionEnabled) {
						peerConnection.prepareForReconnection();
						peerConnection.socket.emit('RECONNECT_PARTNER', partnerSocketId);
					} else peerConnection.selfDestroy();
				});

				peerConnection.peer.on('error', (e: Error) => {
					console.error('peerConnection peer error', e);
					if (peerConnection.reconnectionEnabled) {
						peerConnection.prepareForReconnection();
						peerConnection.socket.emit('RECONNECT_PARTNER', partnerSocketId);
					} else peerConnection.selfDestroy();
				});
				resolve(undefined);
			})
			.catch((e) => {
				console.error(e);
				reject();
			});
	});
}
