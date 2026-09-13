import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../app/I18nProvider';
import FolderEmptyState from './FolderEmptyState';

describe('folder empty state', () => {
  it('offers upload and folder creation with the photo-stack visual', () => {
    const markup = renderToStaticMarkup(<I18nProvider><FolderEmptyState onUpload={vi.fn()} onCreateFolder={vi.fn()} /></I18nProvider>);

    expect(markup).toContain('folder-empty-photo-stack');
    expect(markup).toContain('上传照片');
    expect(markup).toContain('新建文件夹');
    expect(markup.match(/<button/g) ?? []).toHaveLength(2);
  });
});
