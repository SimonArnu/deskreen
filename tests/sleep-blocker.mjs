import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = await mkdtemp(join(tmpdir(), 'deskreen-sleep-test-'));
const entry = join(directory, 'test.cjs');
await build({
	entryPoints: ['tests/sleep-blocker.fixture.ts'],
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
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
