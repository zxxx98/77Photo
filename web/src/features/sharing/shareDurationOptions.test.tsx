import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../app/api';
import ShareDialog from './ShareDialog';

describe('share duration controls', () => {
  it('renders one mutually exclusive radio per duration without button wrappers', () => {
    const markup = renderToStaticMarkup(
      <ShareDialog
        api={{} as ApiClient}
        resource={{ type: 'photo', id: 'photo-1', name: 'Memory.jpg' }}
        onClose={() => {}}
      />,
    );
    const durationStart = markup.indexOf('share-duration-list');
    const passwordStart = markup.indexOf('share-password-field');
    const durationMarkup = markup.slice(durationStart, passwordStart);

    expect(markup.match(/type="radio"/g) ?? []).toHaveLength(3);
    expect(markup).not.toContain('type="checkbox"');
    expect(durationMarkup.match(/name="share-duration"/g) ?? []).toHaveLength(3);
    expect(durationMarkup).toContain('<label');
    expect(durationMarkup).not.toContain('<button');
  });
});
