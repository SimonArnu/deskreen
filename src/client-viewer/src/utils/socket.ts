import socketIO, { Socket } from 'socket.io-client';

let socket: Socket;

export const connect = (roomId: string) => {
	socket = socketIO(window.location.origin, {
		query: {
			roomId,
		},
		forceNew: true,
	});
	return socket;
};

export const getSocket = () => socket;
