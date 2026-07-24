// 编辑分支重放阶段（L2）：落库节点备注/类型、引用和实体 entry。

import { normalizePositiveId } from '../db/normalizers.js';
import type { EditBranchRow } from '../db/schema.js';
import { isBuiltInEditBranchEntry, type EditBranchEntry } from './edit-branch-contract.js';
import type { EditBranchStore } from './edit-branch.js';

type RowObject = Record<string, unknown>;
type EditBranchDiff = RowObject & { entries?: EditBranchEntry[] };
type IdRow = { id: string };

function activeEntries(store: EditBranchStore, entries: unknown): EditBranchEntry[] {
  return store.requireEditBranchPort().activeEditBranchEntries(entries) as EditBranchEntry[];
}

export function applyEditBranchDiffEntries(store: EditBranchStore, branch: EditBranchRow, diff: EditBranchDiff = {}) {
  const entries = activeEntries(store, diff.entries);
  const baseDocId = normalizePositiveId(branch.base_doc_id);
  const refIdByTmp = new Map<string, string>();
  const entityIdByTmp = new Map<string, string>();

  const resolveStableId = (ref: unknown, kind: string) => {
    const id = normalizePositiveId(ref);
    if (!id) throw new Error(`apply: invalid ${kind} id ${ref}`);
    return id;
  };
  const resolveNodeId = (ref: unknown) => resolveStableId(ref, 'node');
  const resolveRefId = (ref: unknown) => {
    if (store.requireEditBranchPort().isTmpId(ref)) {
      const real = refIdByTmp.get(ref);
      if (!real) throw new Error(`apply: unresolved tmp ref id ${ref}`);
      return real;
    }
    return resolveStableId(ref, 'ref');
  };
  const resolveEntityId = (ref: unknown) => {
    if (store.requireEditBranchPort().isTmpId(ref)) {
      const real = entityIdByTmp.get(ref);
      if (!real) throw new Error(`apply: unresolved tmp entity id ${ref}`);
      return real;
    }
    return resolveStableId(ref, 'entity');
  };

  for (const entry of entries) {
    if (!store.requireEditBranchPort().isSupportedEditBranchEntryKind(entry?.kind)) {
      throw new Error(`Unsupported edit branch diff entry: ${entry?.kind || ''}`);
    }
    if (!isBuiltInEditBranchEntry(entry)) {
      const applied = store.requireExternalEntryPort().applyExternalEntry(
        store,
        entry,
        { resolveEntityId, resolveNodeId, entityIdByTmp, baseDocId }
      );
      if (!applied) throw new Error(`Unhandled edit branch diff entry kind: ${String(entry.kind || '')}`);
      continue;
    }
    switch (entry.kind) {
      case 'node.update':
        store.updateNode(resolveNodeId(entry.node_id), entry.patch as RowObject);
        break;
      case 'ref.addNodeToNode': {
        const created = store.addNodeRefToNode({
          docId: baseDocId,
          sourceNodeId: resolveNodeId(entry.source_ref),
          targetNodeId: resolveNodeId(entry.target_ref),
          refKind: entry.ref_kind,
          note: entry.note ?? null
        }) as IdRow;
        if (entry.tmp_id) refIdByTmp.set(entry.tmp_id, created.id);
        break;
      }
      case 'ref.delete':
        store.deleteRef(resolveRefId(entry.ref_ref));
        break;
    }
  }
}
