import socketIO from 'socket.io-client';

export const connectSocket = (
	port: string,
	roomId: string,
	ownerToken: string,
) => {
	return socketIO(`https://127.0.0.1:${port}`, {
		query: {
			roomId,
			ownerToken,
		},
		auth: { ownerToken },
		transports: ['websocket'],
		forceNew: true,
	});
};

export default {};
