import socketIO, { Socket } from 'socket.io-client';

let socket: Socket;

const TRUST_KEY = 'deskreen-trusted-browser';

export const connect = (roomId: string) => {
	let trustToken: string | null = null;
	try {
		trustToken = window.localStorage.getItem(TRUST_KEY);
	} catch {
		// A connection can still be approved without remembering the browser.
	}
	const bytes = new Uint8Array(32);
	window.crypto.getRandomValues(bytes);
	const candidateToken = btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	socket = socketIO(window.location.origin, {
		query: {
			roomId,
		},
		forceNew: true,
		auth: { trustToken, candidateToken },
	});
	return socket;
};

export const watchBrowserTrust = (
	current: Socket,
	onStorageError: () => void,
) => {
	const auth = current.auth as {
		trustToken: string | null;
		candidateToken: string;
	};
	const { trustToken, candidateToken } = auth;
	current.on('BROWSER_REMEMBERED', () => {
		try {
			if (window.localStorage.getItem(TRUST_KEY) !== trustToken)
				throw new Error('Browser credential changed');
			window.localStorage.setItem(TRUST_KEY, candidateToken);
			if (window.localStorage.getItem(TRUST_KEY) !== candidateToken)
				throw new Error('Browser credential was not saved');
			current.auth = { trustToken: candidateToken, candidateToken };
		} catch {
			onStorageError();
		}
	});
};

export const getSocket = () => socket;
