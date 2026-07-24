// 编辑分支暂存阶段（L2）：只接受节点备注/类型、引用动作；实体动作由 entities/write.ts 暂存。

import { assertNoEditTrustField, assertValidNodeRefKind } from '../shared.js';
import { normalizePositiveId } from '../db/normalizers.js';
import type { EditBranchRow } from '../db/schema.js';
import type { NodePatchFields, NodeUpdateFieldsDelta } from './edit-branch-contract.js';
import type { EditBranchStore } from './edit-branch.js';
import {
  _appendEditBranchEntry,
  _findProjectedNode,
  _projectedDocForBranch,
  nodePatchForEditBranch
} from './edit-branch.js';

type EditBranchPayload = Record<string, unknown>;

export function stageEditBranchNodeUpdate(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
  assertNoEditTrustField(payload, 'node.update payload');
  const nodeRef = payload.nodeId ?? payload.node_id;
  if (nodeRef === null || nodeRef === undefined) throw new Error('node.update requires nodeId');
  const before = _projectedDocForBranch(store, branch);
  const currentNode = _findProjectedNode(store, before, nodeRef);
  if (!currentNode) throw new Error(`Node not found in edit branch: ${nodeRef}`);
  const requestedPatch = nodePatchForEditBranch(store, currentNode, (payload.patch ?? payload) as EditBranchPayload);
  if (Object.keys(requestedPatch).length === 0) {
    throw new Error('node.update 只允许 nodeType/node_type 与 nodeNote/node_note');
  }
  const patch: NodePatchFields = {};
  const fields: NodeUpdateFieldsDelta[] = [];
  for (const [field, value] of Object.entries(requestedPatch)) {
    const oldValue = (currentNode as unknown as Record<string, unknown>)[field] ?? null;
    const nextValue = value ?? null;
    if (oldValue === nextValue) continue;
    (patch as Record<string, unknown>)[field] = value;
    fields.push({ field, old: oldValue, new: nextValue });
  }
  if (fields.length === 0) {
    return { branch, changed: false, node: store.requireEditBranchPort().nodeRowWithClientAliases(currentNode) };
  }
  const freshBranch = _appendEditBranchEntry(store, branch, {
    kind: 'node.update',
    action: 'patch',
    node_id: currentNode.id,
    address: currentNode.address || '',
    patch,
    fields
  });
  const after = _projectedDocForBranch(store, freshBranch);
  const projectedNode = _findProjectedNode(store, after, currentNode.id) || currentNode;
  return { branch: freshBranch, changed: true, node: store.requireEditBranchPort().nodeRowWithClientAliases(projectedNode) };
}

export function stageEditBranchRefAddNodeToNode(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
  const docId = normalizePositiveId(branch.base_doc_id);
  const sourceRef = payload.sourceNodeId ?? payload.source_node_id ?? payload.nodeId ?? payload.node_id;
  const targetRef = payload.targetNodeId ?? payload.target_node_id;
  const refKind = String(payload.refKind ?? payload.ref_kind ?? payload.kind ?? '').trim();
  if (sourceRef === null || sourceRef === undefined) throw new Error('ref.addNodeToNode requires sourceNodeId');
  if (targetRef === null || targetRef === undefined) throw new Error('ref.addNodeToNode requires targetNodeId');
  if (!refKind) throw new Error('ref.addNodeToNode requires refKind');
  assertValidNodeRefKind(refKind);
  const tmpId = store.requireEditBranchPort().nextTmpId('ref');
  const freshBranch = _appendEditBranchEntry(store, branch, {
    kind: 'ref.addNodeToNode',
    tmp_id: tmpId,
    source_ref: sourceRef,
    target_ref: targetRef,
    ref_kind: refKind,
    note: payload.note ?? null
  });
  return { branch: freshBranch, changed: true, docId, insertedRefId: tmpId, refId: tmpId, sourceNodeId: sourceRef, targetNodeId: targetRef };
}

export function stageEditBranchRefDelete(store: EditBranchStore, branch: EditBranchRow, payload: EditBranchPayload = {}) {
  const docId = normalizePositiveId(branch.base_doc_id);
  const ref = payload.refId ?? payload.ref_id;
  if (ref === null || ref === undefined) throw new Error('ref.delete requires refId');
  const freshBranch = _appendEditBranchEntry(store, branch, { kind: 'ref.delete', ref_ref: ref });
  return { branch: freshBranch, changed: true, docId, refId: ref };
}
