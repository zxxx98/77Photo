// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../app/auth';
import { I18nProvider } from '../../app/I18nProvider';
import SetupPage from './SetupPage';

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('first-run setup page', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function createStore() {
    const setupAdmin = vi.fn().mockResolvedValue({ user: { id: 'u1', username: 'owner', role: 'admin', is_active: true }, csrf_token: 'csrf' });
    const api = { me: vi.fn(), setupStatus: vi.fn(), setupAdmin, login: vi.fn(), logout: vi.fn() };
    return { store: new SessionStore(api), setupAdmin };
  }

  async function renderPage(store: SessionStore) {
    await act(async () => { root.render(<I18nProvider><SetupPage store={store} /></I18nProvider>); });
  }

  it('renders the custom administrator fields and password guidance', async () => {
    const { store } = createStore();
    await renderPage(store);

    expect(container.querySelector('.setup-page')).not.toBeNull();
    expect(container.querySelectorAll('input')).toHaveLength(3);
    expect(container.textContent).toContain('创建管理员');
    expect(container.textContent).toContain('至少 12 个字符');
  });

  it('blocks short and mismatched passwords before calling the API', async () => {
    const { store, setupAdmin } = createStore();
    await renderPage(store);
    const [username, password, confirmation] = [...container.querySelectorAll<HTMLInputElement>('input')];

    await act(async () => {
      setInput(username!, ' owner ');
      setInput(password!, 'too short');
      setInput(confirmation!, 'too short');
      container.querySelector<HTMLFormElement>('form')?.requestSubmit();
    });
    expect(setupAdmin).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('至少 12 个字符');

    await act(async () => {
      setInput(password!, 'correct horse battery staple');
      setInput(confirmation!, 'different password');
      container.querySelector<HTMLFormElement>('form')?.requestSubmit();
    });
    expect(setupAdmin).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('两次输入的密码不一致');
  });

  it('submits a trimmed username with matching valid credentials', async () => {
    const { store, setupAdmin } = createStore();
    await renderPage(store);
    const [username, password, confirmation] = [...container.querySelectorAll<HTMLInputElement>('input')];

    await act(async () => {
      setInput(username!, ' owner ');
      setInput(password!, 'correct horse battery staple');
      setInput(confirmation!, 'correct horse battery staple');
      container.querySelector<HTMLFormElement>('form')?.requestSubmit();
      await Promise.resolve();
    });

    expect(setupAdmin).toHaveBeenCalledWith('owner', 'correct horse battery staple');
    expect(store.snapshot.status).toBe('authenticated');
  });
});
