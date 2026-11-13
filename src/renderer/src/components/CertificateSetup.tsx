import React, { useEffect, useState } from 'react';
import {
	Button,
	Callout,
	Dialog,
	DialogBody,
	DialogFooter,
} from '@blueprintjs/core';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';
import { IpcEvents } from '../../../common/IpcEvents.enum';
import type {
	CertificateSetupInfo,
	SetupInterface,
} from '../../../server/certificateSetup.mjs';

export default function CertificateSetup({
	fingerprint,
}: {
	fingerprint: string;
}): React.ReactElement {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [interfaces, setInterfaces] = useState<SetupInterface[]>([]);
	const [address, setAddress] = useState('');
	const [setup, setSetup] = useState<CertificateSetupInfo | null>(null);
	const [error, setError] = useState('');

	useEffect(() => {
		const changed = (_: unknown, info: CertificateSetupInfo | null) =>
			setSetup(info);
		window.electron.ipcRenderer.on(IpcEvents.CertificateSetupChanged, changed);
		return () => {
			window.electron.ipcRenderer.removeListener(
				IpcEvents.CertificateSetupChanged,
				changed,
			);
			void window.electron.ipcRenderer
				.invoke(IpcEvents.StopCertificateSetup)
				.catch((reason) =>
					console.error('Failed to stop certificate setup:', reason),
				);
		};
	}, []);

	const show = async () => {
		setOpen(true);
		setError('');
		setBusy(true);
		try {
			const [available, status] = await Promise.all([
				window.electron.ipcRenderer.invoke(
					IpcEvents.GetCertificateSetupInterfaces,
				),
				window.electron.ipcRenderer.invoke(IpcEvents.GetCertificateSetupStatus),
			]);
			setInterfaces(available);
			setSetup(status);
		} catch {
			setError(t('Could not find network interfaces for certificate setup.'));
		} finally {
			setBusy(false);
		}
	};

	const start = async () => {
		setBusy(true);
		setError('');
		try {
			const info = await window.electron.ipcRenderer.invoke(
				IpcEvents.StartCertificateSetup,
				address,
			);
			if (!info) setError(t('That network address is no longer available.'));
			else setSetup(info);
		} catch {
			setError(t('Could not start certificate setup.'));
		} finally {
			setBusy(false);
		}
	};

	const stop = async () => {
		setBusy(true);
		setError('');
		try {
			await window.electron.ipcRenderer.invoke(IpcEvents.StopCertificateSetup);
			setSetup(null);
			return true;
		} catch {
			setError(t('Could not stop certificate setup.'));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const close = async () => {
		if (busy) return;
		if (await stop()) setOpen(false);
	};

	return (
		<>
			<Button id="certificate-setup-open" small onClick={() => void show()}>
				{t('Download certificate on a device')}
			</Button>
			<Dialog
				title={t('First-time certificate setup')}
				isOpen={open}
				onClose={() => void close()}
				canEscapeKeyClose={!busy}
				canOutsideClickClose={!busy}
			>
				<div id="certificate-setup-dialog">
					<DialogBody useOverflowScrollContainer>
						<p>
							{t(
								'The temporary setup page uses HTTP. It cannot authenticate the certificate or safely verify it for you.',
							)}
						</p>
						<p>
							{t(
								'Choose the network used by your viewing device. The download stays available for five minutes, or until you close this dialog.',
							)}
						</p>
						<label htmlFor="certificate-setup-interface">
							{t('Network address')}
						</label>{' '}
						<select
							id="certificate-setup-interface"
							value={address}
							disabled={busy || Boolean(setup)}
							onChange={(event) => setAddress(event.currentTarget.value)}
						>
							<option value="">{t('Choose an interface')}</option>
							{interfaces.map((entry) => (
								<option
									key={`${entry.name}:${entry.address}`}
									value={entry.address}
								>
									{entry.name} — {entry.address}
								</option>
							))}
						</select>
						{interfaces.length === 0 && !busy && (
							<p>
								{t(
									'No private IPv4 network interface is available. Transfer the certificate through a trusted channel instead.',
								)}
							</p>
						)}
						{!setup && (
							<p>
								<Button
									id="certificate-setup-start"
									intent="primary"
									disabled={busy || !address}
									onClick={() => void start()}
								>
									{t('Start temporary download')}
								</Button>
							</p>
						)}
						{setup && (
							<div>
								<p>
									{t(
										'Scan this setup QR code to download the public certificate:',
									)}
								</p>
								<QRCodeSVG
									value={setup.url}
									size={180}
									title={t('Certificate setup QR code')}
								/>
								<p>
									<code>{setup.url}</code>
								</p>
								<p>
									{t('Setup expires at')}:{' '}
									{new Date(setup.expiresAt).toLocaleTimeString()}
								</p>
								<Button
									id="certificate-setup-stop"
									intent="danger"
									disabled={busy}
									onClick={() => void stop()}
								>
									{t('Stop temporary download')}
								</Button>
							</div>
						)}
						{error && <Callout intent="danger">{error}</Callout>}
						<p>
							{t(
								'On the viewing device, calculate the downloaded certificate’s SHA-256 fingerprint using a trusted, independent certificate viewer or tool. Compare it with this value from the desktop app:',
							)}
						</p>
						<p>
							<code style={{ overflowWrap: 'anywhere' }}>{fingerprint}</code>
						</p>
						<p>
							{t(
								'For example, in Termux with OpenSSL installed, grant storage access and run:',
							)}
						</p>
						<pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
							{
								'termux-setup-storage\nopenssl x509 -inform DER -in ~/storage/downloads/deskreen-ca.cer -noout -sha256 -fingerprint'
							}
						</pre>
						<p>
							{t('Adjust the filename if your browser saved another copy.')}
						</p>
						<p>
							{t(
								'If you cannot verify the fingerprint, do not install the certificate. Trusting a CA can affect other websites too. Never share the private key.',
							)}
						</p>
						<p>
							{t(
								'On Android, search Settings for “Install a certificate”, choose CA certificate, and select the verified file. Then return here and scan the separate HTTPS viewer QR code.',
							)}
						</p>
					</DialogBody>
				</div>
				<DialogFooter
					actions={
						<Button
							id="certificate-setup-close"
							disabled={busy}
							onClick={() => void close()}
						>
							{t('Close')}
						</Button>
					}
				/>
			</Dialog>
		</>
	);
}
