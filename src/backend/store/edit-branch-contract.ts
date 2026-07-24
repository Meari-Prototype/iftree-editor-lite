import type { NodeRow, RefRow } from '../db/schema.js';

export type ProjectionNode = NodeRow & { child_count: number };
export type ProjectionRef = RefRow & { pending_insert?: boolean };

export type ProjectedDoc = {
  docId: string;
  nodes: ProjectionNode[];
  refs: ProjectionRef[];
};

export type ProjectionState = ProjectedDoc & {
  nodeIdSeq: number;
  refIdSeq: number;
};

export type ProjectionBase = {
  docId: string;
  nodes?: ProjectionNode[];
  refs?: ProjectionRef[];
};

export type EditBranchEntryStatus = 'active' | 'undone';

export interface EditBranchEntryMeta {
  id?: unknown;
  entryId?: unknown;
  status?: EditBranchEntryStatus;
  createdAt?: string;
  undoneAt?: string;
  action?: string;
}

export interface NodePatchFields {
  node_note?: unknown;
  node_type?: unknown;
}

export interface NodeUpdateFieldsDelta {
  field: string;
  old?: unknown;
  new?: unknown;
}

export interface NodeUpdateEntry {
  kind: 'node.update';
  node_id?: unknown;
  target_ref?: unknown;
  patch: NodePatchFields;
  address?: string;
  fields?: NodeUpdateFieldsDelta[];
}

export interface RefAddNodeToNodeEntry {
  kind: 'ref.addNodeToNode';
  tmp_id?: string;
  source_ref?: unknown;
  source_node_id?: unknown;
  target_ref?: unknown;
  target_node_id?: unknown;
  ref_kind?: unknown;
  note?: unknown;
}

export interface RefDeleteEntry {
  kind: 'ref.delete';
  ref_ref?: unknown;
  ref_id?: unknown;
}

export type BuiltInEditBranchEntryKind =
  | 'node.update'
  | 'ref.addNodeToNode'
  | 'ref.delete';

export type EditBranchEntryKind = BuiltInEditBranchEntryKind | (string & {});

export type BuiltInEditBranchEntry =
  | (NodeUpdateEntry & EditBranchEntryMeta)
  | (RefAddNodeToNodeEntry & EditBranchEntryMeta)
  | (RefDeleteEntry & EditBranchEntryMeta);

export type ExternalEditBranchEntry = EditBranchEntryMeta & Record<string, unknown> & { kind: string };
export type EditBranchEntry = BuiltInEditBranchEntry | ExternalEditBranchEntry;
export type EntryByKind<K extends BuiltInEditBranchEntryKind> = Extract<BuiltInEditBranchEntry, { kind: K }>;

const BUILT_IN_EDIT_BRANCH_ENTRY_KINDS = new Set<string>([
  'node.update',
  'ref.addNodeToNode',
  'ref.delete'
]);

export function isBuiltInEditBranchEntry(entry: EditBranchEntry): entry is BuiltInEditBranchEntry {
  return BUILT_IN_EDIT_BRANCH_ENTRY_KINDS.has(entry.kind);
}
