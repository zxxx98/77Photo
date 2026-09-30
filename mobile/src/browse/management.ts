import {ApiError} from '../auth/api';
import type {BatchResult} from './api';

export function operationError(error: unknown): string {
  const code = typeof error === 'string' ? error : error instanceof ApiError ? error.code : '';
  const messages: Record<string, string> = {
    NAME_CONFLICT: '目标目录存在同名文件，可选择自动改名后重试',
    WRITE_FORBIDDEN: '没有操作权限，或目标目录不属于照片所有者',
    READ_FORBIDDEN: '没有查看权限', FORBIDDEN: '没有操作权限',
    NOT_FOUND: '照片或目录已不存在，请刷新后重试',
    MAINTENANCE_IN_PROGRESS: '服务器正在维护，请稍后重试',
    TRASH_RECOVERY_REQUIRED: '文件操作尚未完成，请在回收站中重试处理',
    SOURCE_CHANGED: '源文件已变化，请刷新后重试',
    AUTH_REQUIRED: '登录已失效，请重新登录', ADMIN_REQUIRED: '当前人物功能仅对管理员开放',
    FACES_DISABLED: '服务器尚未启用人脸识别', FACE_CONFLICT: '人物已被其他操作修改，请刷新后重试', FACE_REQUEST_FAILED: '人物加载失败，请稍后重试',
    REQUEST_UNCERTAIN: '连接中断，操作结果未确认。请刷新核对后再重试',
  };
  if (messages[code]) {return messages[code];}
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {return messages.REQUEST_UNCERTAIN;}
  return error instanceof Error ? error.message : '操作失败，请重试';
}

// Keep successes from earlier chunks if a later response is lost. Do not replay.
export async function runBatches(ids: string[], operation: (chunk: string[]) => Promise<BatchResult>): Promise<BatchResult> {
  const result: BatchResult = {completed_ids: [], failed: []};
  const unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += 500) {
    try {
      const batch = await operation(unique.slice(offset, offset + 500));
      result.completed_ids.push(...batch.completed_ids);
      result.failed.push(...batch.failed);
      if (batch.failed.some(failure => failure.code === 'REQUEST_UNCERTAIN' || failure.code === 'AUTH_REQUIRED')) {
        result.failed.push(...unique.slice(offset + 500).map(id => ({id, code: 'REQUEST_UNCERTAIN'})));
        break;
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'REQUEST_UNCERTAIN';
      result.failed.push(...unique.slice(offset).map(id => ({id, code})));
      break;
    }
  }
  return result;
}

export function dateBoundary(value: string, nextDay = false): string | undefined {
  if (!value) {return undefined;}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {throw new Error('日期格式应为 YYYY-MM-DD');}
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) {throw new Error('请输入有效日期');}
  if (nextDay) {date.setDate(date.getDate() + 1);}
  return date.toISOString();
}

export async function moveSelected(ids: string[], move: (id: string) => Promise<unknown>): Promise<BatchResult> {
  const result: BatchResult = {completed_ids: [], failed: []};
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    try {await move(id); result.completed_ids.push(id);}
    catch (error) {
      if (!(error instanceof ApiError) || error.status === 401) {
        result.failed.push(...ids.slice(index).map(value => ({id: value, code: error instanceof ApiError ? error.code : 'REQUEST_UNCERTAIN'})));
        break;
      }
      result.failed.push({id, code: error.code});
    }
  }
  return result;
}
