// 编辑分支 diff 的视图渲染层——从主库存储类剥离。
// 职责：把基线/投影节点树分类成差异行、折叠未改动子树成占位行、统计各状态计数、把节点行转成
// 客户端 camelCase 别名。纯函数、零状态、不碰 db。
import { classifyTreeDiff } from '../../core/merkle-diff.js';
import type { NodeRow } from '../db/schema.js';

type DiffRow = Record<string, unknown>;
interface DiffItem {
  row: DiffRow;
  children: DiffItem[];
  hasChangedDescendant?: boolean;
}
type DiffStats = Record<string, number> & {
  added: number;
  deleted: number;
  modified: number;
  moved: number;
  unchanged: number;
  collapsed: number;
  visibleRows: number;
  totalRows: number;
};
const classifyTreeDiffTyped = classifyTreeDiff as unknown as (
  baseNodes: DiffRow[],
  projectedNodes: DiffRow[],
  options?: Record<string, unknown>
) => { roots: DiffItem[]; items: DiffItem[] };

// 节点行 → 客户端 camelCase 别名（doc_id→docId 等）。编辑分支暂存方法（store 内）与下面的 diff
// 渲染共用：两者返回的都是「编辑分支节点的客户端形态」，故落在本模块单点维护。
export function nodeRowWithClientAliases(row: DiffRow | NodeRow | null | undefined) {
  if (!row) return row;
  return {
    ...row,
    docId: row.doc_id,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    nodeType: row.node_type,
    note: row.node_note || '',
    nodeNote: row.node_note || '',
    trustLevel: row.trust_level ?? null,
    sourcePosition: row.source_position ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null
  };
}

function editBranchDiffNode(row: DiffRow | null | undefined) {
  if (!row) return null;
  const node = nodeRowWithClientAliases(row);
  return {
    ...node,
    childCount: Math.max(0, Number(row.child_count) || 0)
  };
}

function flattenDiffTreeItem(item: DiffItem): DiffRow[] {
  const rows = [{ ...item.row }];
  for (const child of item.children) rows.push(...flattenDiffTreeItem(child));
  return rows;
}

function diffHiddenNodeCount(items: DiffItem[]) {
  return items.reduce((sum: number, item: DiffItem) => sum + flattenDiffTreeItem(item).length, 0);
}

export function buildEditBranchDiffRows(baseNodes: DiffRow[] = [], projectedNodes: DiffRow[] = [], baseHashes: unknown = null) {
  const { roots, items } = classifyTreeDiffTyped(baseNodes, projectedNodes, baseHashes ? { baseHashes } : {});
  const stats: DiffStats = {
    added: 0,
    deleted: 0,
    modified: 0,
    moved: 0,
    unchanged: 0,
    collapsed: 0,
    visibleRows: 0,
    totalRows: 0
  };
  // 仅位置/父级变更（sort_order/parent_id）从 modified 拆出单列 moved，与 diff summary 的「移」口径对齐
  // （否则 move/reparent 挤动的邻居 sort_order 变化全算 modified，summary 报 2、stats 报 11 对不上）。
  const POSITION_ONLY_FIELDS = new Set(['sort_order', 'parent_id', 'address']);
  for (const item of items) {
    item.row.left = editBranchDiffNode(item.row.left as DiffRow | null | undefined);
    item.row.right = editBranchDiffNode(item.row.right as DiffRow | null | undefined);
    const fields = Array.isArray(item.row.changedFields) ? item.row.changedFields : [];
    if (item.row.status === 'modified' && fields.length > 0 && fields.every((f) => POSITION_ONLY_FIELDS.has(f))) {
      stats.moved += 1;
    } else {
      stats[String(item.row.status)] += 1;
    }
    stats.totalRows += 1;
  }

  function markChangedDescendants(item: DiffItem): boolean {
    let hasChangedDescendant = false;
    for (const child of item.children) {
      const childChanged = markChangedDescendants(child);
      hasChangedDescendant = hasChangedDescendant || childChanged;
    }
    item.hasChangedDescendant = hasChangedDescendant;
    return item.row.status !== 'unchanged' || hasChangedDescendant;
  }

  for (const root of roots) markChangedDescendants(root);

  function collapsedRowFor(items: DiffItem[]) {
    const hiddenRows = items.flatMap(flattenDiffTreeItem);
    const first = hiddenRows[0];
    const last = hiddenRows[hiddenRows.length - 1];
    return {
      kind: 'collapsed',
      key: `collapsed:${first?.address || ''}:${last?.address || ''}`,
      address: first?.address || '',
      depth: first?.depth || 1,
      status: 'collapsed',
      hiddenCount: hiddenRows.length,
      hiddenRows
    };
  }

  function renderItems(items: DiffItem[]): DiffRow[] {
    const rows: DiffRow[] = [];
    let pending: DiffItem[] = [];
    const flushPending = () => {
      if (pending.length === 0) return;
      const row = collapsedRowFor(pending);
      stats.collapsed += row.hiddenCount;
      rows.push(row);
      pending = [];
    };

    for (const item of items) {
      const canCollapse = Number(item.row.depth) > 1
        && item.row.status === 'unchanged'
        && !item.hasChangedDescendant;
      if (canCollapse) {
        pending.push(item);
        continue;
      }
      flushPending();
      rows.push({ ...item.row });
      rows.push(...renderItems(item.children));
    }
    flushPending();
    return rows;
  }

  const rows = renderItems(roots);
  stats.visibleRows = rows.length;
  stats.unchangedCollapsed = stats.collapsed;
  stats.hiddenRows = Math.max(0, diffHiddenNodeCount(roots) - rows.filter((row) => row.kind === 'node').length);
  return { rows, stats };
}
