export function isEndOfCandidates(signal: unknown): boolean {
	if (!signal || typeof signal !== 'object' || !('candidate' in signal))
		return false;
	const candidate = signal.candidate;
	return Boolean(
		candidate &&
			typeof candidate === 'object' &&
			'candidate' in candidate &&
			candidate.candidate === '',
	);
}
