import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

export type MobileSession = {
  server: string;
  username: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

const credentialService = 'com.photo77.mobile.session';
const serverKey = 'last_server';

export async function loadSession(): Promise<MobileSession | null> {
  const stored = await Keychain.getGenericPassword({service: credentialService});
  if (!stored) {
    return null;
  }
  try {
    const session = JSON.parse(stored.password) as MobileSession;
    if (!session.server || !session.refreshToken || !session.accessToken) {
      throw new Error('Invalid stored session');
    }
    return session;
  } catch {
    await clearSession();
    return null;
  }
}

export async function saveSession(session: MobileSession): Promise<void> {
  const saved = await Keychain.setGenericPassword('session', JSON.stringify(session), {
    service: credentialService,
  });
  if (!saved) {
    throw new Error('无法安全保存登录状态');
  }
  await AsyncStorage.setItem(serverKey, session.server).catch(() => {});
}

export async function clearSession(): Promise<void> {
  const cleared = await Keychain.resetGenericPassword({service: credentialService});
  if (!cleared) {
    throw new Error('无法清除本机登录凭据');
  }
}

export async function loadLastServer(): Promise<string> {
  return (await AsyncStorage.getItem(serverKey).catch(() => null)) ?? '';
}
