const queues = new Map<string, Promise<void>>();

export function runInRoom<T>(
	roomId: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = queues.get(roomId) ?? Promise.resolve();
	const result = previous.then(operation);
	const tail = result.then(
		() => {},
		() => {},
	);
	queues.set(roomId, tail);
	void tail.then(() => {
		if (queues.get(roomId) === tail) queues.delete(roomId);
	});
	return result;
}
