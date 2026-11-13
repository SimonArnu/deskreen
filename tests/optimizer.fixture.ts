import assert from 'node:assert/strict';
import { app } from 'electron';
import VideoAutoQualityOptimizer from '../src/client-viewer/src/features/VideoAutoQualityOptimizer';

app
	.whenReady()
	.then(() => {
		const optimizer = new VideoAutoQualityOptimizer();
		optimizer.startOptimizationLoop();
		const timer = optimizer.optimizationInterval;
		assert.ok(timer);
		optimizer.startOptimizationLoop();
		assert.equal(optimizer.optimizationInterval, timer);
		optimizer.stopOptimizationLoop();
		assert.equal(optimizer.optimizationInterval, null);
		console.log('Video quality monitoring has one timer and stops cleanly.');
		app.quit();
	})
	.catch((error) => {
		console.error(error);
		app.exit(1);
	});
