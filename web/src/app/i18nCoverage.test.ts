import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('../app/App.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const appSource = Object.values(sources)[0] ?? '';

describe('translation coverage', () => {
  it('does not leave the previous shell and login literals behind', () => {
    expect(appSource).not.toContain('Private library');
    expect(appSource).not.toContain('Search your library');
    expect(appSource).not.toContain('Sign out');
  });
});
