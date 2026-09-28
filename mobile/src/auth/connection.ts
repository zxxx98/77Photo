import {NativeModules} from 'react-native';
import {ed25519} from '@noble/curves/ed25519';
import {hexToBytes} from '@noble/curves/abstract/utils';
import {normalizeServer} from './server';
import type {MobileSession} from './session';

export type ServerAddress = {url: string; name: string; verified: boolean};
export type ServerProfile = {
  // Preserve the original queue scope across address changes, including upgrades.
  id: string;
  publicKey?: string;
  addresses: ServerAddress[];
  manual?: string;
};
export type AddressStatus = '可连接' | '不可连接' | '身份不匹配' | '待验证';
export class IdentityError extends Error {}
export class IdentityUnavailableError extends Error {}
export const profileFor = (session: MobileSession): ServerProfile => session.profile ?? {
  id: session.server, addresses: [{url: session.server, name: '默认地址', verified: false}],
};

export async function verifyAddress(input: string, expectedKey?: string): Promise<string> {
  const url = normalizeServer(input);
  const challenge: string = await NativeModules.Photo77Picker.identityChallenge();
  if (!/^[0-9a-f]{64}$/.test(challenge)) {throw new Error('无法生成服务器验证请求');}
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    // Discovery sends no credentials. Reject redirects before trusting the address.
    const response = await fetch(`${url}/api/v1/server/identity?challenge=${challenge}`, {
      signal: controller.signal, headers: {Accept: 'application/json'},
    });
    if (response.url && new URL(response.url).origin !== url) {throw new IdentityError('服务器身份接口不能跳转到其他地址');}
    if (response.status === 404) {throw new IdentityUnavailableError('请先升级服务器，再添加备用地址');}
    if (!response.ok) {throw new TypeError('服务器暂时不可用');}
    const data = await response.json();
    try {
      if (!/^[0-9a-f]{64}$/.test(data.public_key) || !/^[0-9a-f]{128}$/.test(data.signature) ||
          (expectedKey && data.public_key !== expectedKey) ||
          !ed25519.verify(hexToBytes(data.signature), Uint8Array.from(`77Photo/server-identity/v1:${challenge}`, character => character.charCodeAt(0)), hexToBytes(data.public_key), {zip215: false})) {
        throw new Error('invalid proof');
      }
    } catch {throw new IdentityError('该地址的服务器身份不匹配，未发送登录凭据');}
    return data.public_key as string;
  } finally {clearTimeout(timer);}
}

export class ServerConnection {
  readonly statuses = new Map<string, AddressStatus>();
  private checkedAt = 0;
  private selected = '';
  private failure: Error | null = null;
  private inFlight: Promise<string> | null = null;
  private generation = 0;
  invalidate() {this.checkedAt = 0; this.failure = null; this.generation++; this.inFlight = null;}

  async resolve(session: Pick<MobileSession, 'server' | 'profile'>): Promise<string> {
    const profile = session.profile;
    // Older servers retain single-address operation until explicitly bound.
    if (!profile?.publicKey) {return session.server;}
    if (this.checkedAt && Date.now() - this.checkedAt < (this.failure ? 5000 : 30000)) {
      if (this.failure) {throw this.failure;}
      return this.selected;
    }
    if (this.inFlight) {return this.inFlight;}
    const generation = this.generation;
    const run = async () => {
      const eligible = profile.addresses.filter(a => a.verified && (!profile.manual || a.url === profile.manual));
      const current = eligible.find(a => a.url === session.server);
      const ordered = current ? [current, ...eligible.filter(a => a !== current)] : eligible;
      for (const address of ordered) {
        try {
          await verifyAddress(address.url, profile.publicKey);
          if (generation !== this.generation) {throw new Error('连接配置已更新，请重试');}
          this.statuses.set(address.url, '可连接');
          this.selected = address.url; this.checkedAt = Date.now(); this.failure = null;
          return address.url;
        } catch (error) {
          if (generation !== this.generation) {throw error;}
          this.statuses.set(address.url, error instanceof IdentityError ? '身份不匹配' : '不可连接');
        }
      }
      const failure = new TypeError('无法连接服务器，请检查网络或开启组网工具后重试');
      this.failure = failure; this.checkedAt = Date.now();
      throw failure;
    };
    const pending = run().finally(() => {if (this.inFlight === pending) {this.inFlight = null;}});
    this.inFlight = pending;
    return pending;
  }
}
