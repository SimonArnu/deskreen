import { createRoomId } from './createRoomId.mjs';

export default class RoomIDService {
	takenRoomIDs: Set<string>;

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
	}

	isRoomIDTaken(id: string): boolean {
		return this.takenRoomIDs.has(id);
	}
}
