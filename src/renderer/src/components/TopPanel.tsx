import React from 'react';
import { Button, H3, Icon, Position, Tooltip } from '@blueprintjs/core';
import { createStyles, makeStyles } from '@material-ui/core/styles';
import { Col, Row } from 'react-flexbox-grid';
import SettingsOverlay from './SettingsOverlay/SettingsOverlay';
import ConnectedDevicesListDrawer from './ConnectedDevicesListDrawer';
import { useTranslation } from 'react-i18next';
import { IpcEvents } from '../../../common/IpcEvents.enum';

const useStyles = makeStyles(() =>
	createStyles({
		topPanelRoot: {
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			paddingTop: '15px',
			marginBottom: '20px',
			position: 'relative',
			gap: '12px',
		},
		logoWithAppName: { margin: '0 auto' },
		appNameHeader: {
			margin: '0 auto',
			paddingTop: '5px',
			fontFamily: 'Lexend Peta',
			fontSize: '20px',
			color: '#e2791b',
			cursor: 'default !important',
		},
		topPanelControlButtonsRoot: {
			display: 'flex',
			alignItems: 'center',
			gap: '12px',
		},
		topPanelControlsWrapper: {
			position: 'absolute',
			right: '15px',
			top: '15px',
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'flex-end',
			gap: '6px',
		},
		topPanelControlButton: {
			width: '40px',
			height: '40px',
			borderRadius: '50px',
			cursor: 'default !important',
		},
		topPanelControlButtonMargin: {
			cursor: 'default !important',
			position: 'relative',
		},
		topPanelIconOfControlButton: {
			cursor: 'default !important',
		},
		connectedDevicesBadge: {
			position: 'absolute',
			top: '-4px',
			right: '-4px',
			backgroundColor: '#ff3b30',
			color: '#ffffff',
			borderRadius: '10px',
			minWidth: '20px',
			height: '20px',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			fontSize: '12px',
			fontWeight: 600,
			padding: '0 6px',
			boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
			zIndex: 10,
			lineHeight: '1',
		},
	}),
);

interface Props {
	handleReset: () => void;
}

export default function TopPanel({ handleReset }: Props): React.ReactElement {
	const { t } = useTranslation();
	const classes = useStyles();

	const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
	const [isConnectedDevicesDrawerOpen, setIsConnectedDevicesDrawerOpen] =
		React.useState(false);
	const [connectedDevicesCount, setConnectedDevicesCount] = React.useState(0);
	const [isReconnecting, setIsReconnecting] = React.useState(false);

	const handleSettingsOpen = React.useCallback(() => {
		setIsSettingsOpen(true);
	}, []);

	const handleSettingsClose = React.useCallback(() => {
		setIsSettingsOpen(false);
	}, []);

	const handleToggleConnectedDevicesListDrawer = React.useCallback(() => {
		setIsConnectedDevicesDrawerOpen(!isConnectedDevicesDrawerOpen);
	}, [isConnectedDevicesDrawerOpen]);

	React.useEffect(() => {
		const fetchConnectedDevicesCount = async (): Promise<void> => {
			try {
				const devices = await window.electron.ipcRenderer.invoke(
					IpcEvents.GetConnectedDevices,
				);
				if (Array.isArray(devices)) {
					setConnectedDevicesCount(devices.length);
					setIsReconnecting(devices.some((device) => device.isReconnecting));
				}
			} catch (e) {
				console.error(e);
			}
		};

		fetchConnectedDevicesCount();

		const connectedDevicesInterval = setInterval(
			fetchConnectedDevicesCount,
			2000,
		);

		return () => {
			clearInterval(connectedDevicesInterval);
		};
	}, []);

	const renderConnectedDevicesListButton = (
		<div className={classes.topPanelControlButtonMargin}>
			<Tooltip content={t('connected-devices')} position={Position.BOTTOM}>
				<Button
					id="top-panel-connected-devices-list-button"
					intent="primary"
					className={classes.topPanelControlButton}
					onClick={handleToggleConnectedDevicesListDrawer}
				>
					<Icon
						className={classes.topPanelIconOfControlButton}
						icon="th-list"
						size={20}
					/>
				</Button>
			</Tooltip>
			{connectedDevicesCount > 0 && (
				<span className={classes.connectedDevicesBadge}>
					{connectedDevicesCount}
				</span>
			)}
		</div>
	);

	const renderHelpButton = (
		<div className={classes.topPanelControlButtonMargin}>
			<Tooltip content={t('fix-reset-tooltip')} position={Position.BOTTOM}>
				<Button
					id="top-panel-help-button"
					intent="danger"
					className={classes.topPanelControlButton}
					onClick={() => {
						Promise.resolve(handleReset()).then(() => {
							window.electron.ipcRenderer.invoke(
								IpcEvents.CreateWaitingForConnectionSharingSession,
							);
						});
					}}
				>
					<Icon
						className={classes.topPanelIconOfControlButton}
						icon="lifesaver"
						size={22}
					/>
				</Button>
			</Tooltip>
		</div>
	);

	const renderSettingsButton = (
		<div className={classes.topPanelControlButtonMargin}>
			<Tooltip content={t('settings')} position={Position.BOTTOM}>
				<Button
					id="top-panel-settings-button"
					onClick={handleSettingsOpen}
					className={classes.topPanelControlButton}
				>
					<Icon
						className={classes.topPanelIconOfControlButton}
						icon="cog"
						size={22}
					/>
				</Button>
			</Tooltip>
		</div>
	);

	const renderLogoWithAppName = (
		<div
			id="logo-with-popover-visit-website"
			className={classes.logoWithAppName}
		>
			<H3>Deskreen Community Edition</H3>
		</div>
	);

	return (
		<>
			<div className={classes.topPanelRoot}>
				<Row middle="xs" center="xs" style={{ width: '100%' }}>
					<Col>{renderLogoWithAppName}</Col>
				</Row>
				<div className={classes.topPanelControlsWrapper}>
					<div className={classes.topPanelControlButtonsRoot}>
						{renderConnectedDevicesListButton}
						{renderHelpButton}
						{renderSettingsButton}
					</div>
				</div>
			</div>
			{isReconnecting && (
				<div role="status">
					{t('Viewer disconnected. Capture remains active while reconnecting.')}
				</div>
			)}
			{isSettingsOpen ? (
				<SettingsOverlay
					isSettingsOpen={isSettingsOpen}
					handleClose={handleSettingsClose}
				/>
			) : (
				<></>
			)}
			{isConnectedDevicesDrawerOpen ? (
				<ConnectedDevicesListDrawer
					isOpen={isConnectedDevicesDrawerOpen}
					handleToggle={handleToggleConnectedDevicesListDrawer}
					handleReset={handleReset}
				/>
			) : (
				<></>
			)}
		</>
	);
}
