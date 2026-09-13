import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import BrandMark from './BrandMark';

describe('BrandMark', () => {
  it('renders the Quiet Frame SVG without the old text fallback', () => {
    const markup = renderToStaticMarkup(<BrandMark />);

    expect(markup).toContain('<svg');
    expect(markup).toContain('viewBox="0 0 72 72"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('fill="#3d4a5c"');
    expect(markup).toContain('stroke="#faf9f7"');
    expect(markup).toContain('fill="#a8c5b8"');
    expect(markup).not.toContain('>77<');
  });
});
