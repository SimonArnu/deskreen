import { spawn } from 'node:child_process';
import { once } from 'node:events';

const xvfb = spawn(
	process.env.XVFB_BIN || 'Xvfb',
	[
		'-displayfd',
		'1',
		'-screen',
		'0',
		'1280x800x24',
		'-ac',
		'-nolisten',
		'tcp',
		'-noreset',
	],
	{ stdio: ['ignore', 'pipe', 'pipe'] },
);
const xvfbClosed = once(xvfb, 'close');
let output = '';
xvfb.stderr.on('data', (data) => {
	output += data;
});
try {
	const display = await new Promise((resolve, reject) => {
		xvfb.stdout.once('data', (data) => resolve(data.toString().trim()));
		xvfb.once('error', reject);
		xvfb.once('exit', () => reject(new Error(`Xvfb exited: ${output}`)));
	});
	const env = {
		...process.env,
		DISPLAY: `:${display}`,
		XDG_SESSION_TYPE: 'x11',
		MOZ_ENABLE_WAYLAND: '0',
		LIBGL_ALWAYS_SOFTWARE: '1',
	};
	delete env.WAYLAND_DISPLAY;
	const test = spawn(
		process.execPath,
		['tests/app-https.mjs', '--firefox', '--live'],
		{ env, stdio: 'inherit' },
	);
	const [code] = await once(test, 'exit');
	if (code !== 0) throw new Error(`Live stream test exited ${code}`);
} finally {
	if (xvfb.exitCode === null && xvfb.signalCode === null) xvfb.kill();
	await xvfbClosed;
}
