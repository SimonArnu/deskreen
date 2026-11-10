import { once } from 'node:events';

export async function connectDevtools(endpoint) {
	const socket = new WebSocket(endpoint);
	await once(socket, 'open');
	let nextId = 0;
	const pending = new Map();
	const listeners = new Set();
	socket.addEventListener('message', ({ data }) => {
		const message = JSON.parse(data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(message.error.message));
			else resolve(message.result);
		}
		if (message.method) for (const listener of listeners) listener(message);
	});
	socket.addEventListener('close', () => {
		for (const { reject } of pending.values())
			reject(new Error('DevTools connection closed'));
		pending.clear();
	});
	return {
		send(method, params = {}, sessionId) {
			const id = ++nextId;
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`DevTools request timed out: ${method}`));
				}, 10000);
				pending.set(id, {
					resolve: (value) => {
						clearTimeout(timeout);
						resolve(value);
					},
					reject: (error) => {
						clearTimeout(timeout);
						reject(error);
					},
				});
				try {
					socket.send(JSON.stringify({ id, method, params, sessionId }));
				} catch (error) {
					clearTimeout(timeout);
					pending.delete(id);
					reject(error);
				}
			});
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close() {
			socket.close();
		},
	};
}
