import { act, renderHook } from '@testing-library/react-native';

import { DEFAULT_LAN_CIDRS } from './policy';
import { connectionStore, useEnabledLANCIDRs } from './store';

describe('useEnabledLANCIDRs', () => {
  it('keeps a stable snapshot while updating when the LAN settings change', async () => {
    const originalBuiltIn = connectionStore.getState().builtInCIDREnabled;
    const originalManual = connectionStore.getState().manualCIDRs;
    const originalConcurrency = connectionStore.getState().uploadConcurrency;
    const { result, rerender, unmount } = await renderHook(() => useEnabledLANCIDRs());

    try {
      const initial = result.current;
      await rerender({});
      expect(result.current).toBe(initial);

      await act(async () => {
        connectionStore.setState({
          builtInCIDREnabled: { ...originalBuiltIn, [DEFAULT_LAN_CIDRS[0]]: false },
        });
      });
      expect(result.current).not.toContain(DEFAULT_LAN_CIDRS[0]);
      expect(result.current).not.toBe(initial);

      const updated = result.current;
      await act(async () => {
        connectionStore.setState({ uploadConcurrency: 3 });
      });
      expect(result.current).toBe(updated);
    } finally {
      await unmount();
      connectionStore.setState({
        builtInCIDREnabled: originalBuiltIn,
        manualCIDRs: originalManual,
        uploadConcurrency: originalConcurrency,
      });
    }
  });
});
