import {ApiError, me, refresh} from './api';
import {clearSession, saveSession, type MobileSession} from './session';

let refreshInFlight: Promise<MobileSession> | null = null;

function expiresSoon(session: MobileSession): boolean {
  const expiry = Date.parse(session.accessExpiresAt);
  return !Number.isFinite(expiry) || expiry <= Date.now() + 60_000;
}

async function refreshOnce(session: MobileSession): Promise<MobileSession> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const next = await refresh(session);
      try {
        await saveSession(next);
      } catch (error) {
        await clearSession();
        throw error;
      }
      return next;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Validates the device with the server; offline errors leave credentials intact. */
export async function restoreSession(session: MobileSession): Promise<MobileSession> {
  let current = session;
  try {
    if (expiresSoon(current)) {
      current = await refreshOnce(current);
    }
    await me(current);
    return current;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      if (current === session && expiresSoon(session)) {
        await clearSession();
        throw error;
      }
      try {
        current = await refreshOnce(current);
        await me(current);
        return current;
      } catch (retryError) {
        if (retryError instanceof ApiError && retryError.status === 401) {
          await clearSession();
        }
        throw retryError;
      }
    }
    throw error;
  }
}
