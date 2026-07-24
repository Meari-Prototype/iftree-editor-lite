import {
  docRefresh,
  plain,
  refDocId,
  requireDocId,
  requireId
} from './shared.js';
import type { IftreeStore } from '../../store/index.js';

type WritePayload = Record<string, unknown>;
type EffectList = Array<Record<string, unknown>>;

function nodeRefPayload(payload: WritePayload = {}): WritePayload {
  return {
    ...payload,
    docId: payload.docId ?? payload.doc_id,
    sourceNodeId: payload.sourceNodeId ?? payload.source_node_id ?? payload.nodeId ?? payload.node_id,
    targetNodeId: payload.targetNodeId ?? payload.target_node_id,
    refKind: payload.refKind ?? payload.ref_kind ?? payload.kind,
    note: payload.note ?? null
  };
}

export function handleRefMutation(store: IftreeStore, payload: WritePayload, action: string, effects: EffectList) {
  if (action === 'ref.addNodeToNode') {
    const docId = requireDocId(payload);
    const ref = store.addNodeRefToNode(nodeRefPayload(payload));
    if (!ref) throw new Error('ref.addNodeToNode: store returned no row');
    return docRefresh(action, docId, { ref: plain(ref), refId: ref.id, sideEffects: effects });
  }
  if (action === 'ref.delete') {
    const refId = requireId(payload, 'refId', 'ref_id');
    const docId = refDocId(store, refId) ?? payload.docId ?? null;
    const changed = store.deleteRef(refId);
    return docRefresh(action, docId, { changed: Boolean(changed), refId, sideEffects: effects });
  }
  throw new Error(`Unhandled database_write action: ${action}`);
}
