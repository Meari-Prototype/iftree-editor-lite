import { normalizeStableId } from '../db/ids.js';
import { normalizeNodeType } from '../../core/node-model.js';
import type { NodeType } from '../db/schema.js';

export type {
  EditBranchEntry,
  EditBranchEntryKind,
  EditBranchEntryMeta,
  EntryByKind,
  NodePatchFields,
  NodeUpdateFieldsDelta,
  ProjectedDoc,
  ProjectionBase,
  ProjectionNode,
  ProjectionRef,
  ProjectionState
} from '../store/edit-branch-contract.js';
import type {
  EditBranchEntry,
  EntryByKind,
  NodePatchFields,
  ProjectedDoc,
  ProjectionBase,
  ProjectionNode,
  ProjectionState
} from '../store/edit-branch-contract.js';
import { isBuiltInEditBranchEntry } from '../store/edit-branch-contract.js';

const SUPPORTED_ENTRY_KINDS = new Set<string>([
  'node.update',
  'ref.addNodeToNode',
  'ref.delete',
  'entity.create',
  'entity.update',
  'entity.delete',
  'entity.link',
  'entity.unlink',
  'entity.bindNode',
  'entity.ignoreNode',
  'entity.clearNodeBinding'
]);

export function isSupportedEditBranchEntryKind(kind: unknown) {
  return SUPPORTED_ENTRY_KINDS.has(String(kind || ''));
}

export function isActiveEditBranchEntry(entry: unknown) {
  if (!entry || typeof entry !== 'object') return true;
  return String((entry as { status?: string }).status || 'active') !== 'undone';
}

export function activeEditBranchEntries(entries: unknown = []): EditBranchEntry[] {
  return (Array.isArray(entries) ? entries : []).filter(isActiveEditBranchEntry) as EditBranchEntry[];
}

export function undoneEditBranchEntries(entries: unknown = []): EditBranchEntry[] {
  return (Array.isArray(entries) ? entries : []).filter((entry) => !isActiveEditBranchEntry(entry)) as EditBranchEntry[];
}

function cloneState(base: ProjectionBase): ProjectionState {
  return {
    docId: base.docId,
    nodes: (base.nodes || []).map((row) => ({ ...row })),
    refs: (base.refs || []).map((row) => ({ ...row })),
    nodeIdSeq: -1,
    refIdSeq: -1
  };
}

function isTmpId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('tmp-');
}

function normalizeId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (isTmpId(value)) return value;
  return normalizeStableId(value);
}

function sameRef(left: unknown, right: unknown) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

function findNodeIndex(state: ProjectionState, ref: unknown) {
  if (ref === null || ref === undefined) return -1;
  return state.nodes.findIndex((node) => sameRef(node.id, ref));
}

function findRefIndex(state: ProjectionState, ref: unknown) {
  if (ref === null || ref === undefined) return -1;
  return state.refs.findIndex((entry) => sameRef(entry.id, ref));
}

function patchNodeRow(row: ProjectionNode, patch: NodePatchFields): ProjectionNode {
  const next = { ...row };
  if (Object.prototype.hasOwnProperty.call(patch, 'node_note')) next.node_note = String(patch.node_note ?? '');
  if (Object.prototype.hasOwnProperty.call(patch, 'node_type')) {
    next.node_type = normalizeNodeType(patch.node_type ?? row.node_type) as NodeType;
  }
  next.updated_at = new Date().toISOString();
  return next;
}

function applyNodeUpdate(state: ProjectionState, entry: EntryByKind<'node.update'>) {
  const index = findNodeIndex(state, entry.node_id ?? entry.target_ref);
  if (index >= 0) state.nodes[index] = patchNodeRow(state.nodes[index], entry.patch || {});
}

function applyRefAddNodeToNode(state: ProjectionState, entry: EntryByKind<'ref.addNodeToNode'>) {
  const sourceRef = normalizeId(entry.source_ref ?? entry.source_node_id);
  const targetRef = normalizeId(entry.target_ref ?? entry.target_node_id);
  const refKind = String(entry.ref_kind ?? '').trim();
  if (sourceRef === null || targetRef === null || !refKind) return;
  state.refs.push({
    id: String(entry.tmp_id || ''),
    source_id: sourceRef,
    target_id: targetRef,
    ref_kind: refKind,
    note: entry.note == null ? null : String(entry.note),
    pending_insert: true
  });
}

function applyRefDelete(state: ProjectionState, entry: EntryByKind<'ref.delete'>) {
  const index = findRefIndex(state, entry.ref_ref ?? entry.ref_id);
  if (index >= 0) state.refs.splice(index, 1);
}

function applyEntryToProjection(state: ProjectionState, entry: EditBranchEntry) {
  if (!isBuiltInEditBranchEntry(entry)) return;
  switch (entry.kind) {
    case 'node.update': return applyNodeUpdate(state, entry);
    case 'ref.addNodeToNode': return applyRefAddNodeToNode(state, entry);
    case 'ref.delete': return applyRefDelete(state, entry);
  }
}

export function projectEditBranchDoc(base: ProjectionBase, entries: unknown = []): ProjectedDoc {
  const state = cloneState(base);
  for (const entry of activeEditBranchEntries(entries)) {
    if (!SUPPORTED_ENTRY_KINDS.has(String(entry.kind || ''))) continue;
    applyEntryToProjection(state, entry);
  }
  return state;
}

let tmpIdCounter = 0;
export function nextTmpId(kind: unknown = 'ref') {
  tmpIdCounter += 1;
  return `tmp-${kind}-${Date.now().toString(36)}-${tmpIdCounter.toString(36)}`;
}

export { isTmpId, sameRef };
