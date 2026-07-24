// 节点引用的通用持久化（L2）：只校验行归属和引用约束，不含上层动作语义。
// refs 两端恒为节点（axiom 退场后无其它端类型），不再带 source_type/target_type 列。

import type Database from 'better-sqlite3';
import { assertValidNodeRefKind } from '../shared.js';
import { newStableId, sameStableId } from '../db/ids.js';
import { normalizeNullableText } from '../db/normalizers.js';
import type { NodeRow, RefRow } from '../db/schema.js';

export interface RefStore {
  db: Database | null;
  touchDoc(docId: unknown): void;
}

export type AddNodeRefPayload = {
  docId?: unknown;
  sourceNodeId?: unknown;
  targetNodeId?: unknown;
  refKind?: unknown;
  note?: unknown;
};

export function addNodeRefToNode(store: RefStore, {
  docId, sourceNodeId, targetNodeId, refKind, note = null
}: AddNodeRefPayload) {
  const kind = normalizeNullableText(refKind);
  if (!kind) throw new Error('ref.addNodeToNode requires refKind');
  assertValidNodeRefKind(kind);
  const source = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(sourceNodeId);
  if (!source) throw new Error(`Source node not found: ${sourceNodeId}`);
  const target = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(targetNodeId);
  if (!target) throw new Error(`Target node not found: ${targetNodeId}`);
  if (!sameStableId(source.doc_id, docId) || !sameStableId(target.doc_id, docId)) {
    throw new Error('Source node and target node must belong to the same document');
  }
  const existing = store.db!.prepare(`
    SELECT * FROM refs
    WHERE source_id = ?
      AND target_id = ?
      AND ref_kind = ?
    LIMIT 1
  `).get<RefRow>(sourceNodeId, targetNodeId, kind);
  if (existing) return existing;

  const refId = newStableId();
  store.db!.prepare(`
    INSERT INTO refs (id, source_id, target_id, ref_kind, note)
    VALUES (?, ?, ?, ?, ?)
  `).run(refId, sourceNodeId, targetNodeId, kind, normalizeNullableText(note));

  store.touchDoc(docId);
  return store.db!.prepare('SELECT * FROM refs WHERE id = ?').get<RefRow>(refId);
}

export function deleteRef(store: RefStore, refId: unknown) {
  const ref = store.db!.prepare('SELECT * FROM refs WHERE id = ?').get<RefRow>(refId);
  if (!ref) return false;

  let docId = store.db!.prepare('SELECT doc_id FROM nodes WHERE id = ?').get<Pick<NodeRow, 'doc_id'>>(ref.source_id)?.doc_id ?? null;
  if (docId === null) {
    docId = store.db!.prepare('SELECT doc_id FROM nodes WHERE id = ?').get<Pick<NodeRow, 'doc_id'>>(ref.target_id)?.doc_id ?? null;
  }

  store.db!.prepare('DELETE FROM refs WHERE id = ?').run(refId);
  if (docId !== null) store.touchDoc(docId);
  return true;
}

export function listDocRefs(store: RefStore, docId: unknown) {
  return store.db!.prepare(`
    SELECT refs.* FROM refs
    LEFT JOIN nodes source_nodes ON refs.source_id = source_nodes.id
    LEFT JOIN nodes target_nodes ON refs.target_id = target_nodes.id
    WHERE source_nodes.doc_id = ? OR target_nodes.doc_id = ?
    ORDER BY refs.id
  `).all<RefRow>(docId, docId);
}
