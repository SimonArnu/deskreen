import { X509Certificate } from 'node:crypto';

export function verifyLocalCertificate(
	hostname: string,
	presented: string,
	expected: string,
): number {
	if (hostname !== '127.0.0.1') return -3;
	try {
		const actual = new X509Certificate(presented);
		const known = new X509Certificate(expected);
		const now = Date.now();
		if (
			actual.raw.equals(known.raw) &&
			actual.checkIP('127.0.0.1') &&
			Date.parse(actual.validFrom) <= now &&
			Date.parse(actual.validTo) > now
		) {
			return 0;
		}
	} catch {
		return -2;
	}
	return -2;
}
