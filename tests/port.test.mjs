import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePort } from '../src/main/helpers/parsePort.mts';

test('uses the default port when no port is specified', () => {
	assert.equal(parsePort(['deskreen']), undefined);
});

test('accepts a configured port', () => {
	assert.equal(parsePort(['deskreen', '--port', '8443']), 8443);
	assert.equal(parsePort(['deskreen', '--port', '1']), 1);
	assert.equal(parsePort(['deskreen', '--port', '65535']), 65535);
});

test('rejects missing, invalid and duplicate port arguments', () => {
	for (const args of [
		['--port'],
		['--port', '--ip'],
		['--port', '0'],
		['--port', '65536'],
		['--port', '31abc'],
		['--port', '1.5'],
		['--port', '3131', '--port', '3132'],
	]) {
		assert.throws(() => parsePort(args), /--port/);
	}
});
