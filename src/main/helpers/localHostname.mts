import { execFileSync } from 'node:child_process';

export function parseLocalHostname(response: string): string {
	const match = /^\('([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local)',\)$/i.exec(
		response.trim(),
	);
	if (!match) throw new Error('Avahi did not return a valid local hostname');
	return match[1].toLowerCase();
}

export function getLocalHostname(): string {
	try {
		const response = execFileSync(
			'gdbus',
			[
				'call',
				'--system',
				'--dest',
				'org.freedesktop.Avahi',
				'--object-path',
				'/',
				'--method',
				'org.freedesktop.Avahi.Server.GetHostNameFqdn',
			],
			{ encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
		);
		return parseLocalHostname(response);
	} catch (error) {
		throw new Error(
			'Unable to determine the local hostname; Avahi and gdbus are required',
			{ cause: error },
		);
	}
}
