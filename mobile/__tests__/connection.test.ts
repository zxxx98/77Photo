import {NativeModules} from 'react-native';
import {ed25519} from '@noble/curves/ed25519';
import {bytesToHex, utf8ToBytes} from '@noble/curves/abstract/utils';
import {IdentityError, ServerConnection, verifyAddress, type ServerProfile} from '../src/auth/connection';

jest.mock('react-native', () => ({NativeModules: {Photo77Picker: {identityChallenge: jest.fn()}}}));
const seed = new Uint8Array(32).fill(1);
const otherSeed = new Uint8Array(32).fill(2);
const publicKey = bytesToHex(ed25519.getPublicKey(seed));
const local = 'http://192.168.1.10:8080';
const vpn = 'http://100.90.1.10:8080';
const profile: ServerProfile = {id: local, publicKey, addresses: [
  {url: local, name: '家中', verified: true}, {url: vpn, name: '组网', verified: true},
]};
let nonce = 0;
function proof(url: string, key = seed): Response {
  const challenge = new URL(url).searchParams.get('challenge');
  return {ok: true, status: 200, url, json: async () => ({
    public_key: bytesToHex(ed25519.getPublicKey(key)),
    signature: bytesToHex(ed25519.sign(utf8ToBytes(`77Photo/server-identity/v1:${challenge}`), key)),
  })} as Response;
}
beforeEach(() => {
  jest.clearAllMocks();
  (NativeModules.Photo77Picker.identityChallenge as jest.Mock).mockImplementation(async () => (++nonce).toString(16).padStart(64, '0'));
});

test('validates fresh proof without sending credentials and rejects another instance', async () => {
  globalThis.fetch = jest.fn(async url => proof(String(url)));
  await expect(verifyAddress(vpn, publicKey)).resolves.toBe(publicKey);
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({headers: {Accept: 'application/json'}}));
  globalThis.fetch = jest.fn(async url => proof(String(url), otherSeed));
  await expect(verifyAddress(vpn, publicKey)).rejects.toBeInstanceOf(IdentityError);
});

test('rejects replayed proofs and cross-origin redirects', async () => {
  const replay = proof(`${vpn}/api/v1/server/identity?challenge=${'0'.repeat(64)}`);
  globalThis.fetch = jest.fn(async () => replay);
  await expect(verifyAddress(vpn, publicKey)).rejects.toBeInstanceOf(IdentityError);
  globalThis.fetch = jest.fn(async url => ({...proof(String(url)), url: 'https://other.example/identity'} as Response));
  await expect(verifyAddress(vpn, publicKey)).rejects.toBeInstanceOf(IdentityError);
});

test('shares probes, falls back to verified VPN address, and caches success', async () => {
  globalThis.fetch = jest.fn(async url => {
    if (String(url).startsWith(local)) {throw new TypeError('offline');}
    return proof(String(url));
  });
  const connection = new ServerConnection();
  const session = {server: local, profile};
  expect(await Promise.all([connection.resolve(session), connection.resolve(session)])).toEqual([vpn, vpn]);
  expect(fetch).toHaveBeenCalledTimes(2);
  await expect(connection.resolve(session)).resolves.toBe(vpn);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(connection.statuses.get(local)).toBe('不可连接');
  connection.invalidate();
  await expect(connection.resolve({...session, server: vpn})).resolves.toBe(vpn);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test('manual mode stays on the selected address and does not clear the session', async () => {
  globalThis.fetch = jest.fn(async () => {throw new TypeError('offline');});
  const connection = new ServerConnection();
  const session = {server: local, profile: {...profile, manual: local}};
  await expect(connection.resolve(session)).rejects.toThrow('开启组网工具');
  await expect(connection.resolve(session)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(session.profile.addresses).toHaveLength(2);
});

test('never selects unverified or mismatched addresses', async () => {
  const pending = 'http://10.0.0.3';
  globalThis.fetch = jest.fn(async url => proof(String(url), otherSeed));
  const connection = new ServerConnection();
  await expect(connection.resolve({server: local, profile: {...profile, addresses: [
    {url: local, name: '已替换的服务器', verified: true}, {url: pending, name: '待验证', verified: false},
  ]}})).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(connection.statuses.get(local)).toBe('身份不匹配');
});

test('legacy single-address sessions work without identity support', async () => {
  globalThis.fetch = jest.fn();
  await expect(new ServerConnection().resolve({server: local})).resolves.toBe(local);
  expect(fetch).not.toHaveBeenCalled();
});

test('verification does not require a TextEncoder polyfill on Android', async () => {
  const encoder = (globalThis as unknown as {TextEncoder?: unknown}).TextEncoder;
  const response = proof(`${vpn}/api/v1/server/identity?challenge=${(nonce + 1).toString(16).padStart(64, '0')}`);
  const data = await response.json();
  globalThis.fetch = jest.fn(async () => ({...response, json: async () => data} as Response));
  try {
    Object.defineProperty(globalThis, 'TextEncoder', {value: undefined, configurable: true, writable: true});
    await expect(verifyAddress(vpn, publicKey)).resolves.toBe(publicKey);
  } finally {Object.defineProperty(globalThis, 'TextEncoder', {value: encoder, configurable: true, writable: true});}
});

test('a probe from an old configuration cannot override a new manual selection', async () => {
  let release: (response: Response) => void = () => {};
  let oldURL = '';
  globalThis.fetch = jest.fn(async url => {
    if (String(url).startsWith(local)) {
      oldURL = String(url);
      return new Promise<Response>(resolve => {release = resolve;});
    }
    return proof(String(url));
  });
  const connection = new ServerConnection();
  const old = connection.resolve({server: local, profile});
  await Promise.resolve();
  connection.invalidate();
  await expect(connection.resolve({server: local, profile: {...profile, manual: vpn}})).resolves.toBe(vpn);
  release(proof(oldURL));
  await expect(old).rejects.toThrow('连接配置已更新');
  await expect(connection.resolve({server: vpn, profile: {...profile, manual: vpn}})).resolves.toBe(vpn);
});
