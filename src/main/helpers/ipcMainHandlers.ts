import {
	Display,
	ipcMain,
	BrowserWindow,
	screen,
	clipboard,
	shell,
	app,
} from 'electron';
import i18n from '../configs/i18next.config';
import { ConnectedDevicesService } from '../../features/ConnectedDevicesService';
import SharingSession from '../../features/SharingSessionService/SharingSession';
import RoomIDService from '../../server/RoomIDService';
import { signalingServer } from '../../server';
import { onDeviceConnectedCallback } from '../../server/onDeviceConnectedCallback';
import SharingSessionStatusEnum from '../../features/SharingSessionService/SharingSessionStatusEnum';
import isWifiConnected from './isWifiConnected';
import { getDeskreenGlobal } from './getDeskreenGlobal';
import { IpcEvents } from '../../common/IpcEvents.enum';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import { store } from '../../common/deskreen-electron-store';
import DesktopCapturerSourceType from '../../common/DesktopCapturerSourceType';
import isLinuxWaylandSession from '../utils/isLinuxWaylandSession';
import { checkScreenRecordingPermission } from './checkScreenRecordingPermission';
import {
	approveViewer,
	enableViewerReconnection,
	endViewerSession,
	isApprovedSocket,
	isViewerApproved,
	revokeTrustedBrowser,
	trustedBrowserForSocket,
} from '../../server/approval';

export const initIpcMainHandlers = (mainWindow: BrowserWindow): void => {
	ipcMain.on('client-changed-language', async (_, newLangCode) => {
		i18n.changeLanguage(newLangCode);
		if (store.has(ElectronStoreKeys.AppLanguage)) {
			if (store.get(ElectronStoreKeys.AppLanguage) === newLangCode) {
				return;
			}
			store.delete(ElectronStoreKeys.AppLanguage);
		}
		store.set(ElectronStoreKeys.AppLanguage, newLangCode);
	});

	ipcMain.handle('get-signaling-server-port', () => {
		if (mainWindow === null) return;
		mainWindow.webContents.send('sending-port-from-main', signalingServer.port);
	});

	ipcMain.handle('get-all-displays', () => {
		return screen.getAllDisplays();
	});

	ipcMain.handle('get-display-size-by-display-id', (_, displayID: string) => {
		const display = screen.getAllDisplays().find((d: Display) => {
			return `${d.id}` === displayID;
		});

		if (display) {
			return display.size;
		}
		return undefined;
	});

	ipcMain.handle(IpcEvents.GetIsLinuxWaylandSession, () => {
		return isLinuxWaylandSession;
	});

	ipcMain.handle(
		IpcEvents.RequestDesktopCapturerPortalSource,
		async (_, { mode }: { mode: 'screen' | 'window' }) => {
			const types =
				mode === 'window'
					? [DesktopCapturerSourceType.WINDOW]
					: [DesktopCapturerSourceType.SCREEN];

			if (!isLinuxWaylandSession) {
				await getDeskreenGlobal().desktopCapturerSourcesService.refreshDesktopCapturerSources();
				if (mode === 'window') {
					const sources =
						getDeskreenGlobal().desktopCapturerSourcesService.getAppWindowSources();
					return sources[0]?.id ?? null;
				}
				const sources =
					getDeskreenGlobal().desktopCapturerSourcesService.getScreenSources();
				return sources[0]?.id ?? null;
			}

			const source =
				await getDeskreenGlobal().desktopCapturerSourcesService.requestPortalSource(
					types,
				);
			return source?.id ?? null;
		},
	);

	ipcMain.handle('main-window-onbeforeunload', () => {
		const deskreenGlobal = getDeskreenGlobal();
		deskreenGlobal.connectedDevicesService = new ConnectedDevicesService();
		deskreenGlobal.roomIDService = new RoomIDService();
		deskreenGlobal.sharingSessionService.sharingSessions.forEach(
			(sharingSession: SharingSession) => {
				deskreenGlobal.roomIDService.unmarkRoomIDAsTaken(sharingSession.roomID);
				endViewerSession(sharingSession.roomID);
				sharingSession.denyConnectionForPartner();
				sharingSession.destroy();
			},
		);

		deskreenGlobal.rendererWebrtcHelpersService.helpers.forEach(
			(helperWindow) => {
				helperWindow.close();
			},
		);

		deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession =
			null;
		deskreenGlobal.rendererWebrtcHelpersService.helpers.clear();
		deskreenGlobal.sharingSessionService.sharingSessions.clear();
	});

	ipcMain.handle(IpcEvents.GetConnectionInfo, () => {
		const { localHostname, certificatePath, certificateFingerprint } =
			getDeskreenGlobal();
		return { localHostname, certificatePath, certificateFingerprint };
	});

	ipcMain.handle('check-wifi-connection', async () => {
		return isWifiConnected();
	});

	ipcMain.handle(IpcEvents.GetPort, () => {
		return signalingServer.port;
	});

	ipcMain.handle(IpcEvents.GetAppPath, () => {
		const deskreenGlobal = getDeskreenGlobal();
		return deskreenGlobal.appPath;
	});

	ipcMain.handle(IpcEvents.UnmarkRoomIDAsTaken, (_, roomID) => {
		const deskreenGlobal = getDeskreenGlobal();
		deskreenGlobal.roomIDService.unmarkRoomIDAsTaken(roomID);
	});

	async function createWaitingForConnectionSharingSession(
		roomID?: string,
	): Promise<void> {
		try {
			const deskreenGlobal = getDeskreenGlobal();
			if (
				deskreenGlobal.sharingSessionService
					.waitingForConnectionSharingSession !== null
			) {
				return;
			}
			const waitingSession =
				await deskreenGlobal.sharingSessionService.createWaitingForConnectionSharingSession(
					roomID,
				);
			waitingSession.setOnDeviceConnectedCallback(onDeviceConnectedCallback);
		} catch (error) {
			console.error('Failed to create waiting sharing session', error);
		}
	}

	ipcMain.handle(
		IpcEvents.CreateWaitingForConnectionSharingSession,
		async (_, roomID?: string) => {
			await createWaitingForConnectionSharingSession(roomID);
		},
	);

	function resetWaitingForConnectionSharingSession(): void {
		const sharingSession =
			getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession;
		const roomID = sharingSession?.roomID;
		sharingSession?.denyConnectionForPartner();
		sharingSession?.disconnectByHostMachineUser();
		sharingSession?.destroy();
		sharingSession?.setStatus(SharingSessionStatusEnum.NOT_CONNECTED);
		getDeskreenGlobal().sharingSessionService.sharingSessions.delete(
			sharingSession?.id as string,
		);
		if (roomID) {
			getDeskreenGlobal().roomIDService.unmarkRoomIDAsTaken(roomID);
		}
		getDeskreenGlobal().sharingSessionService.waitingForConnectionSharingSession =
			null;
	}

	ipcMain.handle(IpcEvents.ResetWaitingForConnectionSharingSession, () => {
		resetWaitingForConnectionSharingSession();
	});

	ipcMain.handle(
		IpcEvents.ReportPendingViewerDisconnected,
		(_, details: { sharingSessionId?: unknown; socketId?: unknown }) => {
			const { connectedDevicesService, sharingSessionService } =
				getDeskreenGlobal();
			const pending = connectedDevicesService.pendingConnectionDevice;
			const waiting = sharingSessionService.waitingForConnectionSharingSession;
			if (
				!details ||
				typeof details.socketId !== 'string' ||
				typeof details.sharingSessionId !== 'string' ||
				pending.socketId !== details.socketId ||
				pending.sharingSessionID !== details.sharingSessionId ||
				waiting?.id !== details.sharingSessionId
			)
				return;
			connectedDevicesService.resetPendingConnectionDevice();
			resetWaitingForConnectionSharingSession();
			if (!mainWindow.isDestroyed())
				mainWindow.webContents.send(IpcEvents.PendingViewerDisconnected);
			void createWaitingForConnectionSharingSession();
		},
	);

	const removeViewerAvailabilityListener =
		getDeskreenGlobal().connectedDevicesService.addAvailabilityListener(
			(state) => {
				const isAvailable = state === 'available';
				const targetWindow = mainWindow?.isDestroyed() ? null : mainWindow;
				if (targetWindow) {
					targetWindow.webContents.send(
						IpcEvents.ViewerConnectionAvailabilityChanged,
						{
							isAvailable,
						},
					);
				}
				if (isAvailable) {
					void createWaitingForConnectionSharingSession();
				}
			},
		);

	mainWindow.on('closed', () => {
		removeViewerAvailabilityListener();
	});

	ipcMain.handle(
		IpcEvents.SetDeviceConnectedStatus,
		async (
			_,
			requested: {
				socketId?: unknown;
				sharingSessionId?: unknown;
				remember?: unknown;
			},
		) => {
			const { sharingSessionService, connectedDevicesService } =
				getDeskreenGlobal();
			const sharingSession =
				sharingSessionService.waitingForConnectionSharingSession;
			const pending = connectedDevicesService.pendingConnectionDevice;
			if (
				!sharingSession ||
				!requested ||
				typeof requested.socketId !== 'string' ||
				typeof requested.sharingSessionId !== 'string' ||
				pending.socketId !== requested.socketId ||
				pending.sharingSessionID !== requested.sharingSessionId ||
				sharingSession.id !== requested.sharingSessionId
			)
				return false;
			const isCurrent = () =>
				sharingSessionService.waitingForConnectionSharingSession ===
					sharingSession &&
				connectedDevicesService.pendingConnectionDevice.socketId ===
					requested.socketId &&
				connectedDevicesService.pendingConnectionDevice.sharingSessionID ===
					requested.sharingSessionId;
			if (
				!(await approveViewer(sharingSession.roomID, requested.socketId, {
					remember: requested.remember === true,
					label: `${pending.deviceBrowser} on ${pending.deviceOS}`,
					isCurrent,
				}))
			)
				return false;
			if (
				sharingSessionService.waitingForConnectionSharingSession !==
					sharingSession ||
				connectedDevicesService.pendingConnectionDevice.socketId !==
					requested.socketId ||
				!isApprovedSocket(sharingSession.roomID, requested.socketId)
			)
				return false;
			sharingSession.setStatus(SharingSessionStatusEnum.CONNECTED);
			return true;
		},
	);

	ipcMain.handle(IpcEvents.GetTrustedBrowsers, () =>
		getDeskreenGlobal().trustedBrowsers.list(),
	);
	ipcMain.handle(IpcEvents.RevokeTrustedBrowser, (_, id: unknown) => {
		if (typeof id !== 'string') return false;
		const { connectedDevicesService, sharingSessionService } =
			getDeskreenGlobal();
		const active = connectedDevicesService
			.getDevices()
			.filter(
				(device) =>
					trustedBrowserForSocket(device.socketId) === id ||
					getDeskreenGlobal().roomIDService.getReconnectingBrowser(
						device.deviceRoomId,
					) === id,
			);
		if (!revokeTrustedBrowser(id)) return false;
		for (const device of active) {
			getDeskreenGlobal().roomIDService.unmarkRoomIDAsTaken(
				device.deviceRoomId,
			);
			const session = sharingSessionService.sharingSessions.get(
				device.sharingSessionID,
			);
			session?.destroy();
			sharingSessionService.sharingSessions.delete(device.sharingSessionID);
			void connectedDevicesService.disconnectDeviceByID(device.id);
		}
		return true;
	});

	ipcMain.handle(
		IpcEvents.GetSourceDisplayIDByDesktopCapturerSourceID,
		(_, sourceId) => {
			return getDeskreenGlobal().desktopCapturerSourcesService.getSourceDisplayIDByDisplayCapturerSourceID(
				sourceId,
			);
		},
	);

	ipcMain.handle(
		IpcEvents.DisconnectPeerAndDestroySharingSessionBySessionID,
		(_, sessionId) => {
			const sharingSession =
				getDeskreenGlobal().sharingSessionService.sharingSessions.get(
					sessionId,
				);
			if (sharingSession) {
				getDeskreenGlobal().roomIDService.unmarkRoomIDAsTaken(
					sharingSession.roomID,
				);
				endViewerSession(sharingSession.roomID);
				getDeskreenGlobal().connectedDevicesService.disconnectDeviceByID(
					sharingSession.deviceID,
				);
			}
			sharingSession?.disconnectByHostMachineUser();
			sharingSession?.destroy();
			getDeskreenGlobal().sharingSessionService.sharingSessions.delete(
				sessionId,
			);
		},
	);

	ipcMain.handle(
		IpcEvents.GetDesktopCapturerSourceIdBySharingSessionId,
		(_, sessionId) => {
			return getDeskreenGlobal().sharingSessionService.sharingSessions.get(
				sessionId,
			)?.desktopCapturerSourceID;
		},
	);

	ipcMain.handle(IpcEvents.GetConnectedDevices, () => {
		return getDeskreenGlobal().connectedDevicesService.getDevices();
	});

	ipcMain.handle(IpcEvents.GetViewerConnectionAvailability, () => {
		return getDeskreenGlobal().connectedDevicesService.isSlotAvailable();
	});

	ipcMain.handle(IpcEvents.DisconnectDeviceById, (_, id) => {
		getDeskreenGlobal().connectedDevicesService.disconnectDeviceByID(id);
	});

	ipcMain.handle(IpcEvents.DisconnectAllDevices, () => {
		getDeskreenGlobal().connectedDevicesService.disconnectAllDevices();
	});

	ipcMain.handle(IpcEvents.AppLanguageChanged, (_, newLang) => {
		if (store.has(ElectronStoreKeys.AppLanguage)) {
			store.delete(ElectronStoreKeys.AppLanguage);
		}
		store.set(ElectronStoreKeys.AppLanguage, newLang);
		getDeskreenGlobal().sharingSessionService.sharingSessions.forEach(
			(sharingSession) => {
				sharingSession?.appLanguageChanged();
			},
		);
		i18n.changeLanguage(newLang);
	});

	ipcMain.handle(IpcEvents.GetDesktopCapturerServiceSourcesMap, () => {
		const map =
			getDeskreenGlobal().desktopCapturerSourcesService.getSourcesMap();
		const res = {};

		for (const key of map.keys()) {
			const source = map.get(key);
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore
			res[key] = {
				source: {
					thumbnail: source?.source.thumbnail?.toDataURL(),
					appIcon: source?.source.appIcon?.toDataURL(),
					name: source?.source.name,
				},
			};
		}
		return res;
	});

	ipcMain.handle(
		IpcEvents.GetDesktopCapturerServiceSourcesByIds,
		(_, ids: string[]) => {
			const map =
				getDeskreenGlobal().desktopCapturerSourcesService.getSourcesMap();
			const res = {};

			ids.forEach((id) => {
				const source = map.get(id);
				if (!source) return;
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-ignore
				res[id] = {
					source: {
						thumbnail: source?.source.thumbnail?.toDataURL(),
						appIcon: source?.source.appIcon?.toDataURL(),
						name: source?.source.name,
					},
				};
			});
			return res;
		},
	);

	ipcMain.handle(
		IpcEvents.GetWaitingForConnectionSharingSessionSourceId,
		() => {
			return getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession?.desktopCapturerSourceID;
		},
	);

	async function startSharingOnWaitingForConnectionSharingSession(): Promise<boolean> {
		const deskreenGlobal = getDeskreenGlobal();
		const { connectedDevicesService, sharingSessionService, roomIDService } =
			deskreenGlobal;
		if (!connectedDevicesService.isSlotAvailable()) {
			const waitingSession =
				sharingSessionService.waitingForConnectionSharingSession;
			waitingSession?.denyConnectionForPartner();
			waitingSession?.setStatus(SharingSessionStatusEnum.NOT_CONNECTED);
			sharingSessionService.waitingForConnectionSharingSession = null;
			connectedDevicesService.resetPendingConnectionDevice();
			return false;
		}

		const pendingDevice = connectedDevicesService.pendingConnectionDevice;
		if (!pendingDevice.id) {
			return false;
		}

		const sharingSession =
			sharingSessionService.waitingForConnectionSharingSession;
		if (
			!sharingSession ||
			sharingSession.id !== pendingDevice.sharingSessionID ||
			sharingSession.status !== SharingSessionStatusEnum.CONNECTED ||
			!(await isViewerApproved(sharingSession.roomID, pendingDevice.socketId))
		)
			return false;
		if (
			sharingSessionService.waitingForConnectionSharingSession !==
				sharingSession ||
			connectedDevicesService.pendingConnectionDevice.socketId !==
				pendingDevice.socketId ||
			!isApprovedSocket(sharingSession.roomID, pendingDevice.socketId)
		)
			return false;
		const browserId = trustedBrowserForSocket(pendingDevice.socketId);
		if (browserId) {
			if (
				!enableViewerReconnection(
					sharingSession.roomID,
					pendingDevice.socketId,
					browserId,
				)
			)
				return false;
			sharingSession.enableReconnection(browserId);
		} else {
			roomIDService.unmarkRoomIDAsTaken(sharingSession.roomID);
		}

		try {
			connectedDevicesService.addDevice(pendingDevice);
			sharingSession.setDeviceID(pendingDevice.id);
		} catch (error) {
			roomIDService.unmarkRoomIDAsTaken(sharingSession.roomID);
			console.error('failed to occupy single viewer slot', error);
			if (sharingSession !== null) {
				sharingSession.setStatus(SharingSessionStatusEnum.ERROR);
				sharingSession.denyConnectionForPartner();
				sharingSessionService.waitingForConnectionSharingSession = null;
			}
			connectedDevicesService.resetPendingConnectionDevice();
			return false;
		}

		if (sharingSession !== null) {
			sharingSession.callPeer();
			sharingSession.setStatus(SharingSessionStatusEnum.SHARING);
			sharingSessionService.waitingForConnectionSharingSession = null;
		}

		connectedDevicesService.resetPendingConnectionDevice();
		return true;
	}

	ipcMain.handle(
		IpcEvents.StartSharingOnWaitingForConnectionSharingSession,
		() => startSharingOnWaitingForConnectionSharingSession(),
	);

	ipcMain.handle(IpcEvents.GetPendingConnectionDevice, () => {
		return getDeskreenGlobal().connectedDevicesService.pendingConnectionDevice;
	});

	ipcMain.handle(IpcEvents.GetWaitingForConnectionSharingSessionRoomId, () => {
		if (
			getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession === null
		) {
			return undefined;
		}
		return getDeskreenGlobal().sharingSessionService
			.waitingForConnectionSharingSession?.roomID;
	});

	ipcMain.handle(
		IpcEvents.GetDesktopSharingSourceIds,
		async (_, { isEntireScreenToShareChosen }) => {
			if (isLinuxWaylandSession) {
				return [];
			}
			// ensure sources are up to date at request time
			await getDeskreenGlobal().desktopCapturerSourcesService.refreshDesktopCapturerSources();

			if (isEntireScreenToShareChosen === true) {
				return getDeskreenGlobal()
					.desktopCapturerSourcesService.getScreenSources()
					.map((source) => source.id);
			}
			return getDeskreenGlobal()
				.desktopCapturerSourcesService.getAppWindowSources()
				.map((source) => source.id);
		},
	);

	ipcMain.handle(IpcEvents.SetDesktopCapturerSourceId, (_, id) => {
		getDeskreenGlobal().sharingSessionService.waitingForConnectionSharingSession?.setDesktopCapturerSourceID(
			id,
		);
	});

	ipcMain.handle(IpcEvents.GetIsFirstTimeAppStart, () => {
		if (store.has(ElectronStoreKeys.IsNotFirstTimeAppStart)) {
			return false;
		}
		return true;
	});

	ipcMain.handle(IpcEvents.SetAppStartedOnce, () => {
		if (store.has(ElectronStoreKeys.IsNotFirstTimeAppStart)) {
			store.delete(ElectronStoreKeys.IsNotFirstTimeAppStart);
		}
		store.set(ElectronStoreKeys.IsNotFirstTimeAppStart, 'true');
	});

	ipcMain.handle(IpcEvents.GetAppLanguage, () => {
		if (store.has(ElectronStoreKeys.AppLanguage)) {
			return store.get(ElectronStoreKeys.AppLanguage);
		}
		return 'en';
	});

	ipcMain.handle(IpcEvents.DestroySharingSessionById, (_, id) => {
		if (
			getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession?.id === id
		) {
			getDeskreenGlobal().sharingSessionService.waitingForConnectionSharingSession =
				null;
		}
		const sharingSession =
			getDeskreenGlobal().sharingSessionService.sharingSessions.get(id);
		if (sharingSession) {
			getDeskreenGlobal().roomIDService.unmarkRoomIDAsTaken(
				sharingSession.roomID,
			);
			endViewerSession(sharingSession.roomID);
		}
		if (sharingSession?.deviceID) {
			getDeskreenGlobal().connectedDevicesService.disconnectDeviceByID(
				sharingSession.deviceID,
			);
		}
		sharingSession?.setStatus(SharingSessionStatusEnum.DESTROYED);
		sharingSession?.destroy();
		getDeskreenGlobal().sharingSessionService.sharingSessions.delete(id);
	});

	ipcMain.handle(IpcEvents.OpenExternalLink, (_, url: string) => {
		if (typeof url !== 'string') {
			return;
		}
		shell.openExternal(url);
	});

	ipcMain.handle(IpcEvents.WriteTextToClipboard, (_, text) => {
		clipboard.writeText(text);
	});

	ipcMain.handle(IpcEvents.CheckScreenRecordingPermission, () => {
		return checkScreenRecordingPermission();
	});

	ipcMain.handle(IpcEvents.RelaunchApp, () => {
		app.relaunch();
		app.exit(0);
	});

	void createWaitingForConnectionSharingSession();
};
