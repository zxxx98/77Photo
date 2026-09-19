// @ts-expect-error This contract test reads the stylesheet from Vitest's Node runtime.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles/global.css', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped} \\{([^}]*)\\}`).exec(styles)?.[1] ?? '';
}

describe('app shell scrolling layout', () => {
  it('keeps navigation in the viewport while the content area scrolls', () => {
    expect(declarations('.app-frame')).toContain('height: 100svh;');
    expect(declarations('.app-frame')).toContain('overflow: hidden;');
    expect(declarations('.main-content')).toContain('min-height: 0;');
    expect(declarations('.content-scroll')).toContain('min-height: 0;');
    expect(declarations('.content-scroll')).toContain('flex: 1;');
  });
});
