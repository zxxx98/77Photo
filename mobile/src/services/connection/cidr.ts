/* eslint-disable no-bitwise -- byte-level IPv4/IPv6 masking is intentional. */

export type IPAddress = {
  family: 4 | 6;
  bytes: number[];
  normalized: string;
};

export type CIDRRange = {
  family: 4 | 6;
  prefixLength: number;
  networkBytes: number[];
  normalized: string;
};

function parseIPv4(value: string): IPAddress | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }
  const bytes = parts.map(Number);
  if (bytes.some((part) => part < 0 || part > 255)) {
    return null;
  }
  return { family: 4, bytes, normalized: bytes.join('.') };
}

function parseIPv6(value: string): IPAddress | null {
  let expandedValue = value.toLowerCase();
  if (expandedValue.includes('.')) {
    const lastColon = expandedValue.lastIndexOf(':');
    if (lastColon < 0) {
      return null;
    }
    const embeddedIPv4 = parseIPv4(expandedValue.slice(lastColon + 1));
    if (!embeddedIPv4) {
      return null;
    }
    const high = ((embeddedIPv4.bytes[0] << 8) | embeddedIPv4.bytes[1]).toString(16);
    const low = ((embeddedIPv4.bytes[2] << 8) | embeddedIPv4.bytes[3]).toString(16);
    expandedValue = `${expandedValue.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const compression = expandedValue.indexOf('::');
  if (compression !== expandedValue.lastIndexOf('::')) {
    return null;
  }
  const hasCompression = compression >= 0;
  const leftText = hasCompression ? expandedValue.slice(0, compression) : expandedValue;
  const rightText = hasCompression ? expandedValue.slice(compression + 2) : '';
  const left = leftText === '' ? [] : leftText.split(':');
  const right = hasCompression && rightText !== '' ? rightText.split(':') : [];
  const allParts = [...left, ...right];
  if (allParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  const missing = 8 - allParts.length;
  if ((hasCompression && missing < 1) || (!hasCompression && missing !== 0)) {
    return null;
  }
  const words = [
    ...left.map((part) => parseInt(part, 16)),
    ...(hasCompression ? Array.from({ length: missing }, () => 0) : []),
    ...right.map((part) => parseInt(part, 16)),
  ];
  if (words.length !== 8) {
    return null;
  }
  const bytes = words.flatMap((word) => [(word >> 8) & 0xff, word & 0xff]);
  return { family: 6, bytes, normalized: formatIPv6(bytes) };
}

export function parseIPAddress(raw: string): IPAddress | null {
  let value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  if (value.includes(':')) {
    return parseIPv6(value);
  }
  return parseIPv4(value);
}

function formatIPv6(bytes: number[]): string {
  const words = Array.from({ length: 8 }, (_, index) => (bytes[index * 2] << 8) | bytes[index * 2 + 1]);
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== 0) {
      continue;
    }
    let end = index;
    while (end < words.length && words[end] === 0) {
      end += 1;
    }
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end - 1;
  }
  if (bestStart < 0) {
    return words.map((word) => word.toString(16)).join(':');
  }
  const left = words.slice(0, bestStart).map((word) => word.toString(16)).join(':');
  const right = words.slice(bestStart + bestLength).map((word) => word.toString(16)).join(':');
  if (left === '' && right === '') {
    return '::';
  }
  if (left === '') {
    return `::${right}`;
  }
  if (right === '') {
    return `${left}::`;
  }
  return `${left}::${right}`;
}

function maskBytes(bytes: number[], prefixLength: number): number[] {
  return bytes.map((byte, index) => {
    const bitsLeft = prefixLength - index * 8;
    if (bitsLeft >= 8) {
      return byte;
    }
    if (bitsLeft <= 0) {
      return 0;
    }
    return byte & (0xff << (8 - bitsLeft));
  });
}

function samePrefix(left: number[], right: number[], prefixLength: number): boolean {
  const maskedLeft = maskBytes(left, prefixLength);
  const maskedRight = maskBytes(right, prefixLength);
  return maskedLeft.every((byte, index) => byte === maskedRight[index]);
}

export function parseCIDR(raw: string): CIDRRange | null {
  const trimmed = raw.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2 || parts[0].trim() === '' || !/^\d+$/.test(parts[1].trim())) {
    return null;
  }
  const ip = parseIPAddress(parts[0]);
  if (!ip) {
    return null;
  }
  const prefixLength = Number(parts[1]);
  const maxPrefix = ip.family === 4 ? 32 : 128;
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > maxPrefix) {
    return null;
  }
  const networkBytes = maskBytes(ip.bytes, prefixLength);
  const network = ip.family === 4 ? networkBytes.join('.') : formatIPv6(networkBytes);
  return { family: ip.family, prefixLength, networkBytes, normalized: `${network}/${prefixLength}` };
}

export function ipInCIDR(ip: IPAddress, range: CIDRRange): boolean {
  return ip.family === range.family && samePrefix(ip.bytes, range.networkBytes, range.prefixLength);
}

export function cidrContainsRange(container: CIDRRange, candidate: CIDRRange): boolean {
  return (
    container.family === candidate.family &&
    container.prefixLength <= candidate.prefixLength &&
    samePrefix(container.networkBytes, candidate.networkBytes, container.prefixLength)
  );
}

const NON_GLOBAL_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
].map((value) => parseCIDR(value) as CIDRRange);

export function isGloballyRoutableCIDR(range: CIDRRange): boolean {
  return !NON_GLOBAL_RANGES.some((special) => cidrContainsRange(special, range));
}
