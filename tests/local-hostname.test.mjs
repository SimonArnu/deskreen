import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalHostname } from '../src/main/helpers/localHostname.mts';

test('uses Avahi’s advertised local name', () => {
	assert.equal(parseLocalHostname("('Laptop-1.local',)\n"), 'laptop-1.local');
});

test('rejects invalid, missing, or non-local names', () => {
	for (const response of [
		'',
		"('foo.example.com',)",
		"('bad_name.local',)",
		"('foo.local', 'extra')",
		"('foo.local\nexample.com',)",
	]) {
		assert.throws(() => parseLocalHostname(response), /hostname/i);
	}
});
