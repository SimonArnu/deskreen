import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TrustedBrowsers } from '../src/server/trustedBrowsers.mts';

test('remembered credentials survive restart without storing the secret', () => {
	const file = join(
		mkdtempSync(join(tmpdir(), 'deskreen-trust-')),
		'trust.json',
	);
	const token = randomBytes(32).toString('base64url');
	const browsers = new TrustedBrowsers(file);
	assert.equal(browsers.find(token), undefined);
	const browser = browsers.remember(token, 'Firefox on Android');
	assert.ok(browser);
	assert.doesNotMatch(readFileSync(file, 'utf8'), new RegExp(token));
	const restarted = new TrustedBrowsers(file);
	assert.deepEqual(restarted.find(token), browser);
	assert.deepEqual(restarted.list(), [browser]);
	assert.equal(restarted.remember(token, 'Duplicate'), undefined);
	assert.equal(restarted.revoke(browser.id), true);
	assert.equal(new TrustedBrowsers(file).find(token), undefined);
	assert.equal(restarted.revoke(browser.id), false);
});

test('malformed credentials cannot be remembered or authenticated', () => {
	const file = join(
		mkdtempSync(join(tmpdir(), 'deskreen-trust-')),
		'trust.json',
	);
	const browsers = new TrustedBrowsers(file);
	for (const token of ['', 'short', 'a'.repeat(43), 'a'.repeat(44), null, 42]) {
		assert.equal(browsers.remember(token, 'Browser'), undefined);
		assert.equal(browsers.find(token), undefined);
	}
});

test('invalid persisted data fails closed instead of silently resetting trust', () => {
	const file = join(
		mkdtempSync(join(tmpdir(), 'deskreen-trust-')),
		'trust.json',
	);
	writeFileSync(file, 'invalid');
	assert.throws(() => new TrustedBrowsers(file));
});
