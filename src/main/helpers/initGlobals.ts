import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ConnectedDevicesService } from '../../features/ConnectedDevicesService';
import SharingSessionService from '../../features/SharingSessionService';
import RendererWebrtcHelpersService from '../../features/PeerConnectionHelperRendererService';
import RoomIDService from '../../server/RoomIDService';
import DesktopCapturerSources from '../../features/DesktopCapturerSourcesService';
import DesktopCapturerSourcesService from '../../features/DesktopCapturerSourcesService';
import { TrustedBrowsers } from '../../server/trustedBrowsers.mjs';

export interface DeskreenGlobal {
	appPath: string;
	rendererWebrtcHelpersService: RendererWebrtcHelpersService;
	roomIDService: RoomIDService;
	connectedDevicesService: ConnectedDevicesService;
	sharingSessionService: SharingSessionService;
	desktopCapturerSourcesService: DesktopCapturerSourcesService;
	localHostname: string;
	certificatePath: string;
	certificateFingerprint: string;
	ownerToken: string;
	trustedBrowsers: TrustedBrowsers;
}

export const initGlobals = (
	appPath: string,
	localHostname: string,
	certificatePath: string,
	certificateFingerprint: string,
) => {
	const deskreenGlobal: DeskreenGlobal = global as unknown as DeskreenGlobal;

	deskreenGlobal.appPath = appPath;
	deskreenGlobal.rendererWebrtcHelpersService =
		new RendererWebrtcHelpersService(appPath);
	deskreenGlobal.roomIDService = new RoomIDService();
	deskreenGlobal.connectedDevicesService = new ConnectedDevicesService();
	deskreenGlobal.ownerToken = randomBytes(32).toString('base64url');
	deskreenGlobal.trustedBrowsers = new TrustedBrowsers(
		join(dirname(certificatePath), '..', 'trusted-browsers.json'),
	);
	deskreenGlobal.sharingSessionService = new SharingSessionService(
		deskreenGlobal.roomIDService,
		deskreenGlobal.connectedDevicesService,
		deskreenGlobal.rendererWebrtcHelpersService,
		deskreenGlobal.ownerToken,
	);
	deskreenGlobal.desktopCapturerSourcesService = new DesktopCapturerSources();
	deskreenGlobal.localHostname = localHostname;
	deskreenGlobal.certificatePath = certificatePath;
	deskreenGlobal.certificateFingerprint = certificateFingerprint;
};
