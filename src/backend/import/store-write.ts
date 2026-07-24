// 导入产物落库编排（L3）：解释 sentence/structured records，并调用 L2 通用事务与 CRUD 原语。

import { normalizeNodeType } from '../../core/node-model.js';
import { compareNodeAddress } from '../shared.js';
import { newStableId } from '../db/ids.js';
import {
  areRecordsAddressSorted,
  normalizeSourcePosition,
  recordSentenceIndexes
} from '../db/normalizers.js';
import type { NodeRow } from '../db/schema.js';
import type { CommitPayload, SnapshotPayload } from '../store/history.js';

export interface ImportRecord {
  text?: unknown;
  address?: unknown;
  role?: unknown;
  index?: unknown;
  indexes?: unknown[];
  nodeType?: unknown;
  node_type?: unknown;
  sourcePosition?: unknown;
  source_position?: unknown;
  trustLevel?: unknown;
}

export interface ImportedDocInput {
  title: string;
  sourcePath?: unknown;
  records: ImportRecord[];
  skipInitialCommit?: boolean;
}

export interface ImportWriteStore {
  db: {
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
    };
  } | null;
  withTransaction<T>(fn: () => T): T;
  createDoc(payload: {
    title: string;
    rootText?: unknown;
    meta?: unknown;
    skipInitialCommit?: boolean;
  }): { id: string; title: string; rootNodeId: string };
  insertNode(payload: {
    docId: unknown;
    parentId: unknown;
    text?: unknown;
    nodeType?: unknown;
  }): NodeRow;
  refreshAddressScopes(docId: unknown, parentIds: unknown[]): unknown;
  refreshDocAddresses(docId: unknown): unknown;
  createCommit(payload: CommitPayload): unknown;
  createSnapshot(docId: unknown): SnapshotPayload;
}

function requireDb(store: ImportWriteStore): NonNullable<ImportWriteStore['db']> {
  if (!store.db) throw new Error('Import store is not initialized');
  return store.db;
}

export function createDocFromSentences(
  store: ImportWriteStore,
  { title, sourcePath, sentences }: { title: string; sourcePath?: unknown; sentences: string[] }
) {
  return createDocFromSentenceRecords(store, {
    title,
    sourcePath,
    records: sentences.map((text) => ({ text, vector: null }))
  });
}

export function createDocFromSentenceRecords(store: ImportWriteStore, {
  title, sourcePath, records, skipInitialCommit = false
}: ImportedDocInput) {
  return store.withTransaction(() => {
    const doc = store.createDoc({
      title,
      rootText: title,
      meta: JSON.stringify({ sourcePath, importedAt: new Date().toISOString() }),
      skipInitialCommit: true
    });
    const chapter = store.insertNode({
      docId: doc.id,
      parentId: doc.rootNodeId,
      text: '原始文本导入',
      nodeType: 'TEXT'
    });
    const importedNodeIds: string[] = [];
    const importedNodeIdsByRecordIndex: Record<number, string> = {};
    const insertNode = requireDb(store).prepare(`
      INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text)
      VALUES (?, ?, ?, ?, 'TEXT', ?)
    `);

    for (const [index, record] of records.entries()) {
      const nodeId = newStableId();
      insertNode.run(nodeId, doc.id, chapter.id, index + 1, record.text);
      importedNodeIds.push(nodeId);
      for (const recordIndex of recordSentenceIndexes(record, index + 1)) {
        importedNodeIdsByRecordIndex[recordIndex] = nodeId;
      }
    }
    store.refreshAddressScopes(doc.id, [chapter.id]);
    if (!skipInitialCommit) createImportInitialCommit(store, doc.id);

    return { ...doc, importedNodeIds, importedNodeIdsByRecordIndex };
  });
}

export function createDocFromStructuredRecords(store: ImportWriteStore, {
  title, sourcePath, records, skipInitialCommit = false
}: ImportedDocInput) {
  return store.withTransaction(() => {
    const headingAddresses = records
      .filter((record) => String(record.role || '').trim() === 'heading')
      .map((record) => String(record.address || '').trim())
      .filter(Boolean)
      .map((address) => `1-${address}`);
    const doc = store.createDoc({
      title,
      rootText: title,
      meta: JSON.stringify({
        sourcePath,
        importedAt: new Date().toISOString(),
        structured: true,
        headingAddresses
      }),
      skipInitialCommit: true
    });
    const addressToId = new Map<string, string>();
    const importedNodeIds: string[] = [];
    const importedNodeIdsByRecordIndex: Record<number, string> = {};
    const sorted = areRecordsAddressSorted(records) ? records : [...records].sort(compareNodeAddress);
    const insertNode = requireDb(store).prepare(`
      INSERT INTO nodes (
        id, doc_id, parent_id, sort_order, node_type, text, node_note, source_position, trust_level
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const record of sorted) {
      const address = String(record.address || '').trim();
      const parts = address.split('-').map(Number);
      const parentId = parts.length === 1
        ? doc.rootNodeId
        : addressToId.get(parts.slice(0, -1).join('-')) || doc.rootNodeId;
      const sortOrder = parts[parts.length - 1] || 1;
      const nodeType = normalizeNodeType(record.nodeType ?? record.node_type ?? 'TEXT');
      const nodeId = newStableId();
      insertNode.run(
        nodeId,
        doc.id,
        parentId,
        sortOrder,
        nodeType,
        record.text || '',
        '',
        normalizeSourcePosition(record.sourcePosition ?? record.source_position),
        record.trustLevel || null
      );
      addressToId.set(address, nodeId);
      importedNodeIds.push(nodeId);
      for (const recordIndex of recordSentenceIndexes(record)) {
        importedNodeIdsByRecordIndex[recordIndex] = nodeId;
      }
    }
    store.refreshDocAddresses(doc.id);
    if (!skipInitialCommit) createImportInitialCommit(store, doc.id);

    return { ...doc, importedNodeIds, importedNodeIdsByRecordIndex };
  });
}

export function createImportInitialCommit(store: ImportWriteStore, docId: unknown) {
  return store.createCommit({
    docId,
    summary: '导入',
    snapshot: store.createSnapshot(docId)
  });
}

/** 智能导入嵌套节点树（lite：替代原 stream.push 入库路径）。trust 恒为不受控。 */
export interface ImportTreeWriteNode {
  address?: unknown;
  text?: unknown;
  nodeNote?: unknown;
  node_note?: unknown;
  nodeType?: unknown;
  node_type?: unknown;
  sourcePosition?: unknown;
  source_position?: unknown;
  children?: ImportTreeWriteNode[];
  [extra: string]: unknown;
}

export interface CreateDocFromImportTreeInput {
  title: string;
  nodes?: ImportTreeWriteNode[] | unknown;
  sourcePath?: unknown;
  skipInitialCommit?: boolean;
}

function flattenImportTreeNodes(
  nodes: ImportTreeWriteNode[] | unknown,
  out: ImportTreeWriteNode[] = []
): ImportTreeWriteNode[] {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const typed = node as ImportTreeWriteNode;
    out.push(typed);
    if (Array.isArray(typed.children) && typed.children.length) {
      flattenImportTreeNodes(typed.children, out);
    }
  }
  return out;
}

export function createDocFromImportTree(store: ImportWriteStore, {
  title, nodes, sourcePath, skipInitialCommit = false
}: CreateDocFromImportTreeInput) {
  const flat = flattenImportTreeNodes(nodes);
  return store.withTransaction(() => {
    const doc = store.createDoc({
      title,
      rootText: title,
      meta: JSON.stringify({ sourcePath, importedAt: new Date().toISOString(), importJson: true }),
      skipInitialCommit: true
    });
    const addressToId = new Map<string, string>();
    const insertNode = requireDb(store).prepare(`
      INSERT INTO nodes (
        id, doc_id, parent_id, sort_order, node_type, text, node_note, source_position, trust_level
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 按地址排序后按路径写表，保证父节点先于子节点存在。
    const sorted = [...flat].sort(compareNodeAddress);
    for (const record of sorted) {
      const address = String(record.address || '').trim();
      if (!address) continue;
      const parts = address.split('-').map(Number);
      const parentId = parts.length === 1
        ? doc.rootNodeId
        : addressToId.get(parts.slice(0, -1).join('-')) || doc.rootNodeId;
      const sortOrder = parts[parts.length - 1] || 1;
      const nodeType = normalizeNodeType(record.nodeType ?? record.node_type ?? 'TEXT');
      const nodeId = newStableId();
      insertNode.run(
        nodeId,
        doc.id,
        parentId,
        sortOrder,
        nodeType,
        typeof record.text === 'string' ? record.text : (record.text ?? ''),
        record.nodeNote ?? record.node_note ?? '',
        normalizeSourcePosition(record.sourcePosition ?? record.source_position),
        '不受控'
      );
      addressToId.set(address, nodeId);
    }

    store.refreshDocAddresses(doc.id);
    if (!skipInitialCommit) createImportInitialCommit(store, doc.id);

    return {
      id: doc.id,
      title: doc.title,
      rootNodeId: doc.rootNodeId,
      idByAddress: addressToId,
      createdCount: addressToId.size
    };
  });
}
