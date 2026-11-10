export function canAcceptDeviceDetails(
	partnerSocketId: string,
	recordedSocketId: string,
	recordedDeviceId: string,
	sourceSocketId: string,
): boolean {
	return Boolean(
		sourceSocketId &&
			partnerSocketId === sourceSocketId &&
			(recordedSocketId !== sourceSocketId || !recordedDeviceId),
	);
}
