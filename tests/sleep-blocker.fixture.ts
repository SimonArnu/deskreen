import assert from 'node:assert/strict';
import { app, powerSaveBlocker } from 'electron';
import SharingSession from '../src/features/SharingSessionService/SharingSession';
import SharingSessionStatusEnum from '../src/features/SharingSessionService/SharingSessionStatusEnum';

process.env.RUN_MODE = 'test';

app
	.whenReady()
	.then(() => {
		const create = () =>
			new SharingSession(
				'room',
				{ id: 'id', username: 'name' },
				undefined as never,
				'owner-token',
			);
		const first = create();
		const second = create();

		assert.equal(first.sleepBlockerId, null);
		first.setStatus(SharingSessionStatusEnum.CONNECTED);
		assert.equal(first.sleepBlockerId, null);
		first.setStatus(SharingSessionStatusEnum.SHARING);
		const firstId = first.sleepBlockerId;
		assert.notEqual(firstId, null);
		assert.equal(powerSaveBlocker.isStarted(firstId!), true);
		first.setStatus(SharingSessionStatusEnum.SHARING);
		assert.equal(first.sleepBlockerId, firstId);

		second.setStatus(SharingSessionStatusEnum.SHARING);
		const secondId = second.sleepBlockerId;
		assert.notEqual(secondId, null);
		assert.notEqual(secondId, firstId);
		first.setStatus(SharingSessionStatusEnum.ERROR);
		assert.equal(first.sleepBlockerId, null);
		assert.equal(powerSaveBlocker.isStarted(firstId!), false);
		assert.equal(powerSaveBlocker.isStarted(secondId!), true);
		second.destroy();
		assert.equal(second.sleepBlockerId, null);
		assert.equal(powerSaveBlocker.isStarted(secondId!), false);
		second.destroy();
		console.log('Sharing sleep blockers follow session status and cleanup.');
		app.quit();
	})
	.catch((error) => {
		console.error(error);
		app.exit(1);
	});
