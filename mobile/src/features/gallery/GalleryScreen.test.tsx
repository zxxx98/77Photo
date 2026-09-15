import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ApiError, createApiClient, type ApiClient } from '../../services/api/client';
import type { Folder, Photo, PhotoPage } from '../../services/api/types';
import { AuthenticatedImage } from './AuthenticatedImage';
import {
  appendPhotoPages,
  fetchPhotoPage,
  groupPhotosByLocalDay,
  photoKeys,
} from './queries';
import { GalleryScreen } from './GalleryScreen';
import { FolderBrowserScreen } from '../folders/FolderBrowserScreen';
import { FolderPickerScreen } from '../folders/FolderPickerScreen';
import { MediaDetailsSheet } from '../viewer/MediaDetailsSheet';
import { MediaViewerScreen } from '../viewer/MediaViewerScreen';

const testQueryOptions = { defaultOptions: { queries: { retry: false, gcTime: 0 } } };

jest.mock('@shopify/flash-list', () => {
  const ReactNative = require('react-native');
  return { FlashList: ReactNative.FlatList };
});

jest.mock('react-native-gesture-handler', () => {
  return {
    PinchGestureHandler: ({ children }: { children: React.ReactNode }) => children,
    State: { ACTIVE: 4 },
  };
});

jest.mock('react-native-video', () => {
  const ReactNative = require('react-native');
  return function MockVideo(props: Record<string, unknown>) {
    return ReactNative.createElement(ReactNative.View, { ...props, testID: props.testID ?? 'video' });
  };
});

function photo(id: string, capturedAt = '2026-09-15T00:30:00Z'): Photo {
  return {
    id,
    owner_id: 'user-1',
    folder_id: 'folder-1',
    filename: `${id}.jpg`,
    mime_type: 'image/jpeg',
    size: 100,
    captured_at: capturedAt,
  };
}

function folder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: 'folder-1',
    owner_id: 'user-1',
    parent_id: null,
    name: '旅行',
    is_shared: false,
    photo_count: 2,
    child_folder_count: 0,
    ...overrides,
  };
}

function page(items: Photo[], nextCursor: string | null = null): PhotoPage {
  return { items, next_cursor: nextCursor };
}

function createClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listPhotos: jest.fn(async () => page([])),
    listFolders: jest.fn(async () => ({ items: [] })),
    getFolder: jest.fn(async (id: string) => folder({ id })),
    getPhoto: jest.fn(async (id: string) => photo(id)),
    thumbnailURL: jest.fn((id: string, size: number) => `https://photo.test/api/v1/photos/${id}/thumbnail?size=${size}`),
    previewURL: jest.fn((id: string) => `https://photo.test/api/v1/photos/${id}/preview`),
    originalURL: jest.fn((id: string) => `https://photo.test/api/v1/photos/${id}/original`),
    getAuthHeaders: jest.fn(async () => ({ Authorization: 'Bearer access-1' })),
    createShareLink: jest.fn(async () => ({
      id: 'share-1',
      resource_type: 'photo' as const,
      resource_id: 'photo-1',
      url: '/#/share/token',
      expires_at: null,
      password_protected: false,
    })),
    deletePhoto: jest.fn(async () => undefined),
    ...overrides,
  } as ApiClient;
}

async function renderWithQuery(children: React.ReactElement, queryClient = new QueryClient(testQueryOptions)) {
  return {
    queryClient,
    ...(await render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>)),
  };
}

describe('gallery query helpers', () => {
  it('groups photos by local calendar day while preserving server order', () => {
    expect(groupPhotosByLocalDay([
      photo('a', '2026-09-15T00:30:00Z'),
      photo('b', '2026-09-14T23:30:00Z'),
    ], 'Asia/Shanghai')).toEqual([
      { key: '2026-09-15', ids: ['a', 'b'] },
    ]);
  });

  it('appends pages once in stable cursor order and ignores duplicate IDs', () => {
    expect(appendPhotoPages([
      page([photo('a'), photo('b')], 'cursor-1'),
      page([photo('b'), photo('c')], 'cursor-2'),
      page([photo('d')], null),
    ]).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('restarts from the first page when the server expires a cursor', async () => {
    const api = createClient({
      listPhotos: jest.fn()
        .mockRejectedValueOnce(new ApiError(410, 'CURSOR_EXPIRED', 'expired'))
        .mockResolvedValueOnce(page([photo('fresh')], 'new-cursor')),
    });

    await expect(fetchPhotoPage(api, { cursor: 'expired-cursor', limit: 50 })).resolves.toEqual(
      page([photo('fresh')], 'new-cursor'),
    );
    expect(api.listPhotos).toHaveBeenNthCalledWith(2, { limit: 50 });
  });

  it('scopes photo cache keys by server and user', () => {
    expect(photoKeys.list('server-a', 'user-a')).not.toEqual(photoKeys.list('server-b', 'user-a'));
    expect(photoKeys.list('server-a', 'user-a')).not.toEqual(photoKeys.list('server-a', 'user-b'));
    expect(photoKeys.list('server-a', 'user-a', 'folder-1')).toEqual([
      'photos', 'server-a', 'user-a', 'list', 'folder-1',
    ]);
  });

  it('uses the typed metadata, media, share, and delete API paths', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const api = createApiClient({
      baseURL: 'https://photo.test',
      serverId: 'server-1',
      credentials: {
        get: jest.fn(async () => ({
          serverId: 'server-1',
          deviceId: 'device-1',
          accessToken: 'access-1',
          accessTokenExpiresAt: '2026-09-15T12:15:00.000Z',
          refreshToken: 'refresh-1',
          refreshTokenExpiresAt: '2026-12-14T12:00:00.000Z',
        })),
        set: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
      },
      transport: jest.fn(async (url, init = {}) => {
        const parsed = new URL(url);
        calls.push({ path: `${parsed.pathname}${parsed.search}`, init });
        if (parsed.pathname.endsWith('/share-links')) {
          return new Response(JSON.stringify({
            id: 'share-1', resource_type: 'photo', resource_id: 'photo-1',
            url: '/#/share/token', expires_at: null, password_protected: false,
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        if (parsed.pathname.endsWith('/original') || parsed.pathname.endsWith('/preview')) {
          return new Response('media', { status: 200 });
        }
        if (parsed.pathname.endsWith('/photo-1')) {
          return new Response(JSON.stringify(photo('photo-1')), { status: 200 });
        }
        if (parsed.pathname.endsWith('/folder-1')) {
          return new Response(JSON.stringify(folder()), { status: 200 });
        }
        return new Response(null, { status: 204 });
      }),
    });

    await api.getPhoto('photo-1');
    await api.getFolder('folder-1');
    await api.createShareLink({ resourceType: 'photo', resourceId: 'photo-1', duration: 'forever' });
    await api.deletePhoto('photo-1');
    expect(api.thumbnailURL('photo-1', 256)).toBe(
      'https://photo.test/api/v1/photos/photo-1/thumbnail?size=256',
    );
    expect(api.previewURL('photo-1')).toBe('https://photo.test/api/v1/photos/photo-1/preview');
    expect(api.originalURL('photo-1')).toBe('https://photo.test/api/v1/photos/photo-1/original');
    expect(calls.map(({ path }) => path)).toEqual([
      '/api/v1/photos/photo-1',
      '/api/v1/folders/folder-1',
      '/api/v1/share-links',
      '/api/v1/photos/photo-1?confirm=true',
    ]);
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer access-1');
  });
});

describe('GalleryScreen', () => {
  it('renders cached photos before making a network request', async () => {
    const api = createClient();
    const queryClient = new QueryClient(testQueryOptions);
    queryClient.setQueryData(photoKeys.list('server-1', 'user-1'), {
      pages: [page([photo('cached')])],
      pageParams: [undefined],
    });

    const rendered = await renderWithQuery(<GalleryScreen api={api} serverId="server-1" userId="user-1" />, queryClient);

    expect(rendered.toJSON()).not.toBeNull();
    expect(screen.getByTestId('photo-cached')).toBeTruthy();
    expect(api.listPhotos).not.toHaveBeenCalled();
  });

  it('shows loading, empty, and error states', async () => {
    let resolve: ((value: PhotoPage) => void) | undefined;
    const loadingApi = createClient({
      listPhotos: jest.fn(() => new Promise<PhotoPage>((done) => { resolve = done; })),
    });
    await renderWithQuery(<GalleryScreen api={loadingApi} serverId="server-1" userId="user-1" />);
    expect(screen.getByText('正在加载照片…')).toBeTruthy();
    await act(async () => resolve?.(page([])));
    await waitFor(() => expect(screen.getByText('还没有照片')).toBeTruthy());

    const errorApi = createClient({ listPhotos: jest.fn(async () => { throw new Error('offline'); }) });
    await renderWithQuery(<GalleryScreen api={errorApi} serverId="server-1" userId="user-1" />);
    await waitFor(() => expect(screen.getByText('照片加载失败')).toBeTruthy());
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});

describe('folders and authenticated media', () => {
  it('navigates into a folder and back to the root list', async () => {
    const api = createClient({
      listFolders: jest.fn(async (parentId?: string) => ({
        items: parentId ? [folder({ id: 'child-1', name: '子目录', parent_id: parentId })] : [folder()],
      })),
    });
    await renderWithQuery(<FolderBrowserScreen api={api} serverId="server-1" userId="user-1" />);

    await waitFor(() => expect(screen.getByText('旅行')).toBeTruthy());
    await fireEvent.press(screen.getByText('旅行'));
    await waitFor(() => expect(screen.getByText('子目录')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: '返回' }));
    await waitFor(() => expect(api.listFolders).toHaveBeenLastCalledWith(undefined));
  });

  it('only returns writable folders from the picker', async () => {
    const onSelectFolder = jest.fn();
    const api = createClient({
      listFolders: jest.fn(async () => ({ items: [
        folder({ id: 'owned', name: '可写', owner_id: 'user-1' }),
        folder({ id: 'read-only', name: '只读', owner_id: 'other', inherited_permission: 'read' }),
      ] })),
    });
    await renderWithQuery(
      <FolderPickerScreen api={api} serverId="server-1" userId="user-1" onSelectFolder={onSelectFolder} />,
    );

    await waitFor(() => expect(screen.getByTestId('folder-picker-owned')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('folder-picker-owned'));
    expect(onSelectFolder).toHaveBeenCalledWith('owned');
    expect(screen.getByTestId('folder-picker-read-only')).toBeTruthy();
    expect(screen.getByTestId('folder-picker-read-only').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
  });

  it('passes the Bearer header to thumbnail image requests', async () => {
    await render(<AuthenticatedImage
      testID="thumb"
      uri="https://photo.test/api/v1/photos/photo-1/thumbnail?size=256"
      accessToken="access-1"
    />);

    expect(screen.getByTestId('thumb').props.source).toEqual({
      uri: 'https://photo.test/api/v1/photos/photo-1/thumbnail?size=256',
      headers: { Authorization: 'Bearer access-1' },
    });
  });

  it('renders media details and a 1280px authenticated viewer preview', async () => {
    const selectedPhoto = photo('photo-1');
    const api = createClient();
    await render(<MediaDetailsSheet photo={selectedPhoto} onClose={jest.fn()} />);
    expect(screen.getByText('photo-1.jpg')).toBeTruthy();
    expect(screen.getByText('image/jpeg')).toBeTruthy();

    await renderWithQuery(
      <MediaViewerScreen api={api} photos={[selectedPhoto]} initialIndex={0} />,
    );
    await waitFor(() => expect(api.getAuthHeaders).toHaveBeenCalled());
    expect(api.previewURL).toHaveBeenCalledWith('photo-1');
    expect(api.previewURL).toHaveBeenCalledWith('photo-1');
  });
});
