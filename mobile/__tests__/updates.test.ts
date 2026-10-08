import {checkForUpdate, compareVersions, currentVersion} from '../src/update/releases';

const originalFetch = globalThis.fetch;
const fetchMock = jest.fn();
const release = (version: string, extra = {}) => ({
  tag_name: `android-${version}`, draft: false, prerelease: false, body: '更新说明',
  assets: [{name: `77photo-android-${version}-arm64-release.apk`, state: 'uploaded', size: 100,
    browser_download_url: `https://github.com/zxxx98/77Photo/releases/download/android-${version}/77photo-android-${version}-arm64-release.apk`}], ...extra,
});
const respond = (data: unknown) => ({ok: true, status: 200, json: async () => data});
beforeEach(() => {globalThis.fetch = fetchMock; fetchMock.mockReset();});
afterEach(() => {globalThis.fetch = originalFetch; jest.useRealTimers();});

test('compares numeric version components', () => {
  expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
  expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  expect(compareVersions('0.4.10', '0.4.10')).toBe(0);
});

test('ignores server releases, drafts and prereleases; selects highest version regardless of order', async () => {
  fetchMock.mockResolvedValue(respond([release('90.0.0', {tag_name: 'v90.0.0'}),
    release('80.0.0', {draft: true}), release('70.0.0', {prerelease: true}), release('10.10.0'), release('10.9.0')]));
  expect(await checkForUpdate()).toMatchObject({version: '10.10.0', notes: '更新说明'});
  expect(fetchMock.mock.calls[0][1].headers).toEqual({Accept: 'application/vnd.github+json'});
});

test('paginates past server releases', async () => {
  fetchMock.mockResolvedValueOnce(respond(Array.from({length: 100}, () => ({tag_name: 'v99.0.0'}))))
    .mockResolvedValueOnce(respond([release('10.0.0')]));
  expect(await checkForUpdate()).toMatchObject({version: '10.0.0'});
  expect(fetchMock.mock.calls[1][0]).toContain('page=2');
});

test.each([currentVersion, '0.0.1'])('does not offer equal or older version %s', async version => {
  fetchMock.mockResolvedValue(respond([release(version)]));
  expect(await checkForUpdate()).toBeNull();
});

test.each([
  {assets: []},
  {assets: [{name: 'x86.apk', state: 'uploaded', size: 100}]},
  {assets: [{name: '77photo-android-10.0.0-arm64-release.apk', state: 'uploaded', size: 100, browser_download_url: 'https://example.com/app.apk'}]},
])('rejects missing or invalid ARM64 assets', async ({assets}) => {
  fetchMock.mockResolvedValue(respond([release('10.0.0', {assets})]));
  await expect(checkForUpdate()).rejects.toThrow('ARM64');
});

test.each([403, 429, 500])('reports HTTP failure %s', async status => {
  fetchMock.mockResolvedValue({ok: false, status});
  await expect(checkForUpdate()).rejects.toThrow();
});

test.each([{data: []}, {data: {message: 'invalid'}}])('does not report latest when release data is unavailable', async ({data}) => {
  fetchMock.mockResolvedValue(respond(data));
  await expect(checkForUpdate()).rejects.toThrow();
});

test('reports network failure', async () => {
  fetchMock.mockRejectedValue(new TypeError('Network request failed'));
  await expect(checkForUpdate()).rejects.toThrow('无法连接 GitHub');
});

test('aborts a stalled request after timeout', async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const result = checkForUpdate().catch(error => error);
  await jest.advanceTimersByTimeAsync(15000);
  expect(await result).toEqual(expect.objectContaining({message: expect.stringContaining('超时')}));
});
