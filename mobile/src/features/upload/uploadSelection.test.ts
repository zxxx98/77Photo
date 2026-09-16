import type { PickedMedia } from '../../native/NativeUploadQueue';
import { pairPickedMedia } from './uploadService';

function media(displayName: string, mimeType: string): PickedMedia {
  return {
    uri: `content://media/${displayName}`,
    displayName,
    mimeType,
    size: 100,
  };
}

describe('pairPickedMedia', () => {
  it('pairs supported still images with same-basename MOV files and drops the MOV task', () => {
    const result = pairPickedMedia([
      media('IMG_0001.MOV', 'video/quicktime'),
      media('IMG_0001.HEIC', 'image/heic'),
      media('orphan.mov', 'video/quicktime'),
      media('IMG_0002.HEIF', 'image/heif'),
      media('IMG_0002.mov', 'video/quicktime'),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ displayName: 'IMG_0001.HEIC' });
    expect(result[0]?.motion).toMatchObject({ displayName: 'IMG_0001.MOV', mimeType: 'video/quicktime' });
    expect(result[1]).toMatchObject({ displayName: 'IMG_0002.HEIF' });
    expect(result[1]?.motion?.displayName).toBe('IMG_0002.mov');
  });

  it('keeps an unmatched still and does not pair unsupported image extensions', () => {
    const result = pairPickedMedia([
      media('photo.tiff', 'image/tiff'),
      media('photo.mov', 'video/quicktime'),
      media('plain.jpg', 'image/jpeg'),
    ]);

    expect(result.map((item) => item.displayName)).toEqual(['photo.tiff', 'plain.jpg']);
    expect(result[0]?.motion).toBeUndefined();
  });
});
