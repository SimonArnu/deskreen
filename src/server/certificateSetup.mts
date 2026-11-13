import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

export interface SetupInterface {
	name: string;
	address: string;
}

export function isLocalIPv4(address: string): boolean {
	if (!isIPv4(address)) return false;
	const [first, second] = address.split('.').map(Number);
	return (
		first === 10 ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		(first === 169 && second === 254)
	);
}

export function getSetupInterfaces(): SetupInterface[] {
	const result: SetupInterface[] = [];
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		for (const entry of addresses ?? []) {
			if (
				entry.family === 'IPv4' &&
				!entry.internal &&
				isLocalIPv4(entry.address)
			) {
				result.push({ name, address: entry.address });
			}
		}
	}
	return result;
}

export function getViewerInterfaces(
	interfaces: SetupInterface[],
	issued: readonly string[],
) {
	const current = new Set(interfaces.map((entry) => entry.address));
	const certificate = new Set(issued);
	return {
		viewerInterfaces: interfaces.filter((entry) =>
			certificate.has(entry.address),
		),
		viewerAddressesChanged:
			current.size !== certificate.size ||
			[...current].some((address) => !certificate.has(address)),
	};
}

export interface CertificateSetupInfo {
	url: string;
	address: string;
	expiresAt: number;
}

const PAGE = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Deskreen certificate setup</title></head>
<body><h1>Deskreen certificate setup</h1>
<p>This page uses HTTP and cannot verify the certificate for you. Do not rely on a fingerprint shown on this page.</p>
<ol><li>Download the public CA certificate below.</li>
<li>Use a trusted, independent certificate viewer or tool to calculate its SHA-256 fingerprint. Compare it with the fingerprint shown in the Deskreen app on your computer. If you cannot verify it, do not install it.</li>
<li>In Android settings, find Security, then install the downloaded file as a CA certificate. Settings names vary by device.</li>
<li>Return to your computer and scan the separate HTTPS viewer QR code.</li></ol>
<p>Installing a CA grants broad trust, not just trust for Deskreen. Never install an unverified certificate.</p>
<p><a href="/ca.cer">Download the public CA certificate</a></p></body></html>`);

type Active = {
	server: Server;
	info: CertificateSetupInfo;
	timer: NodeJS.Timeout;
};

export class CertificateSetup extends EventEmitter {
	private active: Active | null = null;
	private queue: Promise<unknown> = Promise.resolve();

	status(): CertificateSetupInfo | null {
		return this.active ? { ...this.active.info } : null;
	}

	start(
		address: string,
		ca: string,
		lifetimeMs = 300_000,
	): Promise<CertificateSetupInfo> {
		return this.serialize(async () => {
			if (address !== '127.0.0.1' && !isLocalIPv4(address))
				throw new Error('Invalid setup address');
			if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0)
				throw new Error('Invalid setup lifetime');
			const certificate = new X509Certificate(ca);
			if (!certificate.ca) throw new Error('Setup certificate is not a CA');
			const publicCertificate = certificate.raw;
			await this.closeActive();
			let host = '';
			const server = createServer((req, res) => {
				res.setHeader('Cache-Control', 'no-store');
				res.setHeader('X-Content-Type-Options', 'nosniff');
				res.setHeader(
					'Content-Security-Policy',
					"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
				);
				res.setHeader('Referrer-Policy', 'no-referrer');
				res.setHeader('Connection', 'close');
				if (req.headers.host !== host) {
					res.writeHead(400).end();
					return;
				}
				if (req.headers.origin && req.headers.origin !== `http://${host}`) {
					res.writeHead(403).end();
					return;
				}
				if (req.method !== 'GET') {
					res.writeHead(405, { Allow: 'GET' }).end();
					return;
				}
				if (req.url === '/') {
					res
						.writeHead(200, {
							'Content-Type': 'text/html; charset=utf-8',
							'Content-Length': PAGE.length,
						})
						.end(PAGE);
				} else if (req.url === '/ca.cer') {
					res
						.writeHead(200, {
							'Content-Type': 'application/octet-stream',
							'Content-Disposition': 'attachment; filename="deskreen-ca.cer"',
							'Content-Length': publicCertificate.length,
						})
						.end(publicCertificate);
				} else res.writeHead(404).end();
			});
			server.maxConnections = 32;
			server.headersTimeout = 5000;
			server.requestTimeout = 10000;
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, address, () => {
					server.removeListener('error', reject);
					resolve();
				});
			});
			const port = (server.address() as { port: number }).port;
			host = `${address}:${port}`;
			const info = {
				address,
				url: `http://${host}/`,
				expiresAt: Date.now() + lifetimeMs,
			};
			const timer = setTimeout(() => {
				void this.serialize(async () => {
					if (this.active?.server === server) await this.closeActive();
				}).catch((error) => this.emit('server-error', error));
			}, lifetimeMs);
			timer.unref();
			this.active = { server, info, timer };
			server.on('error', (error) => {
				this.emit('server-error', error);
				void this.serialize(async () => {
					if (this.active?.server === server) await this.closeActive();
				}).catch((closeError) => this.emit('server-error', closeError));
			});
			this.emit('started', { ...info });
			return { ...info };
		});
	}

	stop(): Promise<void> {
		return this.serialize(() => this.closeActive());
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async closeActive(): Promise<void> {
		const active = this.active;
		if (!active) return;
		this.active = null;
		clearTimeout(active.timer);
		try {
			await new Promise<void>((resolve, reject) => {
				active.server.close((error) => (error ? reject(error) : resolve()));
				active.server.closeAllConnections();
			});
		} finally {
			this.emit('closed');
		}
	}
}
