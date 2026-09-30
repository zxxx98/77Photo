import {ApiError, me, refresh} from '../src/auth/api';
import {restoreSession} from '../src/auth/controller';
import {clearSession, saveSession, type MobileSession} from '../src/auth/session';

jest.mock('../src/auth/api', () => ({
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(httpStatus: number, errorCode: string, errorMessage: string) {
      super(errorMessage);
      this.status = httpStatus;
      this.code = errorCode;
    }
  },
  me: jest.fn(),
  refresh: jest.fn(),
}));
jest.mock('../src/auth/session', () => ({
  clearSession: jest.fn(),
  saveSession: jest.fn(),
}));

const oldSession: MobileSession = {
  server: 'https://photos.example.com', username: 'lin', accessToken: 'old-access',
  accessExpiresAt: '2020-01-01T00:00:00Z', refreshToken: 'old-refresh',
  refreshExpiresAt: '2030-01-01T00:00:00Z',
};
const newSession: MobileSession = {
  ...oldSession, accessToken: 'new-access', refreshToken: 'new-refresh',
  accessExpiresAt: '2030-01-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  (me as jest.Mock).mockResolvedValue({id: 'user-1', username: 'lin'});
  (saveSession as jest.Mock).mockResolvedValue(undefined);
  (clearSession as jest.Mock).mockResolvedValue(undefined);
});

test('rotates and stores the token pair before validating the device', async () => {
  (refresh as jest.Mock).mockResolvedValue(newSession);
  await expect(restoreSession(oldSession)).resolves.toEqual({...newSession, userId: 'user-1'});
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(saveSession).toHaveBeenCalledWith(newSession);
  expect(me).toHaveBeenCalledWith(newSession);
});

test('restoring an older session binds it to the immutable account ID', async () => {
  const current = {...oldSession, accessExpiresAt: '2030-01-01T00:00:00Z'};
  await expect(restoreSession(current)).resolves.toEqual({...current, userId: 'user-1'});
  expect(saveSession).toHaveBeenCalledWith({...current, userId: 'user-1'});
});

test('concurrent restore calls share one refresh', async () => {
  (refresh as jest.Mock).mockResolvedValue(newSession);
  await Promise.all([restoreSession(oldSession), restoreSession(oldSession)]);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('revoked refresh token clears saved credentials', async () => {
  (refresh as jest.Mock).mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'revoked'));
  await expect(restoreSession(oldSession)).rejects.toMatchObject({status: 401});
  expect(clearSession).toHaveBeenCalledTimes(1);
});

test('network failure keeps saved credentials for retry', async () => {
  (refresh as jest.Mock).mockRejectedValue(new TypeError('Network request failed'));
  await expect(restoreSession(oldSession)).rejects.toThrow('Network request failed');
  expect(clearSession).not.toHaveBeenCalled();
});

test('network failure after rotation leaves the new pair in secure storage', async () => {
  (refresh as jest.Mock).mockResolvedValue(newSession);
  (me as jest.Mock).mockRejectedValue(new TypeError('Network request failed'));
  await expect(restoreSession(oldSession)).rejects.toThrow('Network request failed');
  expect(saveSession).toHaveBeenCalledWith(newSession);
  expect(clearSession).not.toHaveBeenCalled();
});
