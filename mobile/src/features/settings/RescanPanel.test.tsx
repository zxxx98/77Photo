import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { ApiError } from '../../services/api/client';
import type { RescanJob } from '../../services/api/types';
import { RescanPanel } from './RescanPanel';

const runningJob: RescanJob = {
  id: 'job-1',
  status: 'running',
  started_at: '2026-09-15T00:00:00Z',
  finished_at: null,
  counts: { scanned: 4, added: 1, updated: 1, missing: 0, failed: 0 },
  error: null,
};

describe('RescanPanel', () => {
  it('resumes observing an existing job when the server supplies its ID', async () => {
    const api = {
      startRescan: jest.fn(async () => {
        throw new ApiError(409, 'RESCAN_IN_PROGRESS', 'busy', 'request-1', { job_id: 'job-1' });
      }),
      getRescan: jest.fn(async () => runningJob),
    };
    const view = await render(<RescanPanel api={api} />);

    await act(async () => {
      fireEvent.press(view.getByRole('button', { name: '开始扫描' }));
    });
    await waitFor(() => expect(api.getRescan).toHaveBeenCalledWith('job-1'));
    expect(view.getByText('扫描状态：running')).toBeTruthy();
  });
});
