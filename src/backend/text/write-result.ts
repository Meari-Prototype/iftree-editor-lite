// 写动词 / 状态返回的形状（write-result-text 渲染、未来 mutation-api 标注返回值的权威契约）。
// 不同 action 返回不同字段子集，故全部可选；嵌套对象复用 db/rows 的行类型 + 少量回执专属字段。
// 刻意不加索引签名：保留对「拼错字段名」的 strict 检测。

import type {
  NodeRow,
  DocRow,
  RefRow,
  EntityRow,
  EditBranchRow,
  SourceDocumentRow,
} from '../db/rows.js';

// commit/history 回执条目（commit_id 与 id 并存是历史口径差异）。
export interface CommitSummary {
  commit_id?: string;
  id?: string;
  summary?: string;
  saved_at?: string;
}

// 编辑分支变更计数：中英双键并存（后端给中文键、旧路径给英文键）。
export interface BranchCounts {
  改?: number; update?: number;
  增?: number; insert?: number;
  删?: number; delete?: number;
  移?: number; move?: number;
  其他?: number; other?: number;
  撤销?: number; undone?: number;
}

export type BranchSummary = Partial<EditBranchRow> & { counts?: BranchCounts };

export interface WriteResult {
  ok?: boolean;
  error?: string;
  message?: string;
  action?: string;

  changed?: boolean;

  docId?: string | number;
  baseDocId?: string | number;
  branchId?: string | number;
  commitId?: string;
  revertCommitId?: string;

  doc?: Partial<DocRow> & { history?: CommitSummary[] };
  node?: Partial<NodeRow> & { pending_insert?: boolean };
  entity?: Partial<EntityRow>;
  link?: Record<string, unknown>;
  ref?: Partial<RefRow> & { kind?: string };
  editBranch?: BranchSummary;
  branch?: BranchSummary;
  source?: Partial<SourceDocumentRow>;
  history?: CommitSummary;

  insertedNodeId?: string | number | null;
  insertedRefId?: string | number | null;

  undoDepth?: number;
  redoDepth?: number;

  // node.split：拆分规模（逐动作计数对 split 恒 +1，回执单独交代切成几句/几段、几个节点下沉）。
  splitSentenceCount?: number;
  splitParagraphCount?: number;
  splitNewNodeCount?: number;

  // 写 handler 附带的副作用清单（如 relink.targetCheck）；渲染层挑认识的显示。
  sideEffects?: Array<Record<string, unknown>>;

  pragmas?: Record<string, unknown>;
  restoredPragmas?: Record<string, unknown>;
  checkpoint?: string;
  touchedNodeIds?: Array<string | number>;
  touchedDocIds?: Array<string | number>;

  nodeId?: string | number | null;
  sourceNodeId?: string | number | null;
  targetNodeId?: string | number | null;
  newParentId?: string | number | null;
  refId?: string | number | null;
  entityId?: string | number | null;
  entityIds?: Array<string | number>;
  kind?: string | null;
  status?: string | null;
  direction?: string | null;

  createdCount?: number;

  // import.libraryDocument
  relativePath?: string;
  nodeCount?: number;
  vectorWarning?: string;

  // vector.ensureDoc
  skipped?: boolean;
  reason?: string;
  vectorCountBefore?: number;
  vectorCountAfter?: number;
  missingInserted?: number;
  changedDeleted?: number;
  staleDeleted?: number;
  existingCurrent?: number;

  // objects.gc
  scanned?: number;
  reachable?: number;
  deleted?: number;

  title?: string;

  // sql
  rows?: unknown[];
  rowCount?: number;
  truncated?: boolean;
}
