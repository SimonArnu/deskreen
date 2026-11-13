import { Device } from '../../common/Device';

export const nullDevice: Device = {
	id: '',
	socketId: '',
	sharingSessionID: '',
	deviceOS: '',
	deviceType: '',
	deviceIP: '',
	deviceBrowser: '',
	deviceScreenWidth: -1,
	deviceScreenHeight: -1,
	deviceRoomId: '',
};

const SLOT_VIOLATION_MESSAGE = 'single viewer slot is already occupied';

type ViewerConnectionAvailability = 'available' | 'occupied';

class SingleViewerSlot {
	private device: Readonly<Device> | null = null;

	occupy(device: Device): void {
		if (this.device && this.device.id !== device.id) {
			throw new Error(SLOT_VIOLATION_MESSAGE);
		}
		this.device = Object.freeze({ ...device });
	}

	releaseById(deviceIDToRemove: string): boolean {
		if (!this.device) return false;
		if (this.device.id !== deviceIDToRemove) {
			return false;
		}
		this.device = null;
		return true;
	}

	release(): void {
		this.device = null;
	}

	isAvailable(): boolean {
		return this.device === null;
	}

	snapshot(): Device[] {
		if (!this.device) return [];
		return [{ ...this.device }];
	}

	isOccupiedBy(deviceID: string): boolean {
		if (!this.device) return false;
		return this.device.id === deviceID;
	}

	replace(deviceID: string, replacement: Device): boolean {
		if (!this.device || this.device.id !== deviceID) return false;
		this.device = Object.freeze({ ...replacement });
		return true;
	}
}

export class ConnectedDevicesService {
	private readonly slot = new SingleViewerSlot();

	pendingConnectionDevice: Device = nullDevice;

	private readonly availabilityListeners = new Set<
		(state: ViewerConnectionAvailability) => void
	>();

	resetPendingConnectionDevice(): void {
		this.pendingConnectionDevice = nullDevice;
	}

	getDevices(): Device[] {
		return this.slot.snapshot();
	}

	isSlotAvailable(): boolean {
		return this.slot.isAvailable();
	}

	addAvailabilityListener(
		listener: (state: ViewerConnectionAvailability) => void,
	): () => void {
		this.availabilityListeners.add(listener);
		listener(this.getAvailabilityState());
		return () => {
			this.availabilityListeners.delete(listener);
		};
	}

	disconnectAllDevices(): void {
		this.slot.release();
		this.notifyAvailabilityListeners();
	}

	disconnectDeviceByID(deviceIDToRemove: string): Promise<undefined> {
		return new Promise<undefined>((resolve) => {
			this.slot.releaseById(deviceIDToRemove);
			this.notifyAvailabilityListeners();
			resolve(undefined);
		});
	}

	addDevice(device: Device): void {
		try {
			this.slot.occupy(device);
		} catch (error) {
			if (error instanceof Error && error.message === SLOT_VIOLATION_MESSAGE) {
				throw error;
			}
			throw error;
		}
		this.notifyAvailabilityListeners();
	}

	markReconnecting(socketId: string): void {
		const device = this.slot
			.snapshot()
			.find((item) => item.socketId === socketId);
		if (device)
			this.slot.replace(device.id, { ...device, isReconnecting: true });
	}

	replaceDevice(currentId: string, device: Device): boolean {
		return this.slot.replace(currentId, { ...device, isReconnecting: false });
	}

	setPendingConnectionDevice(device: Device): void {
		this.pendingConnectionDevice = device;
	}

	private getAvailabilityState(): ViewerConnectionAvailability {
		return this.slot.isAvailable() ? 'available' : 'occupied';
	}

	private notifyAvailabilityListeners(): void {
		const state = this.getAvailabilityState();
		this.availabilityListeners.forEach((listener) => {
			try {
				listener(state);
			} catch (error) {
				console.error('connected devices availability listener failed', error);
			}
		});
	}
}
