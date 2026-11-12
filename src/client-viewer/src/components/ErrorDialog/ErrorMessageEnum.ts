export const ErrorMessage = {
	UNKNOWN_ERROR: 'An unknown error occurred',
	DENY_TO_CONNECT: 'You were not allowed to connect',
	DISCONNECTED: 'You were disconnected',
	NOT_ALLOWED: 'You were not allowed to connect',
	WEBRTC_ERROR: 'WebRTC error occurred',
	TRUST_STORAGE_ERROR:
		'This browser could not save its trust credential. Ask the host to revoke it and try again.',
} as const;

export type ErrorMessageType = (typeof ErrorMessage)[keyof typeof ErrorMessage];
