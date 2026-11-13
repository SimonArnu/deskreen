import { IpcEvents } from '../common/IpcEvents.enum';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';
import { deskreenApp } from '../main';
import { Device } from '../common/Device';
import SharingSessionStatusEnum from '../features/SharingSessionService/SharingSessionStatusEnum';
import {
	approveTrustedViewer,
	hasTrustedCredential,
	isApprovedSocket,
	trustedBrowserForSocket,
} from './approval';

export async function onDeviceConnectedCallback(device: Device): Promise<void> {
	const deskreenGlobal = getDeskreenGlobal();
	const { connectedDevicesService, sharingSessionService } = deskreenGlobal;
	if (!connectedDevicesService.isSlotAvailable()) {
		const active = connectedDevicesService
			.getDevices()
			.find((item) => item.sharingSessionID === device.sharingSessionID);
		const session = sharingSessionService.sharingSessions.get(
			device.sharingSessionID,
		);
		if (
			active &&
			session?.trustedBrowserId &&
			session.trustedBrowserId === trustedBrowserForSocket(device.socketId) &&
			deskreenGlobal.roomIDService.getReconnectingBrowser(session.roomID) ===
				session.trustedBrowserId &&
			isApprovedSocket(session.roomID, device.socketId) &&
			connectedDevicesService.replaceDevice(active.id, device)
		) {
			session.setDeviceID(device.id);
			session.resumeViewer();
			return;
		}
		const waitingSession =
			sharingSessionService.waitingForConnectionSharingSession;
		waitingSession?.denyConnectionForPartner();
		waitingSession?.setStatus(SharingSessionStatusEnum.NOT_CONNECTED);
		sharingSessionService.waitingForConnectionSharingSession = null;
		connectedDevicesService.resetPendingConnectionDevice();
		return;
	}
	connectedDevicesService.setPendingConnectionDevice(device);
	const waiting = sharingSessionService.waitingForConnectionSharingSession;
	const isCurrent = () =>
		waiting?.id === device.sharingSessionID &&
		sharingSessionService.waitingForConnectionSharingSession === waiting &&
		connectedDevicesService.pendingConnectionDevice.socketId ===
			device.socketId;
	let isTrusted = false;
	if (waiting && isCurrent() && hasTrustedCredential(device.socketId)) {
		try {
			isTrusted = await approveTrustedViewer(
				waiting.roomID,
				device.socketId,
				isCurrent,
			);
		} catch (error) {
			console.error('Failed to approve trusted browser:', error);
		}
		if (!isCurrent()) return;
		if (isTrusted && !hasTrustedCredential(device.socketId)) return;
		if (isTrusted) waiting.setStatus(SharingSessionStatusEnum.CONNECTED);
	}
	if (!isCurrent()) return;
	deskreenApp.mainWindow?.webContents.send(
		IpcEvents.SetPendingConnectionDevice,
		{ ...device, isTrusted },
	);
}
