import type { StoredCredentials } from '../../native/NativeCredentials';
import type { CredentialsStore } from '../credentials';
import { createApiClient } from './client';

jest.mock('../../native/NativeDownload', () => ({
  __esModule: true,
  default: { download: jest.fn(async () => 7701) },
}));

const mockDownload = (jest.requireMock('../../native/NativeDownload') as {
  default: { download: jest.Mock };
}).default.download;

const credentials: StoredCredentials = {
  serverId: 'server-1',
  deviceId: 'device-1',
  accessToken: 'access-token-1',
  accessTokenExpiresAt: '2026-09-15T12:15:00.000Z',
  refreshToken: 'refresh-token-1',
  refreshTokenExpiresAt: '2026-12-14T12:00:00.000Z',
};

describe('authenticated original downloads', () => {
  beforeEach(() => mockDownload.mockClear());

  it('passes the bearer header separately from the URL to native download', async () => {
    const store: CredentialsStore = {
      get: async () => credentials,
      set: async () => undefined,
      clear: async () => undefined,
    };
    const client = createApiClient({ baseURL: 'https://photos.example', serverId: 'server-1', credentials: store });

    await client.downloadOriginal('photo/1', 'holiday photo.jpg');

    expect(mockDownload).toHaveBeenCalledWith(
      'https://photos.example/api/v1/photos/photo%2F1/original',
      'holiday photo.jpg',
      'Bearer access-token-1',
      [],
    );
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });
});
