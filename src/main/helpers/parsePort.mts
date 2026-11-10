export function parsePort(args: string[]): number | undefined {
	const indexes = args.flatMap((arg, index) =>
		arg === '--port' ? [index] : [],
	);
	if (indexes.length === 0) return undefined;

	const value = args[indexes[0] + 1];
	if (indexes.length !== 1 || !value || !/^\d+$/.test(value)) {
		throw new Error('--port requires a single integer between 1 and 65535');
	}

	const port = Number(value);
	if (port < 1 || port > 65535) {
		throw new Error('--port requires a single integer between 1 and 65535');
	}
	return port;
}
