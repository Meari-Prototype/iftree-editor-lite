import { handleRefMutation } from './handlers/write/ref.js';
import { handleDocFolderMutation, handleDocMutation } from './handlers/write/doc.js';
import { handleImportServiceMutation } from './handlers/write/import.js';
import { handleEditorHistoryMutation, handleHistoryMutation } from './handlers/write/history.js';
import { plain } from './handlers/write/shared.js';
import { ENTITY_WRITE_ACTIONS, stageEntityWrite } from './entities/write.js';
import { NODE_TYPES, NODE_TYPE_LABELS } from '../core/node-model.js';
import type { EditBranchRow } from './db/rows.js';
import type { IftreeStore } from './store/index.js';

const ACTIONS = Object.freeze([
  'mutation.actions',
  'docFolder.create',
  'docFolder.update',
  'docFolder.delete',
  'doc.create',
  'doc.moveToFolder',
  'doc.delete',
  'doc.relink',
  'import.libraryDocument',
  'import.deleteDocument',
  'vector.ensureDoc',
  'editBranch.begin',
  'editBranch.save',
  'editBranch.discard',
  'editBranch.undo',
  'editBranch.redo',
  'doc.refreshAddresses',
  'treeView.update',
  'node.update',
  'ref.addNodeToNode',
  'ref.delete',
  'editorHistory.capture',
  'editorHistory.restore',
  'editorHistory.discard',
  'history.save',
  'history.restore',
  'history.certify',
  'history.revert',
  'objects.gc',
  ...ENTITY_WRITE_ACTIONS
]);

const STABLE_ID_SCHEMA = Object.freeze({
  anyOf: [{ type: 'string' }, { type: 'number' }]
});

const NODE_TYPE_SCHEMA = Object.freeze({
  type: 'string',
  enum: NODE_TYPES,
  description: `节点类型。中文输入请在 db shell/MCP edit payload 中写 node_type，由后端归一为内部码；当前内部码：${NODE_TYPES.join(', ')}；中文标签：${Object.values(NODE_TYPE_LABELS).join(' / ')}。`
});

export type MutationPayload = Record<string, unknown>;
export type MutationResult = Record<string, unknown>;
type EffectList = Array<Record<string, unknown>>;

// 写入入口的 store facade：IftreeStore 现在公开方法签名已整体收紧（store/index.ts:188- TailParameters），
// MutationStore 直接 alias 到 IftreeStore，下游 handlers/* 也都用 IftreeStore——8 处 cast 同时清零。
export type MutationStore = IftreeStore;

export interface MutationContext {
  editBranchDocId?: unknown;
  refreshDoc?: (docId: unknown, options?: unknown) => unknown;
  maintainDerivedAfterWrite?: (
    docId: unknown,
    options?: Record<string, unknown>
  ) => Promise<unknown> | unknown;
  // 单写队列入队（架构不变量：所有写经共享后端单队列硬串行）。host 接线时注入；
  // fire-and-forget 派生维护经它执行，避免脱离队列与正常写撞 meta / LanceDB manifest。
  enqueueWrite?: (task: () => Promise<unknown> | unknown) => Promise<unknown> | unknown;
  [extra: string]: unknown;
}

// store.stage* / handlers 写出的 staged/result 形状很零散，这里给一个宽松形状：分发器只读出常用字段。
type StagedShape = {
  node?: Record<string, unknown> | null;
  branch?: EditBranchRow | null;
  changed?: boolean;
  docId?: unknown;
  insertedNodeId?: unknown;
  insertedRefId?: unknown;
  [key: string]: unknown;
};

function normalizeMutationAction(value: unknown): string {
  const action = String(value || '').trim();
  return (ACTIONS as readonly string[]).includes(action) ? action : '';
}

function requireStore(store: MutationStore | null | undefined): asserts store is MutationStore {
  if (!store?.db) throw new Error('database_write store is not available');
}

export function databaseWriteActions(): string[] {
  return [...ACTIONS];
}

export function databaseWriteToolSchema() {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: databaseWriteActions(),
        description: '白名单数据库写动作；不接受裸 SQL。'
      },
      docId: STABLE_ID_SCHEMA,
      nodeId: STABLE_ID_SCHEMA,
      errorId: STABLE_ID_SCHEMA,
      refId: STABLE_ID_SCHEMA,
      historyId: STABLE_ID_SCHEMA,
      commitId: STABLE_ID_SCHEMA,
      name: { type: 'string' },
      parentId: STABLE_ID_SCHEMA,
      folderId: { type: 'number' },
      trust: { type: 'string', enum: ['受控', '不受控'] },
      scope: { type: 'string', enum: ['subtree', 'node'] },
      address: { type: 'string' },
      title: { type: 'string' },
      term: { type: 'string' },
      literal: { type: 'string' },
      entityId: STABLE_ID_SCHEMA,
      sourceEntityId: STABLE_ID_SCHEMA,
      targetEntityId: STABLE_ID_SCHEMA,
      entityIds: { type: 'array', items: STABLE_ID_SCHEMA },
      kind: { type: 'string', enum: ['synonym', 'related'] },
      linkKind: { type: 'string', enum: ['synonym', 'related'] },
      sourceTerm: { type: 'string' },
      targetTerm: { type: 'string' },
      relatedTerm: { type: 'string' },
      rootText: { type: 'string' },
      nodeType: NODE_TYPE_SCHEMA,
      node_type: NODE_TYPE_SCHEMA,
      nodeNote: { type: 'string' },
      sourceNodeId: STABLE_ID_SCHEMA,
      targetAddress: { type: 'string' },
      refKind: { type: 'string' },
      note: { type: 'string' },
      tokenId: { type: 'string' },
      tokenIds: { type: 'array', items: { type: 'string' } },
      patch: { type: 'object' },
      state: { type: 'object' },
      items: { type: 'array' },
      positions: { type: 'array' },
      updates: { type: 'array' },
      depthKey: { type: 'string' },
      nodeIds: { type: 'array', items: STABLE_ID_SCHEMA },
      deltaY: { type: 'number' },
      mode: { type: 'string' },
      nodes: { type: 'array' },
      sourcePath: { type: 'string' },
      sourceType: { type: 'string' },
      relativePath: { type: 'string', description: 'import.libraryDocument：library 相对路径' },
      embed: { type: 'boolean', description: 'import.libraryDocument：导入时同步建向量（默认后补）' },
      refreshOptions: { type: 'object' }
    },
    required: ['action']
  };
}

function shouldRouteToEditBranch(action: string): boolean {
  if (action === 'node.update') return true;
  if (action.startsWith('ref.')) return true;
  if (action.startsWith('entity.')) return true;
  return false;
}

function activeEditBranchForMutation(store: MutationStore, payload: MutationPayload = {}, ctx: MutationContext = {}): EditBranchRow | null {
  const actionDocId = store.docIdForMutationPayload(payload);
  const selectedDocId = ctx.editBranchDocId ?? null;
  if (actionDocId && selectedDocId && String(actionDocId) !== String(selectedDocId)) {
    throw new Error(`编辑动作目标文档 ${actionDocId} 与 switch 当前文档 ${selectedDocId} 不一致`);
  }
  const docId = actionDocId ?? selectedDocId;
  if (!docId) return null;
  return (store.activeEditBranchForBaseDoc(docId) as EditBranchRow | null) || null;
}

function stagedNodeUpdateResult(action: string, staged: StagedShape): MutationResult {
  const docId = (staged.node?.doc_id as unknown)
    ?? (staged.node?.docId as unknown)
    ?? staged.branch?.base_doc_id
    ?? null;
  return {
    ok: true,
    action,
    docId,
    changed: Boolean(staged.changed),
    refresh: { kind: 'node', docId, nodeId: (staged.node?.id as unknown) ?? null },
    node: plain(staged.node),
    editBranch: plain(staged.branch),
    skipDocsRefresh: true
  };
}

const STAGED_DETAIL_KEYS = [
  'nodeId',
  'sourceNodeId',
  'targetNodeId',
  'newParentId',
  'refId',
  'entityId',
  'entityIds',
  'kind',
  'status',
  'direction'
] as const;

function stagedDetails(staged: StagedShape = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of STAGED_DETAIL_KEYS) {
    if (staged[key] !== undefined) out[key] = staged[key];
  }
  return out;
}

function stagedDocResult(action: string, staged: StagedShape, extras: Record<string, unknown> = {}): MutationResult {
  const docId = staged.docId ?? staged.branch?.base_doc_id ?? null;
  return {
    ok: true,
    action,
    docId,
    changed: Boolean(staged.changed),
    refresh: { kind: 'doc', docId },
    editBranch: plain(staged.branch),
    skipDocsRefresh: true,
    ...stagedDetails(staged),
    ...extras
  };
}

function dispatchEditBranchStage(
  store: MutationStore,
  branch: EditBranchRow,
  action: string,
  payload: MutationPayload
): MutationResult {
  if (action.startsWith('entity.')) return stageEntityWrite(store, branch, payload, action) as unknown as MutationResult;
  switch (action) {
    case 'node.update':
      return stagedNodeUpdateResult(action, store.stageEditBranchNodeUpdate(branch, payload) as StagedShape);
    case 'ref.addNodeToNode': {
      const staged = store.stageEditBranchRefAddNodeToNode(branch, payload) as StagedShape;
      return stagedDocResult(action, staged, { insertedRefId: staged.insertedRefId });
    }
    case 'ref.delete':
      return stagedDocResult(action, store.stageEditBranchRefDelete(branch, payload) as StagedShape);
    default:
      throw new Error(`Edit branch staging not implemented for action: ${action}`);
  }
}

// 写操作落主库后需要重建 BM25 关键词的动作（直写主库的内容/结构变更；编辑分支 staging 不到这里、
// 在上方提前 return）。稠密向量零耦合、不在此维护。doc.delete / doc.refreshAddresses 形态特殊，
// 单独分支处理。
const KEYWORD_REBUILD_ACTIONS = new Set([
  'doc.create', 'editBranch.save',
  'history.restore', 'history.revert', 'history.certify', 'editorHistory.restore'
]);

// 写分发收尾的派生索引维护：主库只报告"哪篇文档怎么变了"，怎么维护派生索引交给向量模块
// （ctx.maintainDerivedAfterWrite）。失败不阻塞写返回——关键词可重建、检索入口有缺失补建兜底。
// derivedSyncHint：fire-and-forget 入队后 result.derivedSync 会被立即删除（不进响应），
// 故调用方在入队前把 hint 快照传进来，本函数读快照而非 result.derivedSync（review #7）。
async function maintainDerivedIndexAfterWrite(
  ctx: MutationContext | undefined,
  store: MutationStore,
  action: string,
  result: MutationResult | null,
  derivedSyncHint: { touchedNodeIds?: unknown; deletedNodeIds?: unknown } | null = null
): Promise<void> {
  if (typeof ctx?.maintainDerivedAfterWrite !== 'function') return;
  if (!result || result.changed === false) return;
  try {
    const docId = result.docId ?? result.baseDocId ?? null;
    if (action === 'doc.delete') {
      if (docId) {
        await ctx.maintainDerivedAfterWrite(docId, { deleted: true });
        // 删文档批量删向量/关键词行，lance 碎片一次性增大，计脏度让后台回收。
        store?.maintenance?.markDirty?.();
      }
    } else if (action === 'doc.refreshAddresses') {
      await ctx.maintainDerivedAfterWrite(docId || null, { allDocs: !docId });
    } else if (KEYWORD_REBUILD_ACTIONS.has(action) && docId) {
      // commit 带 derivedSync（受影响节点集）→ BM25 增量同步；其余（doc.create/history.* 无 hint）整篇重建。
      const sync = derivedSyncHint ?? (result.derivedSync as { touchedNodeIds?: unknown; deletedNodeIds?: unknown } | null);
      await ctx.maintainDerivedAfterWrite(docId, sync
        ? { touchedNodeIds: sync.touchedNodeIds, deletedNodeIds: sync.deletedNodeIds }
        : {});
      // 派生写产生 lance 碎片，计一次脏度（O(1)），由后台调度器低频回收。
      store?.maintenance?.markDirty?.();
    }
  } catch (error) {
    if (Array.isArray(result.sideEffects)) {
      result.sideEffects.push({
        effect: 'derived.maintain',
        ok: false,
        error: (error as { message?: string } | null | undefined)?.message || String(error)
      });
    }
  }
}

// store 容 null：mutation.actions 不落库（database-service 传 null），其余 action 由 requireStore
// 断言拦下——这是真签名，不再靠调用侧 as unknown 洗宽（§6-10）。
export async function runDatabaseWrite(
  store: MutationStore | null,
  payload: MutationPayload = {},
  ctx: MutationContext = {}
): Promise<MutationResult> {
  const action = normalizeMutationAction(payload.action || payload.type);
  if (!action) throw new Error(`Unknown database_write action: ${payload.action || payload.type || ''}`);
  if (action === 'mutation.actions') return { actions: databaseWriteActions() };
  requireStore(store);
  // 对象库 GC（运维动词）：不针对某文档、不进 edit branch——在分支路由前直接处理。
  if (action === 'objects.gc') return { ok: true, action, ...store.gcHistoryObjects() };

  if (shouldRouteToEditBranch(action)) {
    const activeBranch = activeEditBranchForMutation(store, payload, ctx);
    if (!activeBranch) throw new Error('当前文档没有活跃草稿，请先 draft');
    return dispatchEditBranchStage(store, activeBranch, action, payload);
  }

  const effects: EffectList = [];
  let result: MutationResult | null = null;
  // store / ctx 直传：MutationStore 现在是 IftreeStore alias，handlers/* 也都签 IftreeStore + WriteContext，
  // 不再需要每处 `as unknown as Parameters<...>[0]` 中转。
  if (action.startsWith('docFolder.')) result = handleDocFolderMutation(store, payload, action, effects) as MutationResult;
  else if (action.startsWith('doc.') || action === 'treeView.update' || action.startsWith('editBranch.')) result = await handleDocMutation(store, payload, ctx, action, effects) as MutationResult;
  else if (action.startsWith('ref.')) result = handleRefMutation(store, payload, action, effects) as MutationResult;
  else if (action.startsWith('editorHistory.')) result = await handleEditorHistoryMutation(store, payload, ctx, action, effects) as MutationResult;
  else if (action.startsWith('history.')) result = await handleHistoryMutation(store, payload, ctx, action, effects) as MutationResult;
  else if (action.startsWith('import.') || action === 'vector.ensureDoc') result = await handleImportServiceMutation(store, payload, ctx, action, effects) as MutationResult;
  else throw new Error(`Unhandled database_write action: ${action}`);

  // 派生索引维护（BM25 增量 / 碎片回收）对 KEYWORD_REBUILD_ACTIONS 后台执行——
  // 避免 commit 等大文档操作的维护耗时阻塞写返回、超出 MCP 客户端超时窗口
  // （主库事务已提交，客户端不知成功会重试 → 幂等灾难）。但「后台」不等于「脱离单写队列」：
  // 架构不变量是所有写经单队列硬串行，故 fire-and-forget 也经 ctx.enqueueWrite 入队执行，
  // 只是写请求不等它返回。维护失败非致命：关键词可重建、检索入口有缺失补建兜底。
  // delete/refreshAddresses 保持同步。队列缺省（测试/未接线）退化为直接后台执行。
  if (KEYWORD_REBUILD_ACTIONS.has(action)) {
    // 入队前快照 derivedSync hint：下方会把 result.derivedSync 删掉（不进响应），
    // 而维护任务在队列轮到它时才执行——届时 result.derivedSync 已删，若不先快照
    // 就退化成整篇重建（review #7）。
    const hint = (result && typeof result === 'object' ? result.derivedSync : null) as { touchedNodeIds?: unknown; deletedNodeIds?: unknown } | null;
    const run = () => maintainDerivedIndexAfterWrite(ctx, store, action, result, hint);
    if (typeof ctx?.enqueueWrite === 'function') {
      Promise.resolve(ctx.enqueueWrite(run)).catch(() => {});
    } else {
      run().catch(() => {});
    }
  } else {
    await maintainDerivedIndexAfterWrite(ctx, store, action, result);
  }
  // derivedSync 是给派生索引维护的内部 hint（commit 的受影响节点集），不进响应。
  // fire-and-forget 路径已先把 hint 快照进 run 闭包，此处删除不影响后续执行。
  if (result && typeof result === 'object' && 'derivedSync' in result) delete (result as Record<string, unknown>).derivedSync;
  return result ?? {};
}
