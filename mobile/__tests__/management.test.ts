import {ApiError} from '../src/auth/api';
import {dateBoundary, moveSelected, operationError, runBatches} from '../src/browse/management';

test('validates real calendar dates and includes the end day in local time', () => {
  expect(dateBoundary('')).toBeUndefined();
  expect(() => dateBoundary('2026-02-29')).toThrow('有效日期');
  expect(() => dateBoundary('2026-2-01')).toThrow('YYYY-MM-DD');
  expect(dateBoundary('2024-02-29', true)).toBe(new Date(2024, 2, 1).toISOString());
  expect(dateBoundary('2026-12-31', true)).toBe(new Date(2027, 0, 1).toISOString());
});

test('chunks at the server limit, deduplicates IDs and preserves per-item failures', async () => {
  const ids = Array.from({length: 502}, (_, index) => String(index));
  const operation = jest.fn(async (chunk: string[]) => ({completed_ids: chunk.filter(id => id !== '1'), failed: chunk.includes('1') ? [{id: '1', code: 'WRITE_FORBIDDEN'}] : []}));
  const result = await runBatches([...ids, '1'], operation);
  expect(operation.mock.calls.map(([chunk]) => chunk.length)).toEqual([500, 2]);
  expect(result.completed_ids).toHaveLength(501);
  expect(result.failed).toEqual([{id: '1', code: 'WRITE_FORBIDDEN'}]);
});

test('a lost later response retains earlier successes without replay or more writes', async () => {
  const ids = Array.from({length: 1002}, (_, index) => String(index));
  const operation = jest.fn().mockResolvedValueOnce({completed_ids: ids.slice(0, 500), failed: []}).mockRejectedValueOnce(new TypeError('network'));
  const result = await runBatches(ids, operation);
  expect(operation).toHaveBeenCalledTimes(2);
  expect(result.completed_ids).toHaveLength(500);
  expect(result.failed).toHaveLength(502);
  expect(result.failed[0]).toEqual({id: '500', code: 'REQUEST_UNCERTAIN'});
});

test('moves continue past explicit name conflicts but stop at a lost response', async () => {
  const move = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new ApiError(409, 'NAME_CONFLICT', 'conflict'))
    .mockRejectedValueOnce(new TypeError('network'));
  const result = await moveSelected(['a', 'b', 'c', 'd'], move);
  expect(move).toHaveBeenCalledTimes(3);
  expect(result).toEqual({completed_ids: ['a'], failed: [
    {id: 'b', code: 'NAME_CONFLICT'}, {id: 'c', code: 'REQUEST_UNCERTAIN'}, {id: 'd', code: 'REQUEST_UNCERTAIN'},
  ]});
});

test('a mutation requiring login stops remaining moves', async () => {
  const move = jest.fn().mockRejectedValue(new ApiError(401, 'AUTH_REQUIRED', 'expired'));
  expect((await moveSelected(['a', 'b'], move)).failed).toHaveLength(2);
  expect(move).toHaveBeenCalledTimes(1);
  expect(operationError('NAME_CONFLICT')).toContain('自动改名');
  expect(operationError(new TypeError('network'))).toContain('刷新核对');
});
