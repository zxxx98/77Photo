import {normalizeServer} from '../src/auth/server';

describe('server address policy', () => {
  test('keeps only a confirmed origin', () => {
    expect(normalizeServer('  https://photos.example.com:8443/  ')).toBe('https://photos.example.com:8443');
    expect(normalizeServer('https://[fd00::10]:8443')).toBe('https://[fd00::10]:8443');
  });

  test('rejects credentials, paths, and query parameters', () => {
    expect(() => normalizeServer('https://user:pass@example.com')).toThrow();
    expect(() => normalizeServer('https://example.com/api')).toThrow();
    expect(() => normalizeServer('https://example.com?token=secret')).toThrow();
  });

  test('HTTP is limited to private IP addresses in every build', () => {
    expect(normalizeServer('http://192.168.1.10:8080')).toBe('http://192.168.1.10:8080');
    expect(normalizeServer('http://10.0.2.2:8080')).toBe('http://10.0.2.2:8080');
    expect(normalizeServer('http://[fd00::10]:8080')).toBe('http://[fd00::10]:8080');
    expect(() => normalizeServer('http://example.com')).toThrow();
    expect(() => normalizeServer('http://8.8.8.8')).toThrow();
  });
});
