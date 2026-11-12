import { Button, Dialog, DialogBody, DialogFooter } from '@blueprintjs/core';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IpcEvents } from '../../../common/IpcEvents.enum';
import { showMessageFromNewToaster } from '../utils/showMessageFromNewToaster';

interface Browser {
	id: string;
	label: string;
}

export default function TrustedBrowsers(): React.ReactElement {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [browsers, setBrowsers] = useState<Browser[]>([]);
	const refresh = async () => {
		setBrowsers(
			await window.electron.ipcRenderer.invoke(IpcEvents.GetTrustedBrowsers),
		);
	};
	const show = async () => {
		try {
			await refresh();
			setOpen(true);
		} catch {
			void showMessageFromNewToaster(t('Could not list trusted browsers.'));
		}
	};
	const revoke = async (id: string) => {
		try {
			await window.electron.ipcRenderer.invoke(
				IpcEvents.RevokeTrustedBrowser,
				id,
			);
			await refresh();
		} catch {
			void showMessageFromNewToaster(t('Could not revoke browser trust.'));
		}
	};
	return (
		<>
			<Button minimal onClick={() => void show()}>
				{t('Trusted browsers')}
			</Button>
			<Dialog
				title={t('Trusted browsers')}
				isOpen={open}
				onClose={() => setOpen(false)}
			>
				<DialogBody>
					<p>
						{t('Revoking trust disconnects that browser if it is connected.')}
					</p>
					{browsers.length === 0 && <p>{t('No trusted browsers')}</p>}
					{browsers.map((browser) => (
						<div key={browser.id}>
							<span>{browser.label}</span>{' '}
							<Button
								small
								intent="danger"
								onClick={() => void revoke(browser.id)}
							>
								{t('Revoke')}
							</Button>
						</div>
					))}
				</DialogBody>
				<DialogFooter
					actions={<Button onClick={() => setOpen(false)}>{t('Close')}</Button>}
				/>
			</Dialog>
		</>
	);
}
