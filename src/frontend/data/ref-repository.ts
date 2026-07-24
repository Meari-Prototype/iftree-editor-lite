import { writeDatabase } from './database-client.js';

// 字段宽松：IPC 边界，调用方不必先 cast。
interface DeleteRefPayload {
  docId?: unknown;
  refId?: unknown;
}

export const refRepository = {
  async deleteRef(payload: DeleteRefPayload) {
    const result = await writeDatabase({ action: 'ref.delete', ...(payload || {}) });
    return result?.doc || result;
  }
};
