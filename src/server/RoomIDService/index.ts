import { createRoomId } from './createRoomId.mjs';
import { roomHash } from '../roomHash.mjs';

export default class RoomIDService {
	takenRoomIDs: Set<string>;
	private reconnectingBrowsers = new Map<string, string>();

	constructor() {
		this.takenRoomIDs = new Set<string>();
		// TODO: load saved taken room ids from local storage, will be useful for saved devices feature in FUTURE
	}

	async getAvailableRoomID(): Promise<string> {
		let id = createRoomId();
		while (this.takenRoomIDs.has(id)) id = createRoomId();
		return id;
	}

	markRoomIDAsTaken(id: string): void {
		this.takenRoomIDs.add(id);
	}

	unmarkRoomIDAsTaken(id: string): void {
		this.takenRoomIDs.delete(id);
		this.reconnectingBrowsers.delete(id);
	}

	allowReconnection(id: string, browserId: string): void {
		if (!this.takenRoomIDs.has(id)) throw new Error('Room is not active');
		this.reconnectingBrowsers.set(id, browserId);
	}

	getReconnectingBrowser(id: string): string | undefined {
		return this.reconnectingBrowsers.get(id);
	}

	isReconnectionRoomHash(id: string): boolean {
		return [...this.reconnectingBrowsers.keys()].some(
			(room) => roomHash(room) === id,
		);
	}

	isRoomIDTaken(id: string): boolean {
		return this.takenRoomIDs.has(id);
	}
}
