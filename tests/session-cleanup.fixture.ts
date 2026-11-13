import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import SharingSession from '../src/features/SharingSessionService/SharingSession';

process.env.RUN_MODE = 'test';
app
	.whenReady()
	.then(async () => {
		const window = new BrowserWindow({
			show: false,
			webPreferences: {
				nodeIntegration: true,
				contextIsolation: false,
				sandbox: false,
			},
		});
		await window.loadURL(`data:text/html,<script>
		const { ipcRenderer } = require('electron');
		ipcRenderer.on('stop-capture', () => ipcRenderer.send('capture-stopped'));
	</script>`);
		let stopped = false;
		window.webContents.on('ipc-message', (_, channel) => {
			if (channel === 'capture-stopped') stopped = true;
		});
		const closed = new Promise<void>((resolve) =>
			window.on('closed', () => resolve()),
		);
		const session = new SharingSession(
			'room',
			{ id: 'id', username: 'owner' },
			undefined as never,
			'owner',
		);
		session.peerConnectionHelperRenderer = window;
		session.destroy();
		await closed;
		assert.equal(
			stopped,
			true,
			'capture must stop before the helper window closes',
		);
		const unresponsive = new BrowserWindow({ show: false });
		await unresponsive.loadURL(
			'data:text/html,<title>Unresponsive helper</title>',
		);
		const fallbackClosed = new Promise<void>((resolve) =>
			unresponsive.on('closed', () => resolve()),
		);
		const fallback = new SharingSession(
			'other',
			{ id: 'id', username: 'owner' },
			undefined as never,
			'owner',
		);
		fallback.peerConnectionHelperRenderer = unresponsive;
		fallback.destroy();
		await fallbackClosed;
		assert.equal(unresponsive.isDestroyed(), true);
		console.log('Sharing sessions stop capture before closing their helper.');
		app.quit();
	})
	.catch((error) => {
		console.error(error);
		app.exit(1);
	});
