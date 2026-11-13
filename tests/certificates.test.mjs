import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { X509Certificate, createPublicKey, createHash } from 'node:crypto';
import {
	chmod,
	mkdtemp,
	readFile,
	readlink,
	stat,
	symlink,
	unlink,
	writeFile,
	mkdir,
} from 'node:fs/promises';
import { createServer, request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadCertificates } from '../src/server/certificates.mts';

test('creates a persistent private CA and a certificate for the local host', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const first = loadCertificates(directory, 'deskreen.local');
	const second = loadCertificates(directory, 'deskreen.local');
	assert.deepEqual(second, first);

	const ca = new X509Certificate(first.ca);
	const certificate = new X509Certificate(first.cert);
	assert.equal(ca.ca, true);
	assert.equal(certificate.ca, false);
	assert.equal(certificate.verify(ca.publicKey), true);
	assert.equal(certificate.checkHost('deskreen.local'), 'deskreen.local');
	assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
	assert.equal(
		createPublicKey(first.key).export({ type: 'spki', format: 'pem' }),
		certificate.publicKey.export({ type: 'spki', format: 'pem' }),
	);
	assert.equal((await stat(directory)).mode & 0o777, 0o700);
	assert.equal((await stat(join(directory, 'ca.key'))).mode & 0o777, 0o600);
	assert.equal((await stat(join(directory, 'server.key'))).mode & 0o777, 0o600);

	const server = createServer(
		{ key: first.key, cert: first.cert },
		(_req, res) => res.end('ok'),
	);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		const call = (servername) =>
			new Promise((resolve, reject) => {
				const req = request(
					{
						host: '127.0.0.1',
						port: server.address().port,
						servername,
						ca: first.ca,
					},
					(res) => {
						res.resume();
						res.on('end', () => resolve(res.statusCode));
					},
				);
				req.on('error', reject);
				req.end();
			});
		assert.equal(await call('deskreen.local'), 200);
		await assert.rejects(call('other.local'), {
			code: 'ERR_TLS_CERT_ALTNAME_INVALID',
		});
		await assert.rejects(
			new Promise((resolve, reject) => {
				const req = request(
					{
						host: '127.0.0.1',
						port: server.address().port,
						servername: 'deskreen.local',
					},
					resolve,
				);
				req.on('error', reject);
				req.end();
			}),
			{ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
		);
	} finally {
		server.close();
	}
});

test('LAN IP addresses are authenticated without replacing the private CA', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	const addresses = ['192.168.1.25', '10.2.3.4'];
	const withAddresses = loadCertificates(
		directory,
		'deskreen.local',
		addresses,
	);
	assert.equal(withAddresses.ca, original.ca);
	assert.equal(withAddresses.key, original.key);
	const leaf = new X509Certificate(withAddresses.cert);
	for (const address of addresses) assert.equal(leaf.checkIP(address), address);
	assert.equal(leaf.checkHost('deskreen.local'), 'deskreen.local');
	assert.deepEqual(
		loadCertificates(directory, 'deskreen.local', [...addresses].reverse()),
		withAddresses,
	);
	assert.deepEqual(
		loadCertificates(directory, 'deskreen.local', [
			...addresses,
			addresses[0],
			'127.0.0.1',
		]),
		withAddresses,
	);
	const server = createServer(
		{ key: withAddresses.key, cert: withAddresses.cert },
		(_req, res) => res.end('ok'),
	);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		const call = (identity) =>
			new Promise((resolve, reject) => {
				const req = request(
					{
						host: '127.0.0.1',
						port: server.address().port,
						servername: 'deskreen.local',
						ca: withAddresses.ca,
						checkServerIdentity: (_, cert) =>
							checkServerIdentity(identity, cert),
					},
					(res) => {
						res.resume();
						res.on('end', () => resolve(res.statusCode));
					},
				);
				req.on('error', reject);
				req.end();
			});
		assert.equal(await call('192.168.1.25'), 200);
		await assert.rejects(call('192.168.1.26'), {
			code: 'ERR_TLS_CERT_ALTNAME_INVALID',
		});
	} finally {
		server.close();
	}
	const changed = loadCertificates(directory, 'deskreen.local', [
		'192.168.1.26',
	]);
	assert.equal(changed.ca, original.ca);
	assert.equal(changed.key, original.key);
	assert.equal(
		new X509Certificate(changed.cert).checkIP('192.168.1.25'),
		undefined,
	);
	assert.equal(
		new X509Certificate(changed.cert).checkIP('192.168.1.26'),
		'192.168.1.26',
	);
});

test('invalid LAN addresses do not alter an existing certificate store', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	for (const addresses of [
		['192.168.1.1\nsubjectAltName=DNS:evil.local'],
		['::1'],
		['not-an-ip'],
		[null],
		'192.168.1.1',
	]) {
		assert.throws(() =>
			loadCertificates(directory, 'deskreen.local', addresses),
		);
		assert.deepEqual(loadCertificates(directory, 'deskreen.local'), original);
	}
});

test('reissues for changed hostnames and rejects insecure or modified keys', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	const renamed = loadCertificates(directory, 'other.local');
	assert.equal(renamed.ca, original.ca);
	assert.equal(renamed.key, original.key);
	assert.equal(
		new X509Certificate(renamed.cert).checkHost('other.local'),
		'other.local',
	);
	const restored = loadCertificates(directory, 'deskreen.local');
	assert.equal(restored.ca, original.ca);
	assert.equal(restored.key, original.key);
	await chmod(join(directory, 'ca.key'), 0o644);
	assert.throws(
		() => loadCertificates(directory, 'deskreen.local'),
		/certificate/i,
	);
	await chmod(join(directory, 'ca.key'), 0o600);
	await writeFile(join(directory, 'server.key'), 'not a key');
	assert.throws(
		() => loadCertificates(directory, 'deskreen.local'),
		/certificate/i,
	);
	assert.equal(
		await readFile(join(directory, 'server.key'), 'utf8'),
		'not a key',
	);
});

test('rejects invalid names and incomplete existing certificates without replacing them', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	assert.throws(
		() =>
			loadCertificates(
				join(root, 'invalid'),
				'x.local\nsubjectAltName=DNS:evil.local',
			),
		/hostname/i,
	);
	const directory = join(root, 'existing');
	await mkdir(directory);
	await writeFile(join(directory, 'ca.key'), 'preserve');
	assert.throws(
		() => loadCertificates(directory, 'deskreen.local'),
		/certificate/i,
	);
	assert.equal(await readFile(join(directory, 'ca.key'), 'utf8'), 'preserve');
});

test('renews an expired server certificate without replacing the CA', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	execFileSync(
		'openssl',
		[
			'x509',
			'-req',
			'-in',
			join(directory, 'server.csr'),
			'-CA',
			join(directory, 'ca.crt'),
			'-CAkey',
			join(directory, 'ca.key'),
			'-set_serial',
			'10',
			'-days',
			'0',
			'-sha256',
			'-extfile',
			join(directory, 'server-extensions.cnf'),
			'-extensions',
			'extensions',
			'-out',
			join(directory, 'server.crt'),
		],
		{ stdio: 'pipe' },
	);
	const renewed = loadCertificates(directory, 'deskreen.local');
	assert.equal(renewed.ca, original.ca);
	assert.equal(renewed.key, original.key);
	assert.ok(Date.parse(new X509Certificate(renewed.cert).validTo) > Date.now());
	assert.equal(await readFile(join(directory, 'ca.crt'), 'utf8'), original.ca);
});

test('renews a server certificate that is close to expiry', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	execFileSync(
		'openssl',
		[
			'x509',
			'-req',
			'-in',
			join(directory, 'server.csr'),
			'-CA',
			join(directory, 'ca.crt'),
			'-CAkey',
			join(directory, 'ca.key'),
			'-set_serial',
			'11',
			'-days',
			'10',
			'-sha256',
			'-extfile',
			join(directory, 'server-extensions.cnf'),
			'-extensions',
			'extensions',
			'-out',
			join(directory, 'server.crt'),
		],
		{ stdio: 'pipe' },
	);
	const renewed = loadCertificates(directory, 'deskreen.local');
	assert.equal(renewed.ca, original.ca);
	assert.ok(
		Date.parse(new X509Certificate(renewed.cert).validTo) >
			Date.now() + 30 * 86400000,
	);
});

test('accepts the maximum valid hostname length', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const hostname = `${'a'.repeat(63)}.local`;
	const result = loadCertificates(join(root, 'certificates'), hostname);
	assert.equal(new X509Certificate(result.cert).checkHost(hostname), hostname);
});

test('a failed first initialization can be retried', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const oldPath = process.env.PATH;
	try {
		process.env.PATH = join(root, 'missing');
		assert.throws(
			() => loadCertificates(directory, 'deskreen.local'),
			/certificate/i,
		);
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
	}
	await assert.rejects(stat(directory), { code: 'ENOENT' });
	assert.ok(loadCertificates(directory, 'deskreen.local').ca);
});

test('concurrent initialization preserves a single CA', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const moduleUrl = pathToFileURL(resolve('src/server/certificates.mts')).href;
	const source = `import { loadCertificates } from ${JSON.stringify(moduleUrl)}; console.log(loadCertificates(${JSON.stringify(directory)}, 'deskreen.local').ca);`;
	const run = () =>
		new Promise((resolveChild, rejectChild) => {
			const child = spawn(process.execPath, [
				'--input-type=module',
				'-e',
				source,
			]);
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (data) => {
				stdout += data;
			});
			child.stderr.on('data', (data) => {
				stderr += data;
			});
			child.on('error', rejectChild);
			child.on('close', (code) =>
				code === 0 ? resolveChild(stdout) : rejectChild(new Error(stderr)),
			);
		});
	const [first, second] = await Promise.all([run(), run()]);
	assert.equal(first, second);
	assert.equal(
		first.trim(),
		loadCertificates(directory, 'deskreen.local').ca.trim(),
	);
});

test('refuses to replace a previously published CA if its link is lost', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	const store = join(root, await readlink(directory));
	await unlink(directory);
	assert.throws(
		() => loadCertificates(directory, 'deskreen.local'),
		/certificate/i,
	);
	assert.equal(await readFile(join(store, 'ca.crt'), 'utf8'), original.ca);
});

test('refuses to replace an orphaned CA even if its marker is missing', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	const store = join(root, await readlink(directory));
	await unlink(join(store, 'published'));
	await unlink(directory);
	assert.throws(
		() => loadCertificates(directory, 'deskreen.local'),
		/certificate/i,
	);
	assert.equal(await readFile(join(store, 'ca.crt'), 'utf8'), original.ca);
});

test('rejects an insecure parent and a symlinked private key', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	await chmod(root, 0o755);
	assert.throws(
		() => loadCertificates(join(root, 'certificates'), 'deskreen.local'),
		/certificate/i,
	);
	await chmod(root, 0o700);
	const directory = join(root, 'certificates');
	loadCertificates(directory, 'deskreen.local');
	const key = join(directory, 'server.key');
	const actual = await readFile(key, 'utf8');
	const otherKey = join(root, 'other.key');
	await writeFile(otherKey, actual, { mode: 0o600 });
	await unlink(key);
	await symlink(otherKey, key);
	assert.throws(
		() => loadCertificates(directory, 'deskreen.local'),
		/certificate/i,
	);
});

test('rejects a symlinked certificate parent without creating a store', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const actualParent = join(root, 'actual');
	const linkedParent = join(root, 'linked');
	await mkdir(actualParent, { mode: 0o700 });
	await symlink(actualParent, linkedParent, 'dir');
	assert.throws(
		() =>
			loadCertificates(join(linkedParent, 'certificates'), 'deskreen.local'),
		/certificate/i,
	);
	await assert.rejects(stat(join(actualParent, 'certificates')), {
		code: 'ENOENT',
	});
});

test('rejects a leaf whose issuer does not match the authority', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	loadCertificates(directory, 'deskreen.local');
	execFileSync(
		'openssl',
		[
			'req',
			'-new',
			'-x509',
			'-key',
			join(directory, 'ca.key'),
			'-sha256',
			'-days',
			'3650',
			'-subj',
			'/CN=Different Authority',
			'-addext',
			'basicConstraints=critical,CA:TRUE,pathlen:0',
			'-addext',
			'keyUsage=critical,keyCertSign,cRLSign',
			'-out',
			join(directory, 'ca.crt'),
		],
		{ stdio: 'pipe' },
	);
	assert.throws(
		() => loadCertificates(directory, 'deskreen.local'),
		/certificate/i,
	);
});

test('rejects a leaf that outlives its certificate authority', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	const subject = new X509Certificate(original.ca).subject;
	execFileSync(
		'openssl',
		[
			'req',
			'-new',
			'-x509',
			'-key',
			join(directory, 'ca.key'),
			'-sha256',
			'-days',
			'20',
			'-subj',
			`/${subject}`,
			'-addext',
			'basicConstraints=critical,CA:TRUE,pathlen:0',
			'-addext',
			'keyUsage=critical,keyCertSign,cRLSign',
			'-out',
			join(directory, 'ca.crt'),
		],
		{ stdio: 'pipe' },
	);
	const replaced = await readFile(join(directory, 'ca.crt'), 'utf8');
	assert.throws(
		() => loadCertificates(directory, 'deskreen.local'),
		/certificate/i,
	);
	assert.equal(await readFile(join(directory, 'ca.crt'), 'utf8'), replaced);
});

test('waits for another certificate operation before renewing the leaf', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	const id = createHash('sha256')
		.update('certificates')
		.digest('hex')
		.slice(0, 12);
	const lock = join(root, `.deskreen-lock-${id}`);
	const holder = spawn('flock', [
		'-x',
		lock,
		process.execPath,
		'-e',
		'process.stdout.write("locked"); setTimeout(() => {}, 700)',
	]);
	const exit = once(holder, 'close');
	await once(holder.stdout, 'data');
	const started = Date.now();
	const renewed = loadCertificates(directory, 'other.local');
	assert.ok(Date.now() - started >= 200);
	assert.equal((await exit)[0], 0);
	assert.equal(
		new X509Certificate(renewed.cert).checkHost('other.local'),
		'other.local',
	);
	assert.equal(renewed.ca, original.ca);
});

test('releases the certificate lock if its owner crashes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	const id = createHash('sha256')
		.update('certificates')
		.digest('hex')
		.slice(0, 12);
	const lock = join(root, `.deskreen-lock-${id}`);
	const script = `const fs = require('node:fs'); const {execFileSync} = require('node:child_process'); const fd = fs.openSync(${JSON.stringify(lock)}, 'r+'); execFileSync('flock', ['-x', '3'], {stdio: ['ignore', 'pipe', 'pipe', fd]}); process.stdout.write('locked'); process.stdin.resume();`;
	const holder = spawn(process.execPath, ['-e', script], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const exit = once(holder, 'close');
	await once(holder.stdout, 'data');
	holder.kill('SIGKILL');
	assert.equal((await exit)[1], 'SIGKILL');
	const renewed = loadCertificates(directory, 'other.local');
	assert.equal(renewed.ca, original.ca);
	assert.equal(
		new X509Certificate(renewed.cert).checkHost('other.local'),
		'other.local',
	);
});

test('fails safely when the CA is too close to expiry for leaf renewal', async () => {
	const root = await mkdtemp(join(tmpdir(), 'deskreen-cert-test-'));
	const directory = join(root, 'certificates');
	const original = loadCertificates(directory, 'deskreen.local');
	const subject = new X509Certificate(original.ca).subject;
	execFileSync(
		'openssl',
		[
			'req',
			'-new',
			'-x509',
			'-key',
			join(directory, 'ca.key'),
			'-sha256',
			'-days',
			'31',
			'-subj',
			`/${subject}`,
			'-addext',
			'basicConstraints=critical,CA:TRUE,pathlen:0',
			'-addext',
			'keyUsage=critical,keyCertSign,cRLSign',
			'-out',
			join(directory, 'ca.crt'),
		],
		{ stdio: 'pipe' },
	);
	execFileSync(
		'openssl',
		[
			'x509',
			'-req',
			'-in',
			join(directory, 'server.csr'),
			'-CA',
			join(directory, 'ca.crt'),
			'-CAkey',
			join(directory, 'ca.key'),
			'-set_serial',
			'12',
			'-days',
			'10',
			'-sha256',
			'-extfile',
			join(directory, 'server-extensions.cnf'),
			'-extensions',
			'extensions',
			'-out',
			join(directory, 'server.crt'),
		],
		{ stdio: 'pipe' },
	);
	const ca = await readFile(join(directory, 'ca.crt'), 'utf8');
	const cert = await readFile(join(directory, 'server.crt'), 'utf8');
	assert.throws(
		() => loadCertificates(directory, 'deskreen.local'),
		/certificate/i,
	);
	assert.equal(await readFile(join(directory, 'ca.crt'), 'utf8'), ca);
	assert.equal(await readFile(join(directory, 'server.crt'), 'utf8'), cert);
});
