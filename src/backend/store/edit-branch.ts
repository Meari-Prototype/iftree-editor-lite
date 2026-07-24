// 编辑草稿子系统：节点备注/类型、引用、实体暂存 + 重放落库 + 撤销/重做。
// 每篇文档最多一条 active 草稿，正文写入在 L4 被草稿锁拦截，因此 commit 始终是纯快进。
// 实例作首参——store.db 与底座的主 CRUD / 快照提交原语经它访问，模块不反向 import 门面。
// index.mjs 上每个方法保留一行同名转调壳；编辑分支方法之间也经门面句柄互调（store.xxx），
// 与历史/记忆子系统同构（参数化 store、对外门面壳）。

import { normalizeNodeType } from '../../core/node-model.js';
import { contentHash, type MerkleNode } from '../../core/merkle.js';
import { parseJsonObject, hasOwnValue, assertNoHumanTagField, assertNoEditTrustField } from '../shared.js';
import { sameStableId } from '../db/ids.js';
import { normalizePositiveId, patchValue } from '../db/normalizers.js';
import type {
  EditBranchEntry,
  ProjectedDoc,
  ProjectionNode
} from './edit-branch-contract.js';
import { isBuiltInEditBranchEntry } from './edit-branch-contract.js';
import type Database from 'better-sqlite3';
import type { EditBranchProjectionPort, ExternalEntryPort } from './domain-port.js';
import * as history from './history.js';
import * as refStore from './ref.js';
import { applyEditBranchDiffEntries } from './edit-branch-replay.js';
export { applyEditBranchDiffEntries } from './edit-branch-replay.js';
import type {
  EditBranchRow,
  EditBranchTableRow,
  NodeRow,
  RefRow
} from '../db/schema.js';

type RowObject = Record<string, unknown>;
type EditBranchPayload = RowObject;
type BranchLookupPayload = {
  docId?: unknown;
};
type EditBranchDiff = RowObject & {
  entries?: EditBranchEntry[];
};
// ProjectedNode/ProjectedDocState 已下沉到 edit-branch-projection.ts，
// 与 ProjectionNode/ProjectedDoc 是同一套类型；此处只为本文件历史名引一下别名，
// 让大量旧 `as ProjectedNode` cast 不需要一次性 sed。新代码请直接用公共名。
type ProjectedNode = ProjectionNode;
type ProjectedDocState = ProjectedDoc;
type EditBranchBranchRow = EditBranchRow & {
  base_title?: string | null;
  node_count?: number;
};
type DocIdRow = { doc_id: string };
type BaseDocInputs = { docId: string; nodes: ProjectedNode[]; refs: RefRow[] };
type BranchCommitResult = RowObject & {
  changed: boolean;
  baseDocId: string;
  branchId: number;
  touchedNodeIds: unknown[];
  deletedNodeIds: unknown[];
  vectorStaleNodeIds: unknown[];
};
type NodeSignature = { keyword: string; text: string };
type CommitHistoryRow = { id: string; doc_id: string; commit_id: string; saved_at: string; summary: string | null };

export interface EditBranchStore extends history.HistoryStore {
  db: Database | null;
  addNodeRefToNode(payload: RowObject): unknown;
  deleteNodeSubtree(nodeId: unknown): boolean;
  deleteRef(refId: unknown): boolean;
  insertNode(payload: RowObject): NodeRow;
  mergeNodeIntoPreviousSibling(nodeId: unknown): boolean;
  mergeNodeIntoTarget(payload: RowObject): boolean;
  moveNode(nodeId: unknown, direction: unknown): boolean;
  moveNodeAfterSibling(payload: RowObject): boolean;
  moveNodeBeforeSibling(payload: RowObject): boolean;
  moveNodeToParent(payload: RowObject): boolean;
  promoteNode(nodeId: unknown): boolean;
  requireEditBranchPort(): EditBranchProjectionPort;
  requireExternalEntryPort(): ExternalEntryPort;
  splitNodeIntoChildren(nodeId: unknown): unknown;
  updateNode(nodeId: unknown, patch: RowObject): unknown;
  touchDoc(docId: unknown): void;
  withTransaction<T>(fn: () => T): T;
}

function activeEntries(store: EditBranchStore, entries: unknown): EditBranchEntry[] {
  return store.requireEditBranchPort().activeEditBranchEntries(entries);
}

function undoneEntries(store: EditBranchStore, entries: unknown): EditBranchEntry[] {
  return store.requireEditBranchPort().undoneEditBranchEntries(entries);
}

// ─── entries 子表存取 ──────────────────────────────────────────────────────
// 存储真相在 edit_branch_entries（一行一条，schema 有账）；edit_branches 无 diff 列。
// 行离开 SQL 的出口统一经 _withBranchEntries 把子表条目装配成 diff JSON——内部所有
// JSON.parse(branch.diff) 消费点、handler 返回、前端 undo 栈的契约全部原样工作。
// 收益在写侧：stage=INSERT 一行、undo/redo=翻转单行 status，不再整包重写（原先
// K 步编辑 O(K²) 写放大的根源）。

type BranchEntrySqlRow = { id: number; seq: number; status: string; created_at: string | null; undone_at: string | null; entry: string };

function branchEntrySqlRows(store: EditBranchStore, branchId: unknown): BranchEntrySqlRow[] {
  return store.db!.prepare(`
    SELECT id, seq, status, created_at, undone_at, entry
    FROM edit_branch_entries WHERE branch_id = ? ORDER BY seq
  `).all<BranchEntrySqlRow>(Number(branchId));
}

function entryRowToEntry(row: BranchEntrySqlRow): EditBranchEntry {
  const payload = JSON.parse(row.entry || '{}') as EditBranchEntry;
  const entry = { ...payload, status: row.status } as EditBranchEntry;
  if (row.created_at) entry.createdAt = row.created_at;
  if (row.undone_at) entry.undoneAt = row.undone_at;
  return entry;
}

// status/createdAt/undoneAt 提为列（排序/翻转靠它们），负载 JSON 里不留冗余副本。
function entryToRowFields(entry: EditBranchEntry) {
  const { status, createdAt, undoneAt, ...payload } = entry as unknown as Record<string, unknown>;
  return {
    status: status === 'undone' ? 'undone' : 'active',
    created_at: createdAt ? String(createdAt) : null,
    undone_at: undoneAt ? String(undoneAt) : null,
    payload: JSON.stringify(payload)
  };
}

export function _withBranchEntries<T extends EditBranchTableRow>(store: EditBranchStore, row: T | null): (T & { diff: string }) | null {
  if (!row) return null;
  const entries = branchEntrySqlRows(store, row.id).map(entryRowToEntry);
  return {
    ...row,
    diff: JSON.stringify({
      kind: 'edit_branch_diff',
      storage: 'entries_table',
      baseDocId: row.base_doc_id,
      updatedAt: row.updated_at,
      entries
    })
  };
}

function _branchRowById(store: EditBranchStore, branchId: unknown): EditBranchRow {
  const row = store.db!.prepare('SELECT * FROM edit_branches WHERE id = ?').get<EditBranchTableRow>(Number(branchId));
  return _withBranchEntries(store, row || null) as EditBranchRow;
}

/** @param {EditBranchEntry} entry edit-branch diff entry（kind/patch/fields 形态随动作而异） */
function editBranchEntryTouchesTrust(entry: EditBranchEntry) {
  if (!isBuiltInEditBranchEntry(entry)) return false;
  if (entry.kind === 'node.update') {
    if (hasOwnValue(entry.patch, 'trust_level', 'trustLevel', 'trust')) return true;
    return Array.isArray(entry.fields) && entry.fields.some((field) => (
      ['trust_level', 'trustLevel', 'trust'].includes(String(field.field || ''))
    ));
  }
  return false;
}

function hasEditBranchesTable(store: EditBranchStore) {
  try {
    return Boolean(store.db!.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edit_branches'").get());
  } catch {
    return false;
  }
}

export function activeEditBranchForBaseDoc(store: EditBranchStore, docId: unknown) {
    if (!hasEditBranchesTable(store)) return null;
    return _withBranchEntries(store, store.db!.prepare(`
      SELECT * FROM edit_branches
      WHERE base_doc_id = ?
      LIMIT 1
    `).get<EditBranchTableRow>(normalizePositiveId(docId)) || null);
  }

export function activeEditBranchForDoc(store: EditBranchStore, docId: unknown) {
    return activeEditBranchForBaseDoc(store, docId);
  }

export function listActiveEditBranches(store: EditBranchStore) {
    if (!hasEditBranchesTable(store)) return [];
    return store.db!.prepare(`
      SELECT eb.*,
        base.title AS base_title,
        (SELECT COUNT(*) FROM nodes n WHERE n.doc_id = eb.base_doc_id) AS node_count
      FROM edit_branches eb
      LEFT JOIN docs base ON base.id = eb.base_doc_id
      ORDER BY eb.updated_at DESC, eb.id DESC
    `).all<EditBranchTableRow & { base_title: string | null; node_count: number }>()
      .map((row) => _withBranchEntries(store, row) as EditBranchBranchRow);
  }

export function docIdForMutationPayload(store: EditBranchStore, payload: EditBranchPayload = {}) {
    const direct = normalizePositiveId(payload.docId ?? payload.doc_id ?? payload.baseDocId ?? payload.base_doc_id);
    if (direct !== null) return direct;
    const nodeId = normalizePositiveId(
      payload.nodeId
        ?? payload.node_id
        ?? payload.parentId
        ?? payload.parent_id
        ?? payload.sourceNodeId
        ?? payload.source_node_id
        ?? payload.targetNodeId
        ?? payload.target_node_id
    );
    if (nodeId !== null) {
      const node = store.db!.prepare('SELECT doc_id FROM nodes WHERE id = ?').get<DocIdRow>(nodeId);
      if (node) return node.doc_id;
    }
    const externalDocId = normalizePositiveId(store.requireExternalEntryPort().resolveExternalEntryDocId(store, payload));
    if (externalDocId) return externalDocId;
    const refId = normalizePositiveId(payload.refId ?? payload.ref_id);
    if (refId !== null) {
      const ref = store.db!.prepare('SELECT * FROM refs WHERE id = ?').get<RefRow>(refId);
      if (ref) {
        const node = store.db!.prepare('SELECT doc_id FROM nodes WHERE id = ?').get<DocIdRow>(ref.source_id)
          || store.db!.prepare('SELECT doc_id FROM nodes WHERE id = ?').get<DocIdRow>(ref.target_id);
        if (node) return node.doc_id;
      }
    }
    return null;
  }

export function nodePatchForEditBranch(store: EditBranchStore, current: NodeRow | RowObject, patch: EditBranchPayload = {}) {
    assertNoHumanTagField(patch, 'node.update patch');
    assertNoEditTrustField(patch, 'node.update patch');
    const next: RowObject = {};
    if (hasOwnValue(patch, 'node_note', 'nodeNote')) next.node_note = patch.node_note ?? patch.nodeNote ?? '';
    if (hasOwnValue(patch, 'node_type', 'nodeType')) {
      next.node_type = normalizeNodeType(patchValue(patch, 'node_type', 'nodeType', current.node_type));
    }
    return next;
  }

export function _appendEditBranchEntry(store: EditBranchStore, branch: EditBranchRow, entry: EditBranchEntry): EditBranchRow {
    if (!store.requireEditBranchPort().isSupportedEditBranchEntryKind(entry?.kind)) {
      throw new Error(`Unsupported edit branch entry kind: ${entry?.kind || ''}`);
    }
    // append 即销毁 redo 分支（与旧行为一致：原实现按 activeEntries 过滤后重建）。
    // 三条写包进事务：DELETE undone / INSERT entry / UPDATE branches 任一中断都不能只落一半
    // （否则崩溃窗口会出现 redo 已清、新操作未写入的草稿损坏）。
    return store.withTransaction(() => {
      store.db!.prepare("DELETE FROM edit_branch_entries WHERE branch_id = ? AND status = 'undone'").run(branch.id);
      const fields = entryToRowFields({ ...entry, status: 'active', createdAt: entry.createdAt || new Date().toISOString() } as EditBranchEntry);
      store.db!.prepare(`
        INSERT INTO edit_branch_entries (branch_id, seq, status, created_at, undone_at, entry)
        VALUES (?, COALESCE((SELECT MAX(seq) FROM edit_branch_entries WHERE branch_id = ?), 0) + 1, ?, ?, ?, ?)
      `).run(branch.id, branch.id, fields.status, fields.created_at, fields.undone_at, fields.payload);
      store.db!.prepare('UPDATE edit_branches SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(branch.id);
      return _branchRowById(store, branch.id);
    });
  }

export function editBranchHistoryState(store: EditBranchStore, branch: EditBranchRow) {
    const counts = store.db!.prepare(`
      SELECT status, COUNT(*) AS n FROM edit_branch_entries WHERE branch_id = ? GROUP BY status
    `).all<{ status: string; n: number }>(branch?.id);
    let active = 0;
    let undone = 0;
    for (const row of counts) {
      if (row.status === 'undone') undone += Number(row.n) || 0;
      else active += Number(row.n) || 0;
    }
    if (active + undone === 0) {
      // 未迁移旧行兜底：子表空但 diff 列还躺着 entries（readonly 打开旧库）→ 按旧 JSON 计。
      const diff = JSON.parse(branch?.diff || '{}') as EditBranchDiff;
      const entries = Array.isArray(diff.entries) ? diff.entries : [];
      active = activeEntries(store, entries).length;
      undone = undoneEntries(store, entries).length;
    }
    return {
      undoDepth: active,
      redoDepth: undone,
      hasUndo: active > 0,
      hasRedo: undone > 0
    };
  }

export function _replaceEditBranchDiff(store: EditBranchStore, branch: EditBranchRow, diff: EditBranchDiff): EditBranchRow {
    // 整替（显式重排用，低频 O(K)）：清子表重灌。DELETE 全表 + N 个 INSERT + UPDATE 包进事务，
    // 否则崩溃窗口会留下「子表已清、新行未灌」的空草稿。
    const { entries: rawEntries } = (diff || {}) as EditBranchDiff & Record<string, unknown>;
    const entries = Array.isArray(rawEntries) ? rawEntries : [];
    return store.withTransaction(() => {
      store.db!.prepare('DELETE FROM edit_branch_entries WHERE branch_id = ?').run(branch.id);
      const insert = store.db!.prepare(`
        INSERT INTO edit_branch_entries (branch_id, seq, status, created_at, undone_at, entry)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      entries.forEach((entry, index) => {
        const fields = entryToRowFields(entry as EditBranchEntry);
        insert.run(branch.id, index + 1, fields.status, fields.created_at, fields.undone_at, fields.payload);
      });
      store.db!.prepare('UPDATE edit_branches SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(branch.id);
      return _branchRowById(store, branch.id);
    });
  }

export function undoEditBranchEntry(store: EditBranchStore, { docId = null }: EditBranchPayload = {}) {
    const branch = findEditBranch(store, { docId } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) throw new Error('当前文档没有活跃草稿，请先 draft');
    // 最后一条 active → undone，单行翻转 O(1)（原实现整包重写 O(K)）。
    const target = store.db!.prepare(`
      SELECT id FROM edit_branch_entries
      WHERE branch_id = ? AND status = 'active'
      ORDER BY seq DESC LIMIT 1
    `).get<{ id: number }>(branch.id);
    if (!target) {
      return { changed: false, branch, ...editBranchHistoryState(store, branch) };
    }
    return store.withTransaction(() => {
      store.db!.prepare("UPDATE edit_branch_entries SET status = 'undone', undone_at = ? WHERE id = ?")
        .run(new Date().toISOString(), target.id);
      store.db!.prepare('UPDATE edit_branches SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(branch.id);
      const freshBranch = _branchRowById(store, branch.id);
      return { changed: true, branch: freshBranch, ...editBranchHistoryState(store, freshBranch) };
    });
  }

export function redoEditBranchEntry(store: EditBranchStore, { docId = null }: EditBranchPayload = {}) {
    const branch = findEditBranch(store, { docId } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) throw new Error('当前文档没有活跃草稿，请先 draft');
    // 复活「最近被 undo」的条目（undoneAt 最新、同刻取 seq 最大），与原 marker 扫描语义一致。
    const target = store.db!.prepare(`
      SELECT id FROM edit_branch_entries
      WHERE branch_id = ? AND status = 'undone'
      ORDER BY COALESCE(undone_at, created_at, '') DESC, seq DESC LIMIT 1
    `).get<{ id: number }>(branch.id);
    if (!target) {
      return { changed: false, branch, ...editBranchHistoryState(store, branch) };
    }
    return store.withTransaction(() => {
      store.db!.prepare("UPDATE edit_branch_entries SET status = 'active', undone_at = NULL WHERE id = ?").run(target.id);
      store.db!.prepare('UPDATE edit_branches SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(branch.id);
      const freshBranch = _branchRowById(store, branch.id);
      return { changed: true, branch: freshBranch, ...editBranchHistoryState(store, freshBranch) };
    });
  }

  // Fetch the doc-scoped refs. Shared between getDoc and _projectedDocForBranch so the lazy diff
  // projection always sees the same set of ref rows that the read path does.
export function _fetchBaseRefsForDoc(store: EditBranchStore, docId: unknown) {
    return refStore.listDocRefs(store, docId);
  }

  // 某文档当前正文（base）的投影输入：节点（父→排序→id 稳定序）、引用。diffView / 投影 / liveDocSnapshot
  // 共用这一份取数，省得三处各写一遍、nodes 排序或 base 取法要改时追三处。
export function editBranchBaseInputs(store: EditBranchStore, docId: unknown): BaseDocInputs {
    const id = normalizePositiveId(docId);
    if (!id) throw new Error(`Invalid edit branch document id: ${docId}`);
    const nodes = store.db!.prepare(`
      SELECT * FROM nodes WHERE doc_id = ?
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
    `).all<ProjectedNode>(id);
    return { docId: id, nodes, refs: _fetchBaseRefsForDoc(store, id) as RefRow[] };
  }

  // Read the doc with all entries from `branch` already projected on top of the
  // base tables. Returns the projection state (nodes/refs maps) — the
  // caller can use it to derive `node` or `ref` views to hand back
  // to the front-end after a stage operation.
export function _projectedDocForBranch(store: EditBranchStore, branch: EditBranchRow): ProjectedDocState {
    const diff = JSON.parse(branch.diff || '{}') as EditBranchDiff;
    const entries = Array.isArray(diff.entries) ? diff.entries : [];
    return store.requireEditBranchPort().projectEditBranchDoc(editBranchBaseInputs(store, branch.base_doc_id), entries);
  }

  // 把某文档当前正文（HEAD）投影成快照 {nodes(含 address),refs}，供 diff.refs 与历史/草稿快照同形比对。
  // 空 entries 投影 = 正文本身，但复用投影器算地址，地址口径与草稿/历史快照一致（computeDiff 按稳定 id 配对）。
export function liveDocSnapshot(store: EditBranchStore, docId: unknown): ProjectedDocState {
    return store.requireEditBranchPort().projectEditBranchDoc(editBranchBaseInputs(store, docId), []);
  }

export function _findProjectedNode(store: EditBranchStore, state: ProjectedDocState, ref: unknown) {
    if (ref === null || ref === undefined) return null;
    if (store.requireEditBranchPort().isTmpId(ref)) return state.nodes.find((node) => node.id === ref) || null;
    return state.nodes.find((node) => sameStableId(node.id, ref)) || null;
  }

export function beginEditBranch(store: EditBranchStore, docId: unknown) {
    const normalizedDocId = normalizePositiveId(docId);
    if (!normalizedDocId) throw new Error('beginEditBranch requires docId');
    const existing = activeEditBranchForBaseDoc(store, normalizedDocId);
    if (existing) return existing;
    const result = store.db!.prepare('INSERT INTO edit_branches (base_doc_id) VALUES (?)').run(normalizedDocId);
    return _branchRowById(store, Number(result.lastInsertRowid));
  }

export function findEditBranch(store: EditBranchStore, { docId = null }: BranchLookupPayload = {}) {
    return docId ? activeEditBranchForDoc(store, docId) : null;
  }

export function saveEditBranch(store: EditBranchStore, { docId = null, summary = '保存草稿' }: EditBranchPayload = {}) {
    const branch = findEditBranch(store, { docId } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) throw new Error('当前文档没有活跃草稿，请先 draft');
    return _commitEditBranchPayload(store, branch, (parseJsonObject(branch.diff) || {}) as EditBranchDiff, String(summary));
  }

  // 重放前后的节点签名快照，比对找出本次实际受影响节点。签名分两维，对应两套派生索引
  // 各自的身份语义：keyword 行绑（地址+全部内容字段，4-6-2），向量只绑正文（15-8-1，
  // 地址/标题/备注变化不重算）。contentHash 现算（merkle 同款）——content_hash 列是
  // 惰性回写（触发器只标 doc 脏），事务内不可用。逐 entry 收集容易漏（split/merge/
  // 级联删除），两次 O(n) 快照比对不会。iterate 逐行算完即弃，不持全文。
export function _docNodeSignatures(store: EditBranchStore, docId: unknown) {
    const map = new Map<string, NodeSignature>();
    const rows = store.db!.prepare(`
      SELECT id, address, text, node_note, node_type, trust_level
      FROM nodes WHERE doc_id = ?
    `).all<Pick<NodeRow, 'id' | 'address' | 'text' | 'node_note' | 'node_type' | 'trust_level'>>(docId);
    for (const row of rows) {
      map.set(String(row.id), {
        keyword: `${row.address || ''}|${contentHash(row as unknown as MerkleNode)}`,
        text: contentHash({ id: null, text: row.text })
      });
    }
    return map;
  }

  // 把一份 diff payload（生效 entries）应用到主干、提交、写历史、删分支。
  // saveEditBranch 用分支存储的 entries 调用。
  // 返回 touchedNodeIds/deletedNodeIds 供派生索引按受影响节点增量同步（4-6-2）。
export function _commitEditBranchPayload(store: EditBranchStore, branch: EditBranchRow, rawPayload: EditBranchDiff = {}, summary = '保存编辑分支'): BranchCommitResult {
    const entries = activeEntries(store, rawPayload.entries);
    if (entries.some(editBranchEntryTouchesTrust)) {
      throw new Error('edit branch diff no longer supports trust_level; use human certify to set trust_level');
    }
    const payload = { ...rawPayload, entries };
    const hasEffectiveDiff = entries.length > 0;

    return store.withTransaction(() => {
      const touchedNodeIds: unknown[] = [];
      const deletedNodeIds: unknown[] = [];
      const vectorStaleNodeIds: unknown[] = [];
      if (hasEffectiveDiff) {
        const before = _docNodeSignatures(store, branch.base_doc_id);
        applyEditBranchDiffEntries(store, branch, payload);
        const after = _docNodeSignatures(store, branch.base_doc_id);
        for (const [id, signature] of after) {
          const previous = before.get(id);
          if (!previous || previous.keyword !== signature.keyword) touchedNodeIds.push(id);
          // 向量陈旧 = 既有节点正文变了；新增节点无旧向量行，地址/标题/备注变化不算。
          if (previous && previous.text !== signature.text) vectorStaleNodeIds.push(id);
        }
        for (const id of before.keys()) {
          if (!after.has(id)) deletedNodeIds.push(id);
        }
        const currentSnapshot = history.createSnapshot(store, branch.base_doc_id);
        history.createCommit(store, {
          docId: branch.base_doc_id,
          summary,
          snapshot: currentSnapshot,
          entries
        });
      }

      store.db!.prepare('DELETE FROM edit_branches WHERE id = ?').run(branch.id);
      if (hasEffectiveDiff) store.touchDoc(branch.base_doc_id);

      return {
        changed: hasEffectiveDiff,
        baseDocId: branch.base_doc_id,
        branchId: branch.id,
        touchedNodeIds,
        deletedNodeIds,
        vectorStaleNodeIds,
        history: hasEffectiveDiff
          ? store.db!.prepare(`
            SELECT id, doc_id, id AS commit_id, committed_at AS saved_at, summary
            FROM commits
            WHERE doc_id = ?
            ORDER BY committed_at DESC, id DESC
            LIMIT 1
          `).get<CommitHistoryRow>(branch.base_doc_id)
          : null
      };
    });
  }

export function discardEditBranch(store: EditBranchStore, { docId = null }: EditBranchPayload = {}) {
    const branch = findEditBranch(store, { docId } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) return false;
    // Lazy mode: base tables are never modified during the edit session, so
    // discarding the branch simply drops the staged entries.
    store.db!.prepare('DELETE FROM edit_branches WHERE id = ?').run(branch.id);
    return true;
  }
