import { execFileSync } from 'node:child_process';
import {
	createHash,
	createPublicKey,
	randomBytes,
	X509Certificate,
} from 'node:crypto';
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface Certificates {
	ca: string;
	cert: string;
	key: string;
}

function runOpenSSL(args: string[]): void {
	try {
		execFileSync('openssl', args, { stdio: 'pipe' });
	} catch (error) {
		throw new Error('Unable to generate certificates with openssl', {
			cause: error,
		});
	}
}

function generateCertificates(directory: string, hostname: string): void {
	const caKey = join(directory, 'ca.key');
	const caCert = join(directory, 'ca.crt');
	const serverKey = join(directory, 'server.key');

	runOpenSSL([
		'genpkey',
		'-algorithm',
		'EC',
		'-pkeyopt',
		'ec_paramgen_curve:P-256',
		'-out',
		caKey,
	]);
	chmodSync(caKey, 0o600);
	runOpenSSL([
		'req',
		'-new',
		'-x509',
		'-key',
		caKey,
		'-sha256',
		'-days',
		'3650',
		'-subj',
		`/CN=Deskreen Local CA ${randomBytes(8).toString('hex')}`,
		'-addext',
		'basicConstraints=critical,CA:TRUE,pathlen:0',
		'-addext',
		'keyUsage=critical,keyCertSign,cRLSign',
		'-out',
		caCert,
	]);
	runOpenSSL([
		'genpkey',
		'-algorithm',
		'EC',
		'-pkeyopt',
		'ec_paramgen_curve:P-256',
		'-out',
		serverKey,
	]);
	chmodSync(serverKey, 0o600);
	signServerCertificate(directory, directory, hostname, 397);
}

function signServerCertificate(
	directory: string,
	output: string,
	hostname: string,
	days: number,
): void {
	const request = join(output, 'server.csr');
	const extensions = join(output, 'server-extensions.cnf');
	const serverCert = join(output, 'server.crt');
	runOpenSSL([
		'req',
		'-new',
		'-key',
		join(directory, 'server.key'),
		'-subj',
		'/CN=Deskreen Local Server',
		'-out',
		request,
	]);
	writeFileSync(
		extensions,
		`[extensions]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname},DNS:localhost,IP:127.0.0.1,IP:::1\n`,
		{ mode: 0o600 },
	);
	runOpenSSL([
		'x509',
		'-req',
		'-in',
		request,
		'-CA',
		join(directory, 'ca.crt'),
		'-CAkey',
		join(directory, 'ca.key'),
		'-set_serial',
		`0x${randomBytes(16).toString('hex')}`,
		'-days',
		String(days),
		'-sha256',
		'-extfile',
		extensions,
		'-extensions',
		'extensions',
		'-out',
		serverCert,
	]);
}

function certificateDirectory(directory: string, hostname: string): string {
	const parent = dirname(directory);
	const prefix = `.deskreen-certificates-${storeId(directory)}-`;
	try {
		lstatSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		if (
			readdirSync(parent).some(
				(name) =>
					name.startsWith(prefix) &&
					/^[a-zA-Z0-9]{6}$/.test(name.slice(prefix.length)),
			)
		) {
			throw new Error(
				'An existing certificate store has lost its link; recover it before continuing',
			);
		}
		{
			const staging = mkdtempSync(join(parent, prefix));
			let published = false;
			try {
				generateCertificates(staging, hostname);
				readCertificates(staging, hostname, false);
				writeFileSync(join(staging, 'published'), 'published', {
					mode: 0o600,
					flag: 'wx',
				});
				try {
					// Publishing the link never replaces an existing certificate store.
					symlinkSync(basename(staging), directory, 'dir');
					published = true;
				} catch (publishError) {
					if ((publishError as NodeJS.ErrnoException).code !== 'EEXIST')
						throw publishError;
				}
			} finally {
				if (!published) rmSync(staging, { recursive: true, force: true });
			}
		}
	}
	if (!lstatSync(directory).isSymbolicLink())
		throw new Error('Certificate store already exists');
	const target = readlinkSync(directory);
	if (
		!target.startsWith(prefix) ||
		!/^[a-zA-Z0-9]{6}$/.test(target.slice(prefix.length))
	) {
		throw new Error('Invalid certificate store link');
	}
	const store = join(parent, target);
	checkPrivateDirectory(store);
	const marker = join(store, 'published');
	try {
		writeFileSync(marker, 'published', { mode: 0o600, flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		if (readRegularFile(marker, true) !== 'published')
			throw new Error('Invalid certificate store marker');
	}
	return store;
}

function storeId(directory: string): string {
	return createHash('sha256')
		.update(basename(directory))
		.digest('hex')
		.slice(0, 12);
}

function withStoreLock<T>(directory: string, operation: () => T): T {
	const parent = dirname(directory);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	checkPrivateDirectory(parent);
	const fd = openSync(
		join(parent, `.deskreen-lock-${storeId(directory)}`),
		constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			(stat.mode & 0o077) !== 0 ||
			(process.getuid && stat.uid !== process.getuid())
		) {
			throw new Error('Certificate lock must be a private regular file');
		}
		// The inherited descriptor retains the lock until it is closed here.
		execFileSync('flock', ['--exclusive', '--timeout', '5', '3'], {
			stdio: ['ignore', 'pipe', 'pipe', fd],
		});
		return operation();
	} finally {
		closeSync(fd);
	}
}

function checkPrivateDirectory(path: string): void {
	const stat = lstatSync(path);
	if (
		!stat.isDirectory() ||
		(stat.mode & 0o077) !== 0 ||
		(process.getuid && stat.uid !== process.getuid())
	) {
		throw new Error(
			'Certificate directory must be private and owned by the current user',
		);
	}
}

function readRegularFile(path: string, privateFile = false): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			(process.getuid && stat.uid !== process.getuid()) ||
			(privateFile && (stat.mode & 0o077) !== 0)
		) {
			throw new Error(
				'Certificate files must be regular files with private keys accessible only to the owner',
			);
		}
		return readFileSync(fd, 'utf8');
	} finally {
		closeSync(fd);
	}
}

function readCertificates(
	directory: string,
	hostname: string,
	renew: boolean,
): Certificates {
	checkPrivateDirectory(directory);
	const ca = readRegularFile(join(directory, 'ca.crt'));
	const caKey = readRegularFile(join(directory, 'ca.key'), true);
	let cert = readRegularFile(join(directory, 'server.crt'));
	const key = readRegularFile(join(directory, 'server.key'), true);
	const authority = new X509Certificate(ca);
	let leaf = new X509Certificate(cert);
	const now = Date.now();
	if (
		Date.parse(authority.validFrom) > now ||
		Date.parse(authority.validTo) <= now
	) {
		throw new Error('Certificate authority is expired or not yet valid');
	}
	const publicKey = (key: string) =>
		createPublicKey(key).export({ type: 'spki', format: 'pem' });
	if (
		!authority.ca ||
		leaf.ca ||
		!authority.checkIssued(authority) ||
		!leaf.checkIssued(authority) ||
		Date.parse(leaf.validTo) > Date.parse(authority.validTo) ||
		!authority.verify(authority.publicKey) ||
		!leaf.verify(authority.publicKey) ||
		publicKey(caKey) !==
			authority.publicKey.export({ type: 'spki', format: 'pem' }) ||
		publicKey(key) !== leaf.publicKey.export({ type: 'spki', format: 'pem' }) ||
		!leaf.checkIP('127.0.0.1')
	) {
		throw new Error('Certificate and keys do not match');
	}
	if (Date.parse(leaf.validFrom) > now)
		throw new Error('Certificate is not yet valid');
	if (
		Date.parse(leaf.validTo) <= now + 30 * 86400000 ||
		!leaf.checkHost(hostname)
	) {
		if (!renew)
			throw new Error(
				'Certificate is expired or does not match the local hostname',
			);
		const days = Math.min(
			397,
			Math.floor((Date.parse(authority.validTo) - now) / 86400000) - 1,
		);
		if (days <= 30)
			throw new Error(
				'Certificate authority is near expiry and requires replacement',
			);
		const staging = mkdtempSync(join(directory, '.leaf-'));
		try {
			signServerCertificate(directory, staging, hostname, days);
			cert = readRegularFile(join(staging, 'server.crt'));
			leaf = new X509Certificate(cert);
			const checkedAt = Date.now();
			if (
				leaf.ca ||
				!leaf.checkIssued(authority) ||
				!leaf.verify(authority.publicKey) ||
				!leaf.checkHost(hostname) ||
				!leaf.checkIP('127.0.0.1') ||
				Date.parse(leaf.validFrom) > checkedAt ||
				Date.parse(leaf.validTo) <= checkedAt ||
				Date.parse(leaf.validTo) > Date.parse(authority.validTo) ||
				publicKey(key) !==
					leaf.publicKey.export({ type: 'spki', format: 'pem' })
			) {
				throw new Error('Renewed certificate is invalid');
			}
			renameSync(join(staging, 'server.crt'), join(directory, 'server.crt'));
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}
	return { ca, cert, key };
}

export function loadCertificates(
	directory: string,
	hostname: string,
): Certificates {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/i.test(hostname)) {
		throw new Error('Invalid local hostname');
	}
	try {
		return withStoreLock(directory, () =>
			readCertificates(
				certificateDirectory(directory, hostname),
				hostname,
				true,
			),
		);
	} catch (error) {
		throw new Error('Unable to load or create certificates', { cause: error });
	}
}
