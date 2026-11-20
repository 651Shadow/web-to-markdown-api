import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ApiError } from '../errors';

export interface DnsLookupEntry {
  address: string;
  family: number;
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true }
) => Promise<DnsLookupEntry[]>;

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

const PRIVATE_BLOCK_LIST = (() => {
  const blockList = new BlockList();

  // IPv4 private, loopback, link-local, CGNAT, protocol-assigned, benchmarking, multicast, and reserved ranges
  blockList.addSubnet('0.0.0.0', 8, 'ipv4');
  blockList.addSubnet('10.0.0.0', 8, 'ipv4');
  blockList.addSubnet('100.64.0.0', 10, 'ipv4');
  blockList.addSubnet('127.0.0.0', 8, 'ipv4');
  blockList.addSubnet('169.254.0.0', 16, 'ipv4');
  blockList.addSubnet('172.16.0.0', 12, 'ipv4');
  blockList.addSubnet('192.0.0.0', 24, 'ipv4');
  blockList.addSubnet('192.168.0.0', 16, 'ipv4');
  blockList.addSubnet('198.18.0.0', 15, 'ipv4');
  blockList.addSubnet('224.0.0.0', 4, 'ipv4');
  blockList.addSubnet('240.0.0.0', 4, 'ipv4');

  // IPv6 unspecified, loopback, IPv4-compatible (::/96), NAT64, discard, Teredo/IETF,
  // documentation, 6to4, unique-local, link-local, and multicast ranges.
  // Note: Node's BlockList also maps IPv4 subnets across ::ffff:0:0/96 (both dotted and hex forms).
  blockList.addSubnet('::', 96, 'ipv6');
  blockList.addSubnet('64:ff9b::', 96, 'ipv6');
  blockList.addSubnet('64:ff9b:1::', 48, 'ipv6');
  blockList.addSubnet('100::', 64, 'ipv6');
  blockList.addSubnet('2001::', 23, 'ipv6');
  blockList.addSubnet('2001:db8::', 32, 'ipv6');
  blockList.addSubnet('2002::', 16, 'ipv6');
  blockList.addSubnet('fc00::', 7, 'ipv6');
  blockList.addSubnet('fe80::', 10, 'ipv6');
  blockList.addSubnet('ff00::', 8, 'ipv6');

  return blockList;
})();

const defaultLookup: DnsLookupFn = async (hostname, options) => {
  return dnsLookup(hostname, { all: options.all, verbatim: true });
};

/**
 * Validates and normalizes an HTTP or HTTPS URL string.
 */
export function validateUrl(urlString: string): URL | null {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Checks whether an IPv4 or IPv6 address belongs to a private, loopback,
 * link-local, transition, multicast, or reserved range using Node's `net.BlockList`.
 */
export function isPrivateIP(rawIp: string): boolean {
  const unbracketed = rawIp.trim().replace(/^\[|\]$/g, '');
  if (!unbracketed || unbracketed.includes('%')) {
    return true;
  }

  const family = isIP(unbracketed);
  if (family === 4) {
    return PRIVATE_BLOCK_LIST.check(unbracketed, 'ipv4');
  }
  if (family === 6) {
    return PRIVATE_BLOCK_LIST.check(unbracketed, 'ipv6');
  }
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, '');
  if (!normalized) {
    return true;
  }
  return (
    BLOCKED_HOSTNAMES.has(normalized) ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  );
}

/**
 * Validates that a URL does not target a blocked host or private IP and
 * returns the resolved, validated IP address for socket pinning.
 * Throws `ApiError(403, 'SSRF_BLOCKED', ...)` without leaking internal IPs.
 */
export async function resolveSafeTarget(
  url: URL,
  lookupFn: DnsLookupFn = defaultLookup
): Promise<ResolvedTarget> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(403, 'SSRF_BLOCKED', 'Only HTTP and HTTPS protocols are allowed');
  }

  const rawHostname = url.hostname;
  const bareHost = rawHostname.replace(/^\[|\]$/g, '');

  if (isBlockedHostname(bareHost)) {
    throw new ApiError(403, 'SSRF_BLOCKED', 'Access to this hostname is not allowed');
  }

  const literalFamily = isIP(bareHost);
  if (literalFamily === 4 || literalFamily === 6 || rawHostname.startsWith('[')) {
    if (isPrivateIP(bareHost)) {
      throw new ApiError(
        403,
        'SSRF_BLOCKED',
        'Direct access to private or reserved IP addresses is not allowed'
      );
    }
    return {
      url,
      address: bareHost,
      family: literalFamily as 4 | 6,
    };
  }

  let entries: DnsLookupEntry[];
  try {
    entries = await lookupFn(bareHost.replace(/\.+$/, ''), { all: true });
  } catch {
    throw new ApiError(403, 'SSRF_BLOCKED', 'Unable to resolve target hostname');
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ApiError(403, 'SSRF_BLOCKED', 'Unable to resolve target hostname');
  }

  if (entries.some((entry) => isPrivateIP(entry.address))) {
    throw new ApiError(
      403,
      'SSRF_BLOCKED',
      'Hostname resolves to a private or reserved IP address'
    );
  }

  const preferred = entries.find((e) => isIP(e.address) === 4) ?? entries[0];

  return {
    url,
    address: preferred.address,
    family: isIP(preferred.address) as 4 | 6,
  };
}
