import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';

import type { ApiClient } from '../../services/api/client';
import type { Photo } from '../../services/api/types';
import { MediaViewerScreen } from './MediaViewerScreen';

jest.mock('react-native-gesture-handler', () => ({
  PinchGestureHandler: ({ children }: { children: React.ReactNode }) => children,
  State: { ACTIVE: 4 },
}));

jest.mock('react-native-video', () => {
  const mockReact = require('react');
  const ReactNative = require('react-native');
  return function MockVideo(props: Record<string, unknown>) {
    return mockReact.createElement(ReactNative.View, { ...props, testID: props.testID ?? 'video' });
  };
});

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 'photo-1',
    owner_id: 'user-1',
    folder_id: 'folder-1',
    filename: 'photo.heic',
    mime_type: 'image/heic',
    size: 100,
    captured_at: '2026-09-15T00:30:00Z',
    ...overrides,
  };
}

function api(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    previewURL: jest.fn(() => 'https://photo.test/api/v1/photos/photo-1/preview'),
    livePhotoURL: jest.fn(() => 'https://photo.test/api/v1/live-photos/photo-1'),
    originalURL: jest.fn(() => 'https://photo.test/api/v1/photos/photo-1/original'),
    downloadOriginal: jest.fn(async () => undefined),
    getAuthHeaders: jest.fn(async () => ({ Authorization: 'Bearer access-1' })),
    createShareLink: jest.fn(async () => ({
      id: 'share-1', resource_type: 'photo' as const, resource_id: 'photo-1',
      url: '/#/share/token', expires_at: null, password_protected: false,
    })),
    deletePhoto: jest.fn(async () => undefined),
    ...overrides,
  } as ApiClient;
}

describe('MediaViewerScreen', () => {
  it('plays a LIVE HEIC photo from the authenticated motion URL with an authenticated preview poster', async () => {
    const client = api();
    render(<MediaViewerScreen api={client} photos={[photo({ is_live_photo: true })]} />);

    await waitFor(() => expect(screen.getByTestId('media-video-photo-1')).toBeTruthy());
    const video = screen.getByTestId('media-video-photo-1');
    expect(video.props.source).toEqual({
      uri: 'https://photo.test/api/v1/live-photos/photo-1',
      headers: { Authorization: 'Bearer access-1' },
    });
    expect(video.props.poster).toEqual({
      source: {
        uri: 'https://photo.test/api/v1/photos/photo-1/preview',
        headers: { Authorization: 'Bearer access-1' },
      },
      resizeMode: 'contain',
    });
  });

  it('renders standalone HEIC through the authenticated preview', async () => {
    const client = api();
    render(<MediaViewerScreen api={client} photos={[photo()]} />);

    await waitFor(() => expect(screen.getByTestId('media-preview-photo-1')).toBeTruthy());
    expect(screen.getByTestId('media-preview-photo-1').props.source).toEqual({
      uri: 'https://photo.test/api/v1/photos/photo-1/preview',
      headers: { Authorization: 'Bearer access-1' },
    });

  });

  it('retries an image preview after the server reports that it is still being generated', async () => {
    const client = api();
    const view = await render(<MediaViewerScreen api={client} photos={[photo()]} />);

    try {
      const image = screen.getByTestId('media-preview-photo-1');
      await act(async () => {
        image.props.onError?.({ nativeEvent: { error: 'HTTP 202' } });
        await new Promise<void>((resolve) => setTimeout(resolve, 1_050));
      });

      expect(screen.getByTestId('media-preview-photo-1').props.source.uri).toContain('preview_retry=1');
    } finally {
      await view.unmount();
    }
  });

  it('falls back to download for a non-LIVE QuickTime item', async () => {
    const client = api();
    render(<MediaViewerScreen api={client} photos={[photo({ mime_type: 'video/quicktime', filename: 'photo.mov' })]} />);

    await waitFor(() => expect(screen.getByText('此视频格式无法在设备上播放')).toBeTruthy());
    expect(screen.queryByTestId('media-video-photo-1')).toBeNull();
  });
});
