import shortId from 'shortid';
import SimplePeer from 'simple-peer';
import { UAParser } from 'ua-parser-js';
import type { Socket } from 'socket.io-client';
import type { LocalPeerUser } from '../../../../common/LocalPeerUser';
import type { SendEncryptedMessagePayload } from '../../../../common/SendEncryptedMessagePayload';
import {
	connect as connectSocket,
	watchBrowserTrust,
} from '../../utils/socket';
import {
	prepare as prepareMessage,
	type ProcessedPayload,
} from '../../utils/message';
import setSdpMediaBitrate from './setSdpMediaBitrate';
import VideoAutoQualityOptimizer from '../VideoAutoQualityOptimizer';
import {
	VideoQuality,
	type VideoQualityType,
} from '../VideoAutoQualityOptimizer/VideoQualityEnum';
import { prepareDataMessageToChangeQuality } from './simplePeerDataMessages';
import { VIDEO_QUALITY_TO_DECIMAL } from './../../constants/appConstants';
import { ErrorMessage } from '../../components/ErrorDialog/ErrorMessageEnum';
import peerConnectionHandleSocket from './peerConnectionHandleSocket';
import peerConnectionHandlePeer from './peerConnectionHandlePeer';
import peerConnectionReceiveEncryptedMessage from './peerConnectionReceiveEncryptedMessage';
import startSocketConnectedCheckingLoop from './startSocketConnectedCheckingLoop';
import NullUser from './NullUser';
import PeerConnectionUIHandler from './PeerConnectionUIHandler';
import setAndShowErrorDialogMessage from './setAndShowErrorDialogMessage';
import PeerConnectionSocketNotDefined from './errors/PeerConnectionSocketNotDefined';
import PeerConnectionUserIsNotDefinedError from './errors/PeerConnectionUserIsNotDefinedError';
import PeerConnectionPartnerIsNotDefinedError from './errors/PeerConnectionPartnerIsNotDefinedError';
import { RetryDelay } from '../../../../common/retryDelay.mjs';

export default class PeerConnection {
	roomId: string;

	socket: Socket | null = null;

	user: LocalPeerUser = NullUser;

	partner: PartnerPeerUser = NullUser;

	peer: null | SimplePeer.Instance = null;

	myDeviceDetails: DeviceDetails = {
		myIP: '',
		myOS: '',
		myDeviceType: '',
		myBrowser: '',
		myRoomId: '',
	};

	setUrlCallback: (url: MediaStream | null) => void;

	uaParser: UAParser;

	screenSharingSourceType: string | undefined = undefined;

	videoQuality: VideoQualityType = VideoQuality.Q_100_PERCENT;

	videoAutoQualityOptimizer: VideoAutoQualityOptimizer;

	isStreamStarted: boolean = false;

	UIHandler: PeerConnectionUIHandler;

	beforeunloadHandler: (() => void) | null = null;

	connectionCheckInterval: NodeJS.Timeout | null = null;

	reconnectTimeout: NodeJS.Timeout | null = null;

	setMyDeviceDetailsTimeout: NodeJS.Timeout | null = null;
	reconnectionEnabled = false;
	retryDelay = new RetryDelay();
	retryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		roomId: string,
		setUrlCallback: (url: MediaStream | null) => void,
		videoAutoQualityOptimizer: VideoAutoQualityOptimizer,
		UIHandler: PeerConnectionUIHandler,
	) {
		this.setUrlCallback = setUrlCallback;
		this.videoAutoQualityOptimizer = videoAutoQualityOptimizer;
		this.UIHandler = UIHandler;
		this.roomId = roomId;
		this.socket = connectSocket(this.roomId);
		this.uaParser = new UAParser();
		this.createUserAndInitSocket();
		this.createPeer();

		if (!this.roomId || this.roomId === '') {
			setAndShowErrorDialogMessage(this, ErrorMessage.NOT_ALLOWED);
		}

		this.connectionCheckInterval = startSocketConnectedCheckingLoop(this);
	}

	setVideoQuality(videoQuality: VideoQualityType) {
		this.videoQuality = videoQuality;
		this.videoQualityChangedCallback();
	}

	videoQualityChangedCallback() {
		if (!this.peer) return;
		if (this.videoQuality === VideoQuality.Q_AUTO) {
			this.peer.send(prepareDataMessageToChangeQuality(1));
		} else {
			this.peer.send(
				prepareDataMessageToChangeQuality(
					VIDEO_QUALITY_TO_DECIMAL[this.videoQuality],
				),
			);
		}
	}

	stopStream() {
		this.videoAutoQualityOptimizer.stopOptimizationLoop();
		// stop the video stream by clearing the stream URL
		this.setUrlCallback(null);
		this.isStreamStarted = false;

		// destroy the peer connection
		if (this.peer) {
			try {
				this.peer.removeAllListeners();
				this.peer.destroy();
			} catch (error) {
				console.error('Error destroying peer connection:', error);
			}
			this.peer = null;
		}
	}

	destroy() {
		this.stopReconnecting();
		this.videoAutoQualityOptimizer.stopOptimizationLoop();
		// remove window event listener
		if (this.beforeunloadHandler) {
			window.removeEventListener('beforeunload', this.beforeunloadHandler);
			this.beforeunloadHandler = null;
		}

		// clear connection check interval
		if (this.connectionCheckInterval) {
			clearInterval(this.connectionCheckInterval);
			this.connectionCheckInterval = null;
		}

		// clear all timeouts
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		if (this.setMyDeviceDetailsTimeout) {
			clearTimeout(this.setMyDeviceDetailsTimeout);
			this.setMyDeviceDetailsTimeout = null;
		}

		// stop stream if started
		if (this.isStreamStarted) {
			this.stopStream();
		}

		// cleanup peer connection
		if (this.peer) {
			try {
				this.peer.removeAllListeners();
				this.peer.destroy();
			} catch (error) {
				console.error('Error destroying peer:', error);
			}
			this.peer = null;
		}

		// cleanup socket
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.disconnect();
		}
	}

	stopReconnecting() {
		this.reconnectionEnabled = false;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
		this.reconnectTimeout = null;
		this.socket?.io.reconnection(false);
		this.socket?.disconnect();
	}

	scheduleReconnect() {
		if (!this.reconnectionEnabled || this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			if (this.reconnectionEnabled) this.socket?.connect();
		}, this.retryDelay.next());
	}

	prepareForReconnection() {
		this.stopStream();
		this.createPeer();
		setAndShowErrorDialogMessage(this, ErrorMessage.RECONNECTING);
	}

	createPeer() {
		// cleanup existing peer before creating new one
		if (this.peer) {
			try {
				this.peer.removeAllListeners();
				this.peer.destroy();
			} catch (error) {
				console.error('Error cleaning up existing peer:', error);
			}
			this.peer = null;
		}

		// When we are testing with jest, SimplePeer() can not be created, so we just return
		const peer = new SimplePeer({
			initiator: false,
			config: { iceServers: [] },
			sdpTransform: (sdp) => {
				let newSDP = sdp;
				newSDP = setSdpMediaBitrate(
					newSDP as unknown as string,
					'video',
					500000,
				) as unknown as typeof sdp;
				return newSDP;
			},
		});

		this.peer = peer;
		this.peer.on('error', (e) => {
			if (this.reconnectionEnabled) {
				this.socket?.io.engine.close();
				return;
			}
			console.error('error in simple peer happened!');
			console.error(e);
			setAndShowErrorDialogMessage(this, ErrorMessage.WEBRTC_ERROR);
		});
		peerConnectionHandlePeer(this);
	}

	initApp(user: LocalPeerUser, myIP: string) {
		if (!this.socket) {
			throw new PeerConnectionSocketNotDefined();
		}
		this.socket.emit('USER_ENTER', {
			username: user.username,
			ip: myIP, // TODO: remove as it is not used
		});
	}

	createUser() {
		return new Promise<LocalPeerUser>((resolve) => {
			const username = shortId.generate();
			const id = shortId.generate();

			resolve({
				username,
				id,
			});
		});
	}

	sendEncryptedMessage(payload: SendEncryptedMessagePayload) {
		const socket = this.socket;
		if (!socket) {
			throw new PeerConnectionSocketNotDefined();
		}
		if (!this.user || this.user === NullUser) {
			throw new PeerConnectionUserIsNotDefinedError();
		}
		if (!this.partner || this.partner === NullUser) {
			throw new PeerConnectionPartnerIsNotDefinedError();
		}
		if (!this.partner.username) return;
		prepareMessage(payload, this.user).then((msg: ProcessedPayload) => {
			socket.emit('MESSAGE', msg.toSend);
		});
	}

	receiveEncryptedMessage(payload: ReceiveEncryptedMessagePayload) {
		peerConnectionReceiveEncryptedMessage(this, payload);
	}

	createUserAndInitSocket() {
		const socket = this.socket;
		if (!socket) {
			throw new PeerConnectionSocketNotDefined();
		}

		socket.removeAllListeners();
		watchBrowserTrust(socket, () =>
			setAndShowErrorDialogMessage(this, ErrorMessage.TRUST_STORAGE_ERROR),
		);

		const userCreatedCallback = (createdUser: LocalPeerUser) => {
			this.user = createdUser;

			peerConnectionHandleSocket(this);

			this.beforeunloadHandler = () => {
				socket.emit('USER_DISCONNECT');
			};
			window.addEventListener('beforeunload', this.beforeunloadHandler);
		};

		this.createUser().then((newUser: LocalPeerUser) =>
			userCreatedCallback(newUser),
		);
	}
}
