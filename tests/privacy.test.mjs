import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';

async function sourceFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			return /\.(?:html|js|ts|tsx)$/.test(entry.name) ? [path] : [];
		}),
	);
	return files.flat();
}

test('viewer source does not load or use analytics', async () => {
	const files = [
		'.github/workflows/release.yml',
		'src/client-viewer/index.html',
		'src/client-viewer/vite.config.ts',
		...(await sourceFiles('src/client-viewer/src')),
	];
	for (const file of files) {
		const source = await readFile(file, 'utf8');
		assert.doesNotMatch(
			source,
			/googletagmanager|google-analytics|VITE_CLIENT_VIEWER_GA_TAG|trackAnalyticsEvent|useScreenViewingTracker|PrivacyConsentDialog|PrivacyControlDialog|initializeGARequestInterceptor/i,
			file,
		);
	}
});

test('desktop startup does not check an external release endpoint', async () => {
	const source = await readFile('src/main/index.ts', 'utf8');
	assert.doesNotMatch(
		source,
		/getNewVersionTag|checkForLatestVersionAndNotify/,
	);
});
