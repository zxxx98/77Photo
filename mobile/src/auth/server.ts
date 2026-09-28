export function normalizeServer(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('请输入完整的服务器地址，例如 https://photos.example.com');
  }
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('服务器地址不能包含账号、路径或查询参数');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('服务器地址必须使用 HTTPS，或内网 IP 的 HTTP');
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new Error('HTTP 仅允许内网 IP 地址；公网地址请使用 HTTPS');
  }
  return url.origin;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === '::1' || /^f[cd][0-9a-f:]+$/i.test(host)) {
    return true;
  }
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
