import { callIftree, hasIftreeMethod } from './iftree-api.js';
import { readDatabase } from './database-client.js';
import type { ContentSearchResult } from '../../backend/query-api.js';
import { getUiMessages } from '../../lang/ui.js';

type OperationPayload = Record<string, unknown>;

export interface VectorContentSearchPayload {
  docId: string;
  query: string;
  limit?: number;
}

export type ContentSearchMode = 'keyword' | 'vector';

export interface ContentSearchPayload extends VectorContentSearchPayload {
  mode: ContentSearchMode;
}

export interface VectorContentSearchItem {
  node_id: string;
  doc_id: string;
  text: string;
  score: number;
  address: string | null;
}

export const importService = {
  canImportLibraryDocument() {
    return hasIftreeMethod('importLibraryDocument');
  },

  async importLibraryDocument(payload: OperationPayload) {
    return normalizeImportResults(await callIftree('importLibraryDocument', payload));
  },

  // 智能导入：后端只回「发给 agent 的任务」（prompt + 建议档位），调用方据此发起 agent 会话。
  smartImportTask(payload: OperationPayload) {
    return callIftree('smartImportTask', payload);
  },

  async chooseImportFile(payload: OperationPayload) {
    if (!hasIftreeMethod('chooseImportFile')) return chooseAndUploadBrowserFiles(payload);
    const selection = await callIftree('chooseImportFile', payload) as { filePaths?: string[] } | unknown;
    if (selection && typeof selection === 'object' && Array.isArray((selection as { filePaths?: string[] }).filePaths)) {
      return normalizeImportResults(await callIftree('importLocalFiles', {
        ...payload,
        filePaths: (selection as { filePaths: string[] }).filePaths
      }));
    }
    return normalizeImportResults(selection);
  }
};

function normalizeImportResults(value: unknown): Array<{ doc: Record<string, unknown> }> {
  const raw = Array.isArray(value) ? value : [value];
  const rows: Array<{ doc: Record<string, unknown> }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const imported = Array.isArray(record.imported) ? record.imported : [record];
    for (const entry of imported) {
      if (!entry || typeof entry !== 'object') continue;
      const doc = entry as Record<string, unknown>;
      const id = doc.docId ?? doc.id;
      if (id) rows.push({ doc: { ...doc, id } });
    }
  }
  return rows;
}

async function chooseAndUploadBrowserFiles(payload: OperationPayload) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.chm,.txt,.md,.pdf,.docx';
  const files = await new Promise<File[]>((resolveFiles) => {
    input.addEventListener('change', () => resolveFiles(Array.from(input.files || [])), { once: true });
    input.click();
  });
  const results: unknown[] = [];
  for (const file of files) {
    const query = new URLSearchParams({ name: file.name });
    if (payload.mode) query.set('mode', String(payload.mode));
    const response = await fetch(`/api/import-upload?${query}`, { method: 'POST', body: file });
    const body = await response.json() as { ok?: boolean; result?: unknown; error?: unknown };
    if (!response.ok || body.ok === false) throw new Error(String(body.error || getUiMessages().notices.importFailed(file.name)));
    results.push(body.result);
  }
  return normalizeImportResults(results);
}

export const vectorService = {
  chooseLocalModelRoot() {
    if (!hasIftreeMethod('chooseLocalModelRoot')) {
      const path = window.prompt(getUiMessages().notices.localModelDirectoryPrompt, '')?.trim() || '';
      return path ? callIftree('saveVectorSettings', { localModelRoot: path }) : callIftree('readVectorSettings');
    }
    return callIftree('chooseLocalModelRoot').then((result) => {
      const path = result && typeof result === 'object' ? String((result as { path?: unknown }).path || '') : '';
      return path ? callIftree('saveVectorSettings', { localModelRoot: path }) : callIftree('readVectorSettings');
    });
  },

  async downloadVectorModel() {
    let downloadRoot = '';
    if (hasIftreeMethod('chooseLocalModelRoot')) {
      const selection = await callIftree('chooseLocalModelRoot') as { path?: unknown };
      downloadRoot = String(selection?.path || '');
      if (!downloadRoot) return callIftree('readVectorSettings');
    }
    return callIftree('downloadVectorModel', downloadRoot ? { downloadRoot } : {});
  },

  async searchContent(payload: ContentSearchPayload): Promise<VectorContentSearchItem[]> {
    const result = await readDatabase({
      action: 'content.search',
      searchMode: payload.mode,
      ...payload
    }) as ContentSearchResult;
    return result.rows.map((row) => ({
      node_id: row.id,
      doc_id: row.docId,
      text: row.textPreview || row.text || '',
      score: row.score ?? 0,
      address: row.address || null
    }));
  },

  searchContentByVector(payload: VectorContentSearchPayload): Promise<VectorContentSearchItem[]> {
    return this.searchContent({ ...payload, mode: 'vector' });
  }
};

export const summaryService = {
  canGenerateNodeSummary() {
    return hasIftreeMethod('generateNodeSummary');
  },

  generateNodeSummary(payload: OperationPayload) {
    return callIftree('generateNodeSummary', payload);
  },

  cancelNodeSummary(payload: OperationPayload) {
    return callIftree('cancelNodeSummary', payload);
  }
};
