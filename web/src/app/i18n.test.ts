import { describe, expect, it } from 'vitest';
import { formatCount, formatDate, readStoredLocale, setStoredLocale, translate, type LocaleStorage } from './i18n';

function memoryStorage(initial: Record<string, string> = {}): LocaleStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('internationalization core', () => {
  it('defaults to simplified Chinese when storage is empty', () => {
    expect(readStoredLocale(memoryStorage())).toBe('zh');
  });

  it('rejects unsupported stored locales', () => {
    const storage = memoryStorage({ '77photo.locale': 'fr' });

    expect(readStoredLocale(storage)).toBe('zh');
  });

  it('persists English and interpolates dynamic text', () => {
    const storage = memoryStorage();

    expect(setStoredLocale(storage, 'en')).toBe('en');
    expect(readStoredLocale(storage)).toBe('en');
    expect(translate('en', 'gallery.loaded', { count: 3 })).toBe('3 loaded');
    expect(translate('zh', 'gallery.loaded', { count: 3 })).toBe('已加载 3 张');
  });

  it('formats dates and counts with the selected locale', () => {
    const date = '2026-09-13T12:34:00.000Z';

    expect(formatCount('zh', 1234)).toBe('1,234');
    expect(formatCount('en', 1234)).toBe('1,234');
    expect(formatDate('en', date)).toContain('2026');
    expect(formatDate('zh', date)).toContain('2026');
  });

  it('does not throw when persistence is unavailable', () => {
    const storage: LocaleStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };

    expect(readStoredLocale(storage)).toBe('zh');
    expect(setStoredLocale(storage, 'en')).toBe('en');
  });
});
