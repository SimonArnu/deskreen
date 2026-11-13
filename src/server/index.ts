/*
 * original JS code from darkwire.io
 * translated to typescript for Deskreen app
 * by Pavlo (Paul) Buidenkov
 * */

import http from 'http';
import https from 'https';
import { networkInterfaces } from 'node:os';
import Koa from 'koa';
import { Server, type Socket } from 'socket.io';
import cors from 'kcors';
import Router from 'koa-router';
import koaStatic from 'koa-static';
import koaSend from 'koa-send';
import detectPort from 'detect-port';
import config from '../common/config';
import startPollForInactiveRooms from './startPollForInactiveRooms';
import Logger from '../main/utils/LoggerWithFilePrefix';
import socketIOServerStore from './store/socketIOServerStore';
import DarkwireSocket from './darkwireSocket';
import getStore from './store';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';
import { getClientViewerDistPath } from './getClientViewerDistPath';
import { isAllowedOrigin, isOwnerCredential } from './origin.mjs';
import { AttemptLimit } from './AttemptLimit.mjs';
import { roomHash } from './roomHash.mjs';
import { isAllowedPeer } from './ipv6Access.mjs';

const { hostname, primaryPort, backupPort } = config;

const ioHandleOnConnection = async (socket: Socket): Promise<void> => {
	const { roomId } = socket.handshake.query;
	const store = getStore();
	if (
		typeof roomId !== 'string' ||
		!getDeskreenGlobal().roomIDService.isRoomIDTaken(roomId)
	) {
		socket.emit('NOT_ALLOWED');
		setTimeout(() => socket.disconnect(true), 0);
		return;
	}
	const roomIdHash = roomHash(roomId);
	const storedRoom = await store.get('rooms', roomIdHash);
	const parsedRoom =
		typeof storedRoom === 'string' ? JSON.parse(storedRoom) : {};
	new DarkwireSocket({
		roomIdOriginal: roomId,
		roomId: roomIdHash,
		socket,
		room: parsedRoom as Room,
	});
};

function setStaticFileHeaders(
	ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext>,
): void {
	ctx.set({
		'strict-transport-security': 'max-age=31536000',
		'X-Frame-Options': 'deny',
		'X-XSS-Protection': '1; mode=block',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
		'Feature-Policy':
			"geolocation 'none'; vr 'none'; payment 'none'; microphone 'none'",
		// 'Cache-Control': 'max-age=0', // make browser get fresh files and make new connection when client connected
	});
}

class DeskreenSignalingServer {
	log = new Logger(__filename);
	attemptLimit = new AttemptLimit(120, 60_000, 512);

	server = {} as unknown as http.Server;

	hostname: string;

	primaryPort: number;

	backupPort: number;

	port: number;

	app: Koa | undefined;

	clientDistDirectory: string;

	constructor() {
		this.hostname = String(hostname);
		this.primaryPort = parseInt(primaryPort as unknown as string, 10);
		this.backupPort = parseInt(backupPort as unknown as string, 10);

		this.port = this.primaryPort;
		this.clientDistDirectory = getClientViewerDistPath();

		if (!this.clientDistDirectory) {
			this.log.error(
				'Client viewer bundle is missing. Remote connections will fail.',
			);
		}
	}

	init(credentials: { key: string; cert: string }): void {
		this.app = new Koa();
		const router = new Router();

		this.app.use(cors());
		this.app.use(router.routes());

		const clientDistDirectory = this.clientDistDirectory;

		if (clientDistDirectory) {
			this.app.use(async (ctx, next) => {
				setStaticFileHeaders(ctx);
				await koaStatic(clientDistDirectory)(ctx, next);
			});

			this.app.use(async (ctx) => {
				setStaticFileHeaders(ctx);
				await koaSend(ctx, 'index.html', { root: clientDistDirectory });
			});
		} else {
			this.app.use(async (ctx) => {
				ctx.body = { ready: true };
			});
		}

		this.server = https.createServer(credentials, this.app.callback());
		this.server.prependListener('connection', (socket) => {
			const interfaces = Object.values(networkInterfaces()).flatMap(
				(entries) => entries ?? [],
			);
			if (
				!isAllowedPeer(
					socket.remoteAddress ?? '',
					socket.localAddress ?? '',
					interfaces,
				)
			)
				socket.destroy();
		});
		const io = new Server(this.server, {
			pingInterval: 20000,
			pingTimeout: 5000,
			serveClient: false,
			allowRequest: (request, callback) => {
				const address = request.socket.remoteAddress ?? '';
				const token = new URL(
					request.url ?? '/',
					'https://localhost',
				).searchParams.get('ownerToken');
				const owner = isOwnerCredential(
					address,
					token,
					getDeskreenGlobal().ownerToken,
				);
				callback(
					null,
					isAllowedOrigin(
						request.headers.origin,
						address,
						this.hostname,
						this.port,
						owner,
					) &&
						io.engine.clientsCount < 128 &&
						this.attemptLimit.allow(address),
				);
			},
		});

		io.on('connection', (socket) => {
			void ioHandleOnConnection(socket).catch((error) => {
				this.log.error('Failed to initialize signaling connection:', error);
				socket.disconnect(true);
			});
		});

		socketIOServerStore.setServer(io);
	}

	async start(
		port: number | undefined,
		credentials: { key: string; cert: string },
		localHostname: string,
	): Promise<http.Server> {
		startPollForInactiveRooms();
		this.hostname = localHostname;
		this.init(credentials);
		if (port !== undefined) this.port = port;
		this.server = await this.callListenOnHttpServer(port !== undefined);
		return this.server;
	}

	listenCallback() {
		return () => {
			this.log.info(
				`Deskreen CE signaling server is online at port ${this.port}`,
			);
			this.log.info(
				`🌐 Server available at https://${this.hostname}:${this.port}`,
			);
		};
	}

	async callListenOnHttpServer(isPortConfigured = false): Promise<http.Server> {
		return new Promise<http.Server>((resolve, reject) => {
			const tryListen = (port: number): void => {
				// Remove any previous error listeners
				this.server.removeAllListeners('error');

				// Set up error handler
				this.server.once('error', async (error: NodeJS.ErrnoException) => {
					if (
						!isPortConfigured &&
						error.code === 'EADDRINUSE' &&
						(port === this.primaryPort || port === this.backupPort)
					) {
						// Primary port is already in use, try backup
						this.log.error(`Port ${port} is already in use`);
						this.log.warn(
							`Port ${primaryPort} is in use. Trying backup port ${backupPort}...`,
						);

						try {
							const detectedBackupPort = await detectPort(backupPort);

							if (backupPort === detectedBackupPort) {
								this.log.info(`Backup port ${backupPort} is available.`);
								this.port = backupPort;
								tryListen(backupPort);
							} else {
								const errorMsg = `Both primary port ${primaryPort} and backup port ${backupPort} are in use`;
								this.log.error(`Error: ${errorMsg}`);
								// reject(new Error(errorMsg));
								this.port = await detectPort();
								tryListen(this.port);
							}
						} catch (err) {
							this.log.error(
								'An unexpected error occurred while detecting ports:',
								err,
							);
							reject(err);
						}
					} else {
						// Some other error or backup port is also in use
						this.log.error(`Failed to start server on port ${port}:`, error);
						reject(error);
					}
				});

				// Listen on the available IP families for local network access.
				this.server.listen(port, () => {
					this.listenCallback()();
					resolve(this.server);
				});
			};

			// Start with the primary port
			tryListen(this.port);
		});
	}

	stop(): void {
		this.server.close();
	}
}

export const signalingServer = new DeskreenSignalingServer();
