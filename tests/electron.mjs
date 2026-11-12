import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = await mkdtemp(join(tmpdir(), 'deskreen-electron-test-'));
const entry = join(directory, 'test.cjs');
await build({
	entryPoints: [process.argv[2]],
	outfile: entry,
	bundle: true,
	platform: 'node',
	external: ['electron'],
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(
	process.env.ELECTRON_BINARY || 'node_modules/.bin/electron',
	[entry],
	{ env, encoding: 'utf8', timeout: 30000 },
);
if (result.error || result.status !== 0) {
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.error) throw result.error;
	process.exit(result.status || 1);
}
const expectedTlsFailure =
	/^\[\d+:\d+\/\d+\.\d+:ERROR:net\/socket\/ssl_client_socket_impl\.cc:\d+\] handshake failed; returned -1, SSL error code 1, net_error -2$/;
const unexpected = result.stderr
	.split('\n')
	.filter(
		(line) =>
			line &&
			!(
				process.argv[2] === 'tests/tls-verification.fixture.ts' &&
				expectedTlsFailure.test(line)
			),
	);
if (unexpected.length)
	throw new Error(`Unexpected Electron output:\n${unexpected.join('\n')}`);
if (
	['tests/signaling.fixture.ts', 'tests/trusted-signaling.fixture.ts'].includes(
		process.argv[2],
	)
) {
	const lines = result.stdout.trim().split('\n');
	if (
		/skipping desktop capturer auto refresh on wayland session$/.test(lines[0])
	)
		lines.shift();
	const expected = [
		/Deskreen CE signaling server is online at port 0$/,
		/Server available at https:\/\/deskreen\.local:0$/,
		process.argv[2] === 'tests/signaling.fixture.ts'
			? /^Concurrent viewers cannot both enter the signaling room\.$/
			: /^Trusted viewers require explicit enrollment and can be revoked\.$/,
	];
	if (
		lines.length !== expected.length ||
		lines.some((line, index) => !expected[index].test(line))
	) {
		throw new Error(`Unexpected signaling output:\n${result.stdout}`);
	}
	console.log(lines[lines.length - 1]);
} else if (result.stdout) process.stdout.write(result.stdout);
