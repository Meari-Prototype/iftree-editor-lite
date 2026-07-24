// L4 分支差异视图：组合 projection、diff 与 entities 三个 L3 域。

import { normalizePositiveId } from '../../db/normalizers.js';
import type { EditBranchRow, RefRow } from '../../db/schema.js';
import { activeEditBranchEntries, undoneEditBranchEntries } from '../../projection/edit-branch-projection.js';
import type { EditBranchEntry, ProjectionNode } from '../../store/edit-branch-contract.js';
import { buildEditBranchDiffRows } from '../../diff/diff-view.js';
import { buildEntityEditBranchDiffEntries } from '../../entities/write.js';
import type { IftreeStore } from '../../store/index.js';

type RowObject = Record<string, unknown>;
type EditBranchStore = IftreeStore;
type EditBranchPayload = RowObject;
type EditBranchDiff = RowObject & { entries?: EditBranchEntry[] };
type BranchLookupPayload = { docId?: unknown };
type TitleRow = { id: string; title: string };
type HistoryState = { undoDepth: number; redoDepth: number };
type BaseDocInputs = { nodes: ProjectionNode[]; refs: RefRow[] };

function rowObject(row: object): RowObject {
  return { ...row };
}

export function getEditBranchDiffView(store: EditBranchStore, { docId: requestedDocId = null, changedOnly = false, includeEntities = false }: EditBranchPayload = {}) {
    const branch = store.findEditBranch({ docId: requestedDocId } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) throw new Error('Edit branch not found');
    const docId = normalizePositiveId(branch.base_doc_id);
    if (!docId) throw new Error('Edit branch base doc not found');
    const baseDoc = store.db!.prepare('SELECT id, title FROM docs WHERE id = ?').get<TitleRow>(docId);
    if (!baseDoc) throw new Error('Edit branch base doc not found');
    const { nodes: baseNodes, refs: baseRefs }: BaseDocInputs = store.editBranchBaseInputs(docId);
    const diff = JSON.parse(branch.diff || '{}') as EditBranchDiff;
    const entries = Array.isArray(diff.entries) ? diff.entries : [];
    const active = activeEditBranchEntries(entries) as EditBranchEntry[];
    const projected = store.requireEditBranchPort().projectEditBranchDoc({
      docId,
      nodes: baseNodes,
      refs: baseRefs
    }, active);
    const baseHashes = store.ensureNodeHashes(docId);
    const { rows, stats } = buildEditBranchDiffRows(
      baseNodes.map(rowObject),
      projected.nodes.map(rowObject),
      baseHashes
    );
    const historyState = store.editBranchHistoryState(branch) as HistoryState;

    let outRows = rows;
    if (changedOnly) {
      // 只返改动行（agent/MCP/db 外壳消费路径，projectneed 18-1）：丢掉未改动上下文行与
      // 折叠占位行（含其 hiddenRows 全文），只留 added/deleted/modified。GUI 对比弹窗不传
      // changedOnly，仍拿完整折叠/展开结构。
      outRows = outRows.filter((row) => row.status !== 'unchanged' && row.status !== 'collapsed');
    }

    // entries：草稿↔正文的 field-diff（与 rows 富视图并存），供 formatDiffText 详略轴渲染、与 diff.refs/history.diff 同形。
    const diffEntries: RowObject[] = store.computeDiff(
      { nodes: baseNodes.map(rowObject), refs: baseRefs.map(rowObject) },
      {
        nodes: projected.nodes.map(rowObject),
        refs: projected.refs.map(rowObject)
      }
    ).map(rowObject);
    const addrByNode = new Map<unknown, unknown>();
    for (const n of projected.nodes) addrByNode.set(n.id, n.address);
    for (const n of baseNodes) if (!addrByNode.has(n.id)) addrByNode.set(n.id, n.address);
    for (const e of diffEntries) if (e && e.node_id != null && e.address == null) e.address = addrByNode.get(e.node_id) ?? null;

    // 实体改动默认不进 diff（绑定动辄上千、会淹没正文 diff）；diff entity=true 时按动作流追加实体行。
    if (includeEntities) {
      for (const entry of buildEntityEditBranchDiffEntries(store, active, addrByNode)) {
        diffEntries.push(entry);
      }
    }

    return {
      kind: 'editBranch.diffView',
      entries: diffEntries,
      branch: { ...branch },
      baseDoc: { ...baseDoc },
      projectedDoc: {
        id: branch.base_doc_id,
        baseDocId: branch.base_doc_id,
        title: baseDoc.title
      },
      stats: {
        ...stats,
        activeEntryCount: active.length,
        undoneEntryCount: undoneEditBranchEntries(entries).length,
        undoDepth: historyState.undoDepth,
        redoDepth: historyState.redoDepth,
        changedOnly
      },
      rows: outRows
    };
  }
