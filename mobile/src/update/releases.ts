import {version} from '../../package.json';

export const currentVersion = version;
const repository = 'https://github.com/zxxx98/77Photo';
const endpoint = 'https://api.github.com/repos/zxxx98/77Photo/releases';
export type AndroidRelease = {version: string; notes: string; downloadUrl: string; pageUrl: string};

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {return a[i] > b[i] ? 1 : -1;}
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

// Server releases share this repository. Never use /releases/latest or assume date order is version order.
export async function checkForUpdate(signal?: AbortSignal): Promise<AndroidRelease | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) {abort();}
  const timer = setTimeout(abort, 15000);
  let latest: AndroidRelease | null = null;
  try {
    for (let page = 1; page <= 20; page++) {
      const response = await fetch(`${endpoint}?per_page=100&page=${page}`, {
        headers: {Accept: 'application/vnd.github+json'}, signal: controller.signal,
      });
      if (response.status === 403 || response.status === 429) {throw new Error('检查更新请求受限，请稍后重试');}
      if (!response.ok) {throw new Error(`无法获取更新信息（${response.status}），请稍后重试`);}
      const data: unknown = await response.json();
      if (!Array.isArray(data)) {throw new Error('更新信息格式异常，请稍后重试');}
      for (const item of data) {
        const release = record(item);
        if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string') {continue;}
        const match = /^android-v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release.tag_name);
        if (!match || !match[1].split('.').every(part => Number.isSafeInteger(Number(part)))) {continue;}
        const releaseVersion = match[1];
        if (latest && compareVersions(releaseVersion, latest.version) <= 0) {continue;}
        const name = `77photo-android-${releaseVersion}-arm64-release.apk`;
        const expectedUrl = `${repository}/releases/download/${release.tag_name}/${name}`;
        const asset = Array.isArray(release.assets) && release.assets.some(value => {
          const file = record(value);
          return file.name === name && file.browser_download_url === expectedUrl && file.state === 'uploaded' && typeof file.size === 'number' && file.size > 0;
        });
        latest = {version: releaseVersion, notes: typeof release.body === 'string' ? release.body : '',
          downloadUrl: asset ? expectedUrl : '', pageUrl: `${repository}/releases/tag/${release.tag_name}`};
      }
      if (data.length < 100) {
        if (!latest) {throw new Error('暂未找到 Android 正式版本，请稍后重试');}
        if (compareVersions(latest.version, currentVersion) <= 0) {return null;}
        if (!latest.downloadUrl) {throw new Error('新版本的 ARM64 安装包尚未就绪，请稍后重试');}
        return latest;
      }
    }
    throw new Error('更新列表过长，未能完成检查，请前往 GitHub 查看');
  } catch (error) {
    if (controller.signal.aborted) {throw new Error('检查更新超时或已取消，请重试');}
    if (error instanceof TypeError) {throw new Error('无法连接 GitHub，请检查网络后重试');}
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
