// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ApiClient } from '../../app/api';
import { I18nProvider } from '../../app/I18nProvider';
import ShareDialog from './ShareDialog';

it('opens management filtered to the shared resource', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  await act(async () => { root.render(<I18nProvider><ShareDialog api={{} as ApiClient} resource={{ type: 'folder', id: 'f/1', name: 'Album' }} onClose={onClose} /></I18nProvider>); });
  const manage = [...container.querySelectorAll('button')].find((item) => item.textContent === '管理已有分享');
  await act(async () => { manage?.click(); });
  expect(onClose).toHaveBeenCalledOnce();
  expect(window.location.hash).toBe('#/settings?resource_type=folder&resource_id=f%2F1');
  act(() => root.unmount());
  container.remove();
  window.history.replaceState(null, '', '#/');
});
