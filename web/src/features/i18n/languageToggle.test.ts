import { describe, expect, it } from 'vitest';
import { languageToggleLabel, nextLocale } from './languageToggle';

describe('language toggle', () => {
  it('offers the other language as the action', () => {
    expect(nextLocale('zh')).toBe('en');
    expect(nextLocale('en')).toBe('zh');
  });

  it('describes the language switch accessibly', () => {
    expect(languageToggleLabel('zh')).toBe('切换到 English');
    expect(languageToggleLabel('en')).toBe('Switch to 中文');
  });
});
