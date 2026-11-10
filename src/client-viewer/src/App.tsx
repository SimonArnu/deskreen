import React, { useEffect, useState } from 'react';
import SimplePeer from 'simple-peer';
import { useTranslation } from 'react-i18next';
import MainView from './containers/MainView';
import LoadingScreen from './components/LoadingScreen';

const App: React.FC = () => {
	const { t } = useTranslation();
	// Helper function to check for prerendering safely
	const isCurrentlyPrerendering = () => {
		// Check if 'document' and 'prerendering' property exist
		return typeof document !== 'undefined' &&
			typeof document.prerendering === 'boolean'
			? document.prerendering
			: false; // Default to false if the property doesn't exist
	};

	const [isTrulyVisible, setIsTrulyVisible] = useState(
		!isCurrentlyPrerendering(),
	);

	useEffect(() => {
		// Only set up listeners if document.prerendering is supported
		if (
			typeof document !== 'undefined' &&
			typeof document.prerendering === 'boolean'
		) {
			const handlePrerenderChange = () => {
				// When the prerendering state changes, update isTrulyVisible
				// It becomes true when document.prerendering is false (i.e., page is activated)
				setIsTrulyVisible(!document.prerendering);
			};

			// If it was initially prerendering, listen for the change to activate.
			// The { once: true } option is useful if you only care about the first activation.
			// However, if a page could theoretically go back into a prerender state (less common for user navigation),
			// you might remove { once: true } but then also need more complex logic.
			// For the typical "prerender then activate" flow, { once: true } is fine.
			if (document.prerendering) {
				document.addEventListener('prerenderingchange', handlePrerenderChange, {
					once: true,
				});
			}

			return () => {
				// Cleanup the event listener
				document.removeEventListener(
					'prerenderingchange',
					handlePrerenderChange,
				);
			};
		}
		// If document.prerendering is not supported, isTrulyVisible is already true
		// (due to the initial useState value and isCurrentlyPrerendering fallback),
		// so no specific effect logic is needed for that case here.
	}, []); // Empty dependency array means this effect runs once on mount and cleans up on unmount.

	if (!isTrulyVisible) {
		// Render a minimal version or nothing while the browser is prerendering.
		// This prevents heavy computations or API calls during the browser's prerender phase.
		// console.log("Page is being prerendered by the browser (or support for detection is present). Waiting for activation.");
		return <LoadingScreen />;
	}

	if (!SimplePeer.WEBRTC_SUPPORT) {
		return (
			<div role="alert" style={{ padding: '2rem' }}>
				<h2>{t('WebRTC is unavailable in this browser.')}</h2>
				<p>
					{t(
						'Check your browser settings and extensions, or try another browser.',
					)}
				</p>
			</div>
		);
	}

	return <MainView />;
};

export default App;
