import {
  DEFAULT_LAN_CIDRS,
  assertRedirectAllowed,
  evaluateServerURL,
  validateManualCIDR,
} from './policy';

describe('connection policy', () => {
  it.each([
    ['http://192.168.1.8:8080', true],
    ['http://10.2.3.4', true],
    ['http://172.31.0.2', true],
    ['http://[fd00::8]:8080', true],
    ['http://8.8.8.8', false],
    ['http://photo.local', false],
    ['https://8.8.8.8', true],
  ])('%s allowed=%s', (raw, allowed) => {
    expect(evaluateServerURL(raw, DEFAULT_LAN_CIDRS).allowed).toBe(allowed);
  });

  it('rejects catch-all manual ranges', () => {
    expect(validateManualCIDR('0.0.0.0/0')).toEqual({ ok: false, reason: 'catch_all' });
    expect(validateManualCIDR('::/0')).toEqual({ ok: false, reason: 'catch_all' });
  });

  it('matches CIDRs numerically instead of by text prefix', () => {
    expect(evaluateServerURL('http://192.168.10.8', ['192.168.1.0/24']).allowed).toBe(false);
    expect(evaluateServerURL('http://192.168.1.8', ['192.168.1.0/24']).allowed).toBe(true);
    expect(validateManualCIDR('8.8.8.0/24')).toEqual({
      ok: true,
      normalized: '8.8.8.0/24',
      globallyRoutable: true,
    });
  });

  it('normalizes safe URLs and rejects credential-bearing URLs', () => {
    expect(evaluateServerURL(' HTTPS://Photo.Example:8443/// ', DEFAULT_LAN_CIDRS)).toEqual({
      allowed: true,
      normalizedURL: 'https://photo.example:8443',
      insecure: false,
    });
    expect(evaluateServerURL('https://user:pass@photo.example', DEFAULT_LAN_CIDRS)).toEqual({
      allowed: false,
      reason: 'invalid_url',
    });
    expect(evaluateServerURL('https://photo.example/path?token=secret', DEFAULT_LAN_CIDRS)).toEqual({
      allowed: false,
      reason: 'invalid_url',
    });
  });

  it('keeps redirects on the configured server and policy', () => {
    expect(() =>
      assertRedirectAllowed(
        new URL('http://192.168.1.8:8080'),
        new URL('http://192.168.1.9:8080'),
        DEFAULT_LAN_CIDRS,
      ),
    ).toThrow();
    expect(() =>
      assertRedirectAllowed(
        new URL('https://photo.example'),
        new URL('https://photo.example/api'),
        DEFAULT_LAN_CIDRS,
      ),
    ).not.toThrow();
  });

  it('rejects HTTPS redirects that downgrade to HTTP even on the same LAN host', () => {
    expect(() =>
      assertRedirectAllowed(
        new URL('https://192.168.1.8:8080'),
        new URL('http://192.168.1.8:8080/api'),
        DEFAULT_LAN_CIDRS,
      ),
    ).toThrow();
  });

  it('rejects redirects that inject URL credentials', () => {
    expect(() =>
      assertRedirectAllowed(
        new URL('https://photo.example'),
        new URL('https://user:secret@photo.example/api'),
        DEFAULT_LAN_CIDRS,
      ),
    ).toThrow();
  });
});
