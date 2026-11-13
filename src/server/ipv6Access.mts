import { BlockList, isIP, isIPv4 } from 'node:net';

export interface InterfaceAddress {
	family: string;
	address: string;
	cidr: string | null;
	internal: boolean;
}

export function isAllowedPeer(
	remoteAddress: string,
	localAddress: string,
	interfaces: InterfaceAddress[],
): boolean {
	const remote = remoteAddress.split('%')[0];
	const local = localAddress.split('%')[0];
	if (
		isIPv4(remote) ||
		(remote.toLowerCase().startsWith('::ffff:') && isIPv4(remote.slice(7)))
	)
		return true;
	if (isIP(remote) !== 6 || isIP(local) !== 6) return false;
	const loopback = new BlockList();
	loopback.addAddress('::1', 'ipv6');
	if (loopback.check(remote, 'ipv6')) return loopback.check(local, 'ipv6');

	for (const entry of interfaces) {
		if (entry.family !== 'IPv6' || entry.internal || !entry.cidr) continue;
		const address = entry.address.split('%')[0];
		const parts = entry.cidr.split('/');
		if (
			isIP(address) !== 6 ||
			parts.length !== 2 ||
			!/^\d{1,3}$/.test(parts[1])
		)
			continue;
		const prefix = Number(parts[1]);
		if (prefix > 128) continue;
		const destination = new BlockList();
		destination.addAddress(address, 'ipv6');
		if (!destination.check(local, 'ipv6')) continue;
		const subnet = new BlockList();
		subnet.addSubnet(address, Math.max(prefix, 64), 'ipv6');
		if (subnet.check(remote, 'ipv6')) return true;
	}
	return false;
}
