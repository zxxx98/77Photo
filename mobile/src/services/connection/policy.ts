import {
  ipInCIDR,
  isGloballyRoutableCIDR,
  parseCIDR,
  parseIPAddress,
} from './cidr';

export const DEFAULT_LAN_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;

export type ConnectionDecision =
  | { allowed: true; normalizedURL: string; insecure: boolean }
  | {
      allowed: false;
      reason: 'invalid_url' | 'http_hostname' | 'http_outside_lan' | 'unsupported_scheme';
    };

function explicitPort(raw: string, protocol: string): string | null {
  const authority = raw.match(/^https?:\/\/([^/?#]*)/i)?.[1];
  if (!authority || authority.includes('@')) {
    return null;
  }
  const portMatch = authority.startsWith('[')
    ? authority.match(/^\[[^\]]+\]:(\d+)$/)
    : authority.match(/:(\d+)$/);
  if (!portMatch) {
    return null;
  }
  const port = Number(portMatch[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  if (protocol === 'http:' && port === 80) {
    return '80';
  }
  if (protocol === 'https:' && port === 443) {
    return '443';
  }
  return String(port);
}

function normalizedHostname(url: URL): string {
  const rawHostname = url.hostname.toLowerCase();
  const ip = parseIPAddress(rawHostname);
  if (ip) {
    return ip.normalized;
  }
  return rawHostname;
}

function normalizedAuthority(url: URL, raw: string): string {
  const hostname = normalizedHostname(url);
  const formattedHostname = hostname.includes(':') ? `[${hostname}]` : hostname;
  const port = url.port || explicitPort(raw, url.protocol) || '';
  return `${formattedHostname}${port === '' ? '' : `:${port}`}`;
}

function normalizeURL(raw: string): { url: URL; normalizedURL: string } | null {
  try {
    const trimmed = raw.trim();
    const url = new URL(trimmed);
    if (url.username || url.password || url.search || url.hash) {
      return null;
    }
    const path = url.pathname.replace(/\/+$/, '');
    const authority = normalizedAuthority(url, trimmed);
    return {
      url,
      normalizedURL: `${url.protocol}//${authority}${path}`,
    };
  } catch {
    return null;
  }
}

function parseRanges(cidrs: readonly string[]) {
  return cidrs
    .map((cidr) => parseCIDR(cidr))
    .filter((cidr) => cidr !== null);
}

export function evaluateServerURL(raw: string, cidrs: readonly string[]): ConnectionDecision {
  const normalized = normalizeURL(raw);
  if (!normalized) {
    return { allowed: false, reason: 'invalid_url' };
  }
  const { url, normalizedURL } = normalized;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: 'unsupported_scheme' };
  }
  if (url.protocol === 'https:') {
    return { allowed: true, normalizedURL, insecure: false };
  }

  const ip = parseIPAddress(url.hostname);
  if (!ip) {
    return { allowed: false, reason: 'http_hostname' };
  }
  const allowed = parseRanges(cidrs).some((range) => ipInCIDR(ip, range));
  if (!allowed) {
    return { allowed: false, reason: 'http_outside_lan' };
  }
  return { allowed: true, normalizedURL, insecure: true };
}

export function validateManualCIDR(
  raw: string,
): { ok: true; normalized: string; globallyRoutable: boolean } | { ok: false; reason: string } {
  const range = parseCIDR(raw);
  if (!range) {
    return { ok: false, reason: 'invalid_cidr' };
  }
  if (range.prefixLength === 0) {
    return { ok: false, reason: 'catch_all' };
  }
  return {
    ok: true,
    normalized: range.normalized,
    globallyRoutable: isGloballyRoutableCIDR(range),
  };
}

function effectivePort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  if (url.protocol === 'http:') {
    return '80';
  }
  if (url.protocol === 'https:') {
    return '443';
  }
  return '';
}

export function assertRedirectAllowed(from: URL, to: URL, cidrs: readonly string[]): void {
  if (from.protocol === 'https:' && to.protocol !== 'https:') {
    throw new Error('redirect_scheme_downgrade');
  }
  if (to.username || to.password) {
    throw new Error('redirect_credentials');
  }
  if (
    normalizedHostname(from) !== normalizedHostname(to) ||
    effectivePort(from) !== effectivePort(to)
  ) {
    throw new Error('redirect_host_mismatch');
  }

  const target = evaluateServerURL(`${to.protocol}//${to.host}`, cidrs);
  if (!target.allowed) {
    throw new Error(`redirect_${target.reason}`);
  }
}
