import { existsSync } from 'node:fs';

import {
  normalizeStableId
} from '../../db/ids.js';
import {
  assertNoActiveEditBranch,
  docRefresh,
  docsRefresh,
  listDocs,
  maybeRefreshDoc,
  ownPatch,
  plain,
  requireDocId,
  requireId,
  type WriteContext
} from './shared.js';
import type { IftreeStore } from '../../store/index.js';

type WritePayload = Record<string, unknown>;

export function handleDocFolderMutation(store: IftreeStore, payload: WritePayload, action: string, effects: unknown[]) {
  if (action === 'docFolder.create') {
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('docFolder.create requires name');
    const folder = store.createDocFolder({
      name,
      parentId: payload.parentId ?? payload.parent_id ?? null
    });
    return docsRefresh(action, {
      folder: plain(folder),
      folders: store.listDocFolders().map(plain),
      sideEffects: effects
    });
  }

  if (action === 'docFolder.update') {
    const folderId = requireId(payload, 'folderId', 'folder_id');
    const folder = store.updateDocFolder(folderId, ownPatch(payload));
    return docsRefresh(action, {
      folder: plain(folder),
      folders: store.listDocFolders().map(plain),
      sideEffects: effects
    });
  }

  if (action === 'docFolder.delete') {
    const folderId = requireId(payload, 'folderId', 'folder_id');
    const changed = store.deleteDocFolder(folderId);
    return docsRefresh(action, {
      folderId,
      changed: Boolean(changed),
      folders: store.listDocFolders().map(plain),
      sideEffects: effects
    });
  }

  throw new Error(`Unhandled database_write action: ${action}`);
}

export async function handleDocMutation(store: IftreeStore, payload: WritePayload, ctx: WriteContext, action: string, effects: unknown[]) {
  if (action === 'doc.create') {
    const title = String(payload.title || '').trim();
    if (!title) throw new Error('doc.create requires title');
    const created = store.createDoc({
      title,
      rootText: payload.rootText ?? payload.root_text ?? title,
      meta: payload.meta ?? null,
      folderId: payload.folderId ?? payload.folder_id ?? null
    });
    const doc = maybeRefreshDoc(store, ctx, created.id, payload.refreshOptions || {});
    return docRefresh(action, created.id, { doc, created: plain(created), sideEffects: effects });
  }

  if (action === 'doc.moveToFolder') {
    const docId = requireDocId(payload);
    const changed = store.moveDocToFolder({
      docId,
      folderId: payload.folderId ?? payload.folder_id ?? null
    });
    return docsRefresh(action, { docId, changed: Boolean(changed), docs: listDocs(store), sideEffects: effects });
  }

  if (action === 'doc.delete') {
    const docId = requireDocId(payload);
    assertNoActiveEditBranch(store, docId);
    const changed = store.deleteDoc(docId);
    return docsRefresh(action, { docId, changed: Boolean(changed), docs: listDocs(store), sideEffects: effects });
  }

  if (action === 'editBranch.begin') {
    const docId = requireDocId(payload);
    const branch = store.beginEditBranch(docId);
    const doc = payload.includeDoc === false ? null : maybeRefreshDoc(store, ctx, branch.base_doc_id, payload.refreshOptions || {});
    return docRefresh(action, branch.base_doc_id, {
      baseDocId: branch.base_doc_id,
      branch: plain(branch),
      doc,
      sideEffects: effects
    });
  }

  if (action === 'editBranch.save') {
    const result = store.saveEditBranch({
      docId: requireDocId(payload),
      summary: payload.summary || '定稿'
    });
    const doc = payload.includeDoc === false
      ? null
      : maybeRefreshDoc(store, ctx, result.baseDocId, payload.refreshOptions || {});
    // 派生索引不在 handler 维护：落主干后由写分发收尾维护。touched/deleted/vectorStale 不进响应，
    // 收进 derivedSync 供 mutation-api 做 BM25 增量同步、读后剥离（4-6-2）。
    const { touchedNodeIds = [], deletedNodeIds = [], vectorStaleNodeIds = [], history: resultHistory = null, ...resultForResponse }
      = result as Record<string, unknown>;
    return docRefresh(action, result.baseDocId, {
      ...resultForResponse,
      history: plain(resultHistory),
      doc,
      sideEffects: effects,
      derivedSync: { touchedNodeIds, deletedNodeIds, vectorStaleNodeIds }
    });
  }

  if (action === 'editBranch.discard') {
    const docId = requireDocId(payload);
    const branch = store.findEditBranch({ docId });
    const changed = store.discardEditBranch({ docId });
    const doc = payload.includeDoc === false
      ? null
      : (branch?.base_doc_id ? maybeRefreshDoc(store, ctx, branch.base_doc_id, payload.refreshOptions || {}) : null);
    return {
      ok: true,
      action,
      docId: branch?.base_doc_id ?? null,
      changed: Boolean(changed),
      refresh: { kind: 'doc', docId: branch?.base_doc_id ?? null },
      baseDocId: branch?.base_doc_id ?? null,
      doc,
      sideEffects: effects
    };
  }

  if (action === 'editBranch.undo' || action === 'editBranch.redo') {
    const run = action === 'editBranch.undo'
      ? store.undoEditBranchEntry.bind(store)
      : store.redoEditBranchEntry.bind(store);
    const result = run({ docId: requireDocId(payload) });
    const doc = payload.includeDoc === false
      ? null
      : maybeRefreshDoc(store, ctx, result.branch.base_doc_id, payload.refreshOptions || {});
    return docRefresh(action, result.branch.base_doc_id, {
      changed: Boolean(result.changed),
      baseDocId: result.branch.base_doc_id,
      branchId: result.branch.id,
      branch: plain(result.branch),
      undoDepth: result.undoDepth,
      redoDepth: result.redoDepth,
      doc,
      sideEffects: effects
    });
  }

  if (action === 'doc.refreshAddresses') {
    const rawDocId = payload.docId ?? payload.doc_id;
    const docId = normalizeStableId(rawDocId);
    if (docId) {
      const result = store.refreshDocAddresses(docId);
      return docRefresh(action, docId, { result: plain(result), sideEffects: effects });
    }
    const result = store.refreshAllAddresses();
    return docsRefresh(action, { result: plain(result), sideEffects: effects });
  }

  if (action === 'treeView.update') {
    const docId = requireDocId(payload);
    const doc = store.updateDocTreeViewState(docId, payload.state || {});
    return {
      ok: true,
      action,
      docId,
      changed: true,
      refresh: { kind: 'doc_state', docId },
      doc: plain(doc),
      sideEffects: effects
    };
  }

  // doc.relink：把已导入 doc 重绑到新源文件路径（锚改名/迁移后用，full 档运维动词，
  // projectneed 15-10-4）。只改绑定（meta.sourcePath + source_documents.original_path），
  // 不动正文；source_type 缺省保留原值。
  if (action === 'doc.relink') {
    const docId = requireDocId(payload);
    const sourcePath = String(payload.sourcePath ?? payload.source_path ?? payload.path ?? '').trim();
    if (!sourcePath) throw new Error('doc.relink requires sourcePath');
    const current = store.db!.prepare('SELECT source_type FROM source_documents WHERE doc_id = ?').get(docId);
    const sourceType = payload.sourceType ?? payload.source_type ?? current?.source_type ?? 'md';
    const source = store.updateSourceBinding({ docId, sourcePath, sourceType });
    // 目标文件自检（不阻断）：relink 只改登记、不替外部程序维护其文件状态；但顺手报一句目标在不在，
    // 免得静默绑到不存在的路径。结果进 sideEffects，写入照常成功。
    effects.push({ effect: 'relink.targetCheck', ok: true, targetExists: existsSync(sourcePath), sourcePath });
    return docsRefresh(action, { docId, source: plain(source), docs: listDocs(store), sideEffects: effects });
  }

  throw new Error(`Unhandled database_write action: ${action}`);
}
