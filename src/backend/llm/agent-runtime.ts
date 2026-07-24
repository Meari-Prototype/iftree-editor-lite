import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, extname, resolve } from 'node:path';

import { databaseWriteToolSchema } from '../mutation-api.js';
import { databaseReadToolSchema } from '../query-api.js';
import { dbShellHelp, runDbShellArgv } from '../db-shell.js';
import { normalizeDatabaseCommand } from '../database-command.js';
import { normalizeStableId, sameStableId } from '../db/ids.js';
import { isSameOrChildPath } from '../path-utils.js';
import { configuredMaxOutputTokens, llmProtocol, normalizeReasoningEffort } from '../../agent/llm-api-config.js';
import {
  agentContentPreview,
  agentUserMessageContent,
  normalizeAgentImageAttachments
} from '../../agent/agent-message.js';
import type { AgentImageAttachment } from '../../agent/agent-message.js';
import { anthropicMessagesUrl, chatCompletionUrl, fetchLlmResponse, readJsonSseStream } from './chat-client.js';
import { normalizeAgentToolSettings } from './defaults.js';
// agent-runtime 拆分（§6-7）：共享小工具 / 工具 schema / web 安全 / 协议适配 / 历史压缩 / 卷组装
// 各自成件，本文件只剩上下文组装与 createAgentRuntime 闭包（工具执行 + 循环控制 + 会话管理）。
import {
  sanitize, clipText, isAbortError, agentAbortError, assertNotAborted,
  flattenTree, normalizeAgentMode, agentPermissionsForMode
} from './agent-shared.js';
import type { Json, AnyRecord, TreeNode, AgentMode, AgentPermissions } from './agent-shared.js';
import { normalizeNodePatch, agentOperationAction,
  proposeNodePatchToolSchema,
  proposeRefDeleteToolSchema, proposeSourceBindPathToolSchema, workspaceFileToolSchema,
  importLibraryDocumentToolSchema, deleteLibraryDocumentToolSchema, ensureDocVectorsToolSchema,
  webSearchToolSchema, bashToolSchema
} from './agent-tools-schema.js';
import { assertAgentOpenUrlAllowed, fetchAgentWebText, stripHtml, parseDuckDuckGoResults } from './agent-web.js';
import {
  parseToolArgs, jsonPreview, toolDisplayPreview, appendAgentToolCallDelta,
  appendReasoningContent, agentAssistantMessageForHistory, anthropicMessages, anthropicTools,
  agentMessageFromAnthropic, normalizeAgentUsage, openAiMessagesForRequest
} from './agent-protocol.js';
import type {
  ToolResult, AgentMessage, ApiConfig, OpenAiMessage, OpenAiToolDef, NormalizedAgentUsage,
  AnthropicThinkingBlock
} from './agent-protocol.js';
import {
  storedSessionHistory, mergeAgentHistorySources, summarizeToolResultForHistory,
  apiTurnMessagesForStorage, sanitizeApiHistoryForInjection
} from './agent-history.js';
import type { HistoryItem, ToolEvent, StoredSession } from './agent-history.js';

const EDIT_AGENT_WRITE_ACTIONS = new Set([
  'import.libraryDocument',
  'import.deleteDocument',
  'editBranch.begin',
  'editBranch.save',
  'editBranch.discard',
  'editBranch.undo',
  'editBranch.redo',
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

function databaseWriteAction(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const source = payload as AnyRecord;
  return String(source.action || source.type || '').trim();
}

function assertAgentDatabaseWriteAllowed(mode: AgentMode, payload: unknown): void {
  const action = databaseWriteAction(payload);
  if (mode === 'qa') throw new Error('当前模式没有数据库写入权限。');
  if (mode === 'edit' && !EDIT_AGENT_WRITE_ACTIONS.has(action)) {
    throw new Error(`协作模式不能执行数据库写动作：${action || '(empty)'}`);
  }
  if (action === 'history.certify') {
    throw new Error('certify 是 human 档专属动作，内置 Agent 不能执行。');
  }
}

function fullAgentDatabaseWriteToolSchema(): Json {
  const schema = databaseWriteToolSchema() as AnyRecord;
  const properties = (schema.properties || {}) as AnyRecord;
  const action = (properties.action || {}) as AnyRecord;
  const values = Array.isArray(action.enum)
    ? action.enum.filter((value: unknown) => value !== 'history.certify')
    : [];
  return {
    ...schema,
    properties: {
      ...properties,
      action: { ...action, enum: values }
    }
  };
}

interface AgentDoc {
  tree?: TreeNode | null;
  idByAddress?: Record<string, string>;
  refs?: Array<{ id: unknown; source_address?: unknown; target_address?: unknown; ref_kind?: unknown; [extra: string]: unknown }>;
  [extra: string]: unknown;
}

function findNodeByIdOrAddress(doc: AgentDoc | null | undefined, scope: { nodeId?: unknown; address?: unknown } = {}): TreeNode | null {
  if (!doc?.tree) return null;
  const nodes = flattenTree(doc.tree);
  const nodeId = normalizeStableId(scope.nodeId, null);
  if (nodeId) return nodes.find((node) => sameStableId(node.id, nodeId)) || null;
  const address = String(scope.address || '').trim();
  if (address) return nodes.find((node) => String(node.address) === address) || null;
  return doc.tree;
}

interface AgentDocInfo {
  docId: unknown;
  title: string;
  sourceType: string;
  sourcePath: string;
  imported: boolean;
  nodeCount: number;
  maxDepth: number;
  updatedAt: unknown;
}

interface ContentDoc {
  docId?: unknown;
  title?: string;
  source?: { type?: string; path?: string };
  meta?: { nodeCount?: unknown; maxDepth?: unknown; subtreeMaxDepth?: unknown; [extra: string]: unknown };
  updatedAt?: unknown;
}

function agentDocInfoFromContentDoc(doc: ContentDoc | null | undefined): AgentDocInfo {
  const meta = doc?.meta || {};
  const source = doc?.source || {};
  return {
    docId: doc?.docId || null,
    title: doc?.title || '',
    sourceType: source.type || '',
    sourcePath: source.path || '',
    imported: Boolean(doc?.docId),
    nodeCount: Number(meta.nodeCount) || 0,
    maxDepth: Number(meta.maxDepth ?? meta.subtreeMaxDepth) || 0,
    updatedAt: doc?.updatedAt || null
  };
}

function normalizeContextDepth(payload: AnyRecord = {}): number {
  const value = Number(payload.contextDepth ?? payload.context_depth ?? 2);
  return Number.isInteger(value) && value > 0 ? value : 2;
}

interface AgentContext {
  file: AgentDocInfo | null;
  permissions: AgentPermissions;
  selectedNode: { docId: unknown; nodeId: unknown; address: unknown } | null;
  treeIndex: string;
  llmWorkspace: LlmWorkspaceState | null;
}

interface LlmWorkspaceState {
  relativePath?: string;
  sizeBytes?: number;
  limitBytes?: number;
  overLimit?: boolean;
  cleanupCandidates?: Array<{ relativePath?: string; name?: string; sizeBytes?: number }>;
}

function formatAgentContextMessage(context: AgentContext): string {
  const parts: string[] = [];
  if (context.file) {
    parts.push(`当前目标文档：doc:${context.file.docId} ${context.file.title}（${context.file.nodeCount}节点，深度${context.file.maxDepth}）`);
  }
  parts.push(`权限：${context.permissions.label}`);
  if (context.selectedNode) {
    parts.push(`选中节点：${context.selectedNode.address}`);
  }
  if (context.llmWorkspace) {
    const state = context.llmWorkspace;
    const candidates = (state.cleanupCandidates || [])
      .slice(0, 12)
      .map((item) => `${item.relativePath || item.name || ''} ${item.sizeBytes || 0}B`)
      .join('\n');
    parts.push([
      '',
      'LLM workspace:',
      `path=${state.relativePath || '.iftree-llm-workspace'}`,
      `sizeBytes=${state.sizeBytes || 0}`,
      `limitBytes=${state.limitBytes || 0}`,
      `overLimit=${state.overLimit === true}`,
      candidates ? `oldestCleanupCandidates:\n${candidates}` : 'oldestCleanupCandidates='
    ].join('\n'));
  }
  if (context.treeIndex) {
    parts.push(`\n文档结构：\n${context.treeIndex}`);
  }
  return parts.join('\n');
}

// db 命令参考的注入文本：消息组装与默认上下文面板预览共用一份，保证「面板所见 = 模型所得」。
function agentDbHelpContextText(): string {
  return `db 命令参考（已预置，无需再运行 db help）：\n${dbShellHelp()}`;
}

const AGENT_HISTORY_COMPACTION_RATIO = 0.8;

function usageForCurrentApi(value: unknown, api: ApiConfig): NormalizedAgentUsage | null {
  if (!value || typeof value !== 'object') return null;
  const promptTokens = Number((value as { promptTokens?: unknown }).promptTokens);
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return null;
  return normalizeAgentUsage({ prompt_tokens: promptTokens }, api);
}

function shouldCompactAgentHistory(value: unknown, api: ApiConfig): boolean {
  const usage = usageForCurrentApi(value, api);
  return Boolean(
    usage
    && usage.contextLimit > 0
    && usage.ratio >= AGENT_HISTORY_COMPACTION_RATIO
  );
}

const REQUIRED_DEPS = [
  'getAgentStore', 'refreshDoc', 'readAgentSettings',
  'agentApiFromPayload', 'systemPromptSection', 'libraryPath',
  'libraryRelativePathForAgent'
] as const;

// host 注入的依赖接口。所有函数返回 unknown 让 runtime 内部按需 cast，避免与 host 端反向倒挂。
export interface AgentRuntimeDeps {
  sdk: { request: (type: string, body?: AnyRecord) => Promise<unknown> | unknown };
  getAgentStore: () => AgentStoreLike;
  refreshDoc: (docId: string) => AgentDoc | null;
  readAgentSettings: () => { personalPrompt?: string; tone?: string; toolSettings?: AnyRecord; [extra: string]: unknown };
  agentApiFromPayload: (payload: AnyRecord) => ApiConfig;
  systemPromptSection: (name: string, fallback?: string) => string;
  libraryPath: (relativePath?: string) => string;
  libraryRelativePathForAgent: (filePath: string) => string;
  sendAgentStream?: (requestId: string, event: AnyRecord) => void;
  fetchers?: () => unknown[];
  listLibraryChildren?: (relativePath: string) => Array<{ type: string; relativePath: string; size?: number; extension?: string }>;
  normalizeAgentLibraryPath?: (value: unknown) => string;
  llmWorkspacePath?: () => string;
  llmWorkspaceBinPath?: () => string;
  llmWorkspaceStatus?: () => LlmWorkspaceState | null;
  notifyLibraryChanged?: () => void;
  updateImportedSourcePaths?: (from: string, to: string, isDirectory: boolean) => void;
  debugLog?: (event: string, payload?: AnyRecord) => void;
}

interface AgentStoreLike {
  getSession(id: number): StoredSession | null;
  startSessionTurn(payload: AnyRecord): { id: number; [extra: string]: unknown };
  replaceSessionApiHistory(sessionId: number, apiMessages: unknown[]): void;
  finishSessionTurn(sessionId: number, result: AnyRecord, messages: HistoryItem[], apiMessages?: unknown[]): void;
  listSessions(query: { limit?: unknown }): Array<{ id: unknown; [extra: string]: unknown }>;
  deleteSession(id: number): void;
}

interface RunAgentResult {
  sessionId: number;
  answer: string;
  diffs: AnyRecord[];
  usage?: NormalizedAgentUsage | null;
  toolEvents: ToolEvent[];
  segments: AnyRecord[];
  changedDocIds: string[];
  canceled?: boolean;
  // db screenshot 截图因接口无视觉能力被拒时置 true：前端据此提示「你可能没有视觉能力」，
  // 与用户主动发图被拒（imageRequestRejected → 提示切换模型）区分。
  visionFallback?: boolean;
}

export interface AgentRuntime {
  runAgent(payload?: AnyRecord): Promise<RunAgentResult>;
  runTool(payload?: AnyRecord): Promise<unknown>;
  listAgentDiffs(): Promise<AnyRecord[]>;
  listAgentSessions(payload?: AnyRecord): Promise<unknown>;
  getAgentSession(payload?: AnyRecord): StoredSession | null;
  deleteAgentSession(payload?: AnyRecord): Promise<AnyRecord>;
  cancelAgentRequest(payload?: AnyRecord | string): AnyRecord;
  applyAgentDiff(diffId: unknown): Promise<AnyRecord>;
  rejectAgentDiff(diffId: unknown): Promise<AnyRecord>;
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  for (const key of REQUIRED_DEPS) {
    if (typeof (deps as unknown as AnyRecord)[key] !== 'function') {
      throw new Error(`createAgentRuntime: missing required dep "${key}"`);
    }
  }
  if (!deps.sdk || typeof deps.sdk.request !== 'function') {
    throw new Error('createAgentRuntime: missing required dep "sdk" (in-process backend SDK handle)');
  }

  const sendAgentStream = (requestId: string, event: AnyRecord): void => {
    if (!requestId) return;
    deps.sendAgentStream?.(requestId, event);
  };

  // agent 框架只通过 in-process SDK 句柄访问后端（与外部 agent 经 MCP 同契约的 request 信封），
  // 不直连 database 实例。database() 把触点的 run/write 信封适配成 sdk.request：
  //   · run(command, fallback) → database.run（buildAgentContext / admin_override / listAgentDiffs 的读，
  //     以及 agentBash 经 db-shell 的全部访问——db-shell 对 database 只用 .run）；
  //   · write(payload, ctx) → database.write，editBranch* 内联进 payload（与 mcp-server 写路径一致）。
  const sdk = deps.sdk;
  interface WriteContext { editBranchDocId?: unknown }
  const database = () => ({
    run: (command: AnyRecord, fallback: 'read' | 'write' | 'query' = 'read') => sdk.request('database.run', { databaseCommand: command, fallbackOperation: fallback }),
    write: (payload: AnyRecord, ctx: WriteContext = {}) => sdk.request('database.write', {
      payload: {
        ...payload,
        ...(ctx.editBranchDocId != null ? { docId: ctx.editBranchDocId } : {})
      }
    })
  });
  const databaseForAgentMode = (mode: AgentMode) => {
    const target = database();
    return {
      run: (command: AnyRecord, fallback: 'read' | 'write' | 'query' = 'read') => {
        const normalized = normalizeDatabaseCommand(command, fallback);
        if (normalized.operation === 'write') assertAgentDatabaseWriteAllowed(mode, normalized.payload);
        return target.run(command, fallback);
      },
      write: (payload: AnyRecord, ctx: WriteContext = {}) => {
        assertAgentDatabaseWriteAllowed(mode, payload);
        return target.write(payload, ctx);
      }
    };
  };
  const getAgentStore = () => deps.getAgentStore();
  const readAgentSettings = () => deps.readAgentSettings();
  const getToolSettings = () => normalizeAgentToolSettings(readAgentSettings().toolSettings || {});
  const activeAgentRequests = new Map<string, AbortController>();

  function docForAgent(docId: unknown): AgentDoc {
    const normalizedDocId = normalizeStableId(docId, null);
    if (!normalizedDocId) throw new Error('Document id is required');
    const doc = deps.refreshDoc(normalizedDocId);
    if (!doc) throw new Error(`Document not found: ${docId}`);
    return doc;
  }

  async function buildAgentContext(payload: AnyRecord = {}): Promise<AgentContext> {
    const docId = normalizeStableId(payload.docId, null);
    const mode = normalizeAgentMode(payload.mode);
    let file: AgentDocInfo | null = null;
    let selectedNode: { doc_id?: unknown; id?: unknown; address?: unknown } | null = null;
    let treeIndex = '';
    if (docId) {
      const docsResult = await database().run({
        operation: 'read',
        payload: { action: 'content.listDocs', include: 'source,timestamps' }
      }, 'read') as { docs?: ContentDoc[] } | null | undefined;
      const doc = (docsResult?.docs || []).find((item) => sameStableId(item.docId, docId)) || null;
      file = doc ? agentDocInfoFromContentDoc(doc) : null;
      const indexResult = await database().run({
        operation: 'read',
        payload: {
          action: 'content.getIndex',
          docId,
          depth: normalizeContextDepth(payload),
          format: 'ascii_tree',
          detail: 'summary'
        }
      }, 'read') as { text?: unknown } | null | undefined;
      treeIndex = String(indexResult?.text || '');
      const selectedNodeId = normalizeStableId(payload.selectedNodeId, null);
      if (selectedNodeId) {
        selectedNode = await database().run({
          operation: 'read',
          payload: { action: 'node.get', docId, nodeId: selectedNodeId }
        }, 'read') as { doc_id?: unknown; id?: unknown; address?: unknown } | null;
      }
    }
    return {
      file,
      permissions: agentPermissionsForMode(mode),
      selectedNode: selectedNode ? {
        docId: selectedNode.doc_id,
        nodeId: selectedNode.id,
        address: selectedNode.address
      } : null,
      treeIndex,
      llmWorkspace: deps.llmWorkspaceStatus?.() || null
    };
  }

  async function proposeAgentChanges(args: AnyRecord = {}, sessionId: number, context: Partial<AgentContext> = {}): Promise<unknown> {
    const operations = Array.isArray(args.operations) ? args.operations as AnyRecord[] : [];
    if (operations.length === 0) throw new Error('agent change proposal requires one operation');
    // A2A 提议写入文档唯一草稿；草稿必须已由用户显式打开，不隐式创建。
    const stage = (payload: AnyRecord, docId: unknown) => database().write(payload, { editBranchDocId: docId });
    const created: AnyRecord[] = [];
    for (const operation of operations) {
      const action = agentOperationAction(operation);
      if (!action) throw new Error(`Unsupported agent change action: ${operation.action || operation.type || 'empty'}`);
      if (action === 'source_bind_path') {
        // source 路径绑定是文件元数据、不是文档节点编辑，不走 A5-5 待审分支（15-4 待审=节点编辑）；由 full 档直接绑定。
        return { rejected: true, reason: 'source 路径绑定不走待审分支；请用 full 档直接绑定。' };
      }
      const docId = normalizeStableId(operation.docId || context.file?.docId, null);
      if (!docId) throw new Error('Agent change proposal requires a doc id');
      const doc = docForAgent(docId);
      if (action === 'node_patch') {
        const node = findNodeByIdOrAddress(doc, operation);
        if (!node) throw new Error('Agent node_patch target not found');
        const patch = normalizeNodePatch((operation.patch as AnyRecord) || operation);
        if (Object.keys(patch).length === 0) throw new Error('node_patch requires patch fields');
        const result = await stage({ action: 'node.update', nodeId: node.id, patch }, docId) as AnyRecord;
        created.push({ ...result, summary: operation.summary || `修改节点 ${node.address}` });
      } else if (action === 'ref_delete') {
        const refId = normalizeStableId(operation.refId, null);
        let ref: AnyRecord | null = refId ? (doc.refs?.find((item) => sameStableId(item.id, refId)) as AnyRecord | undefined) || null : null;
        if (!ref) {
          const sourceAddress = String(operation.sourceAddress || operation.source || '').trim();
          const targetAddress = String(operation.targetAddress || operation.target || '').trim();
          const refKind = String(operation.refKind || operation.kind || '').trim();
          ref = (doc.refs?.find((item) => (
            (!sourceAddress || item.source_address === sourceAddress)
            && (!targetAddress || item.target_address === targetAddress)
            && (!refKind || item.ref_kind === refKind)
          )) as AnyRecord | undefined) || null;
        }
        if (!ref) throw new Error('Agent ref_delete target not found');
        const result = await stage({ action: 'ref.delete', docId, refId: ref.id }, docId) as AnyRecord;
        created.push({ ...result, summary: operation.summary || `删除引用 ${ref.source_address} -> ${ref.target_address}` });
      }
    }
    return created;
  }

  function agentWorkspaceFile(args: AnyRecord = {}, permissions: AgentPermissions = agentPermissionsForMode('qa')): AnyRecord {
    const action = String(args.action || 'read').trim();
    const relativePath = (deps.normalizeAgentLibraryPath ?? ((value: unknown) => String(value || '')))((args.path as unknown) || (args.relativePath as unknown) || '');
    const canRead = Boolean(permissions.localFiles?.canRead);
    const canWrite = Boolean(permissions.localFiles?.canWrite);
    const assertRead = (): void => {
      if (!canRead) throw new Error('当前模式没有读取本地工作区文件的权限');
    };
    const assertWrite = (): void => {
      if (!canWrite) throw new Error('当前模式没有写入本地工作区文件的权限');
    };
    if (action === 'list') {
      assertRead();
      return (deps.listLibraryChildren?.(relativePath) || []).map((entry) => ({
        type: entry.type,
        path: entry.relativePath,
        size: entry.size,
        extension: entry.extension
      })) as unknown as AnyRecord;
    }
    if (action === 'read') {
      assertRead();
      const full = deps.libraryPath(relativePath);
      const stat = statSync(full);
      if (stat.isDirectory()) throw new Error('不能按文件读取文件夹');
      const encoding = String(args.encoding || 'utf8').toLowerCase();
      const limit = Math.max(1, Math.min(2_000_000, Number(args.limit) || 120_000));
      if (encoding === 'base64') {
        const raw = readFileSync(full);
        const content = raw.toString('base64');
        return {
          path: relativePath,
          encoding: 'base64',
          size: stat.size,
          extension: extname(relativePath).toLowerCase(),
          content: content.slice(0, limit),
          truncated: content.length > limit
        };
      }
      const text = readFileSync(full, 'utf8');
      return {
        path: relativePath,
        encoding: 'utf8',
        size: stat.size,
        extension: extname(relativePath).toLowerCase(),
        content: clipText(text, limit),
        truncated: text.length > limit
      };
    }
    if (action === 'write') {
      assertWrite();
      if (!relativePath) throw new Error('写入文件必须提供相对路径');
      const full = deps.libraryPath(relativePath);
      mkdirSync(dirname(full), { recursive: true });
      const encoding = String(args.encoding || 'utf8').toLowerCase();
      if (encoding === 'base64') writeFileSync(full, Buffer.from(String(args.content || ''), 'base64'));
      else writeFileSync(full, String(args.content ?? args.text ?? ''), 'utf8');
      deps.notifyLibraryChanged?.();
      return { ok: true, action, path: relativePath };
    }
    if (action === 'delete') {
      assertWrite();
      if (!relativePath) throw new Error('删除文件必须提供相对路径');
      rmSync(deps.libraryPath(relativePath), { recursive: true, force: true });
      deps.notifyLibraryChanged?.();
      return { ok: true, action, path: relativePath };
    }
    if (action === 'mkdir') {
      assertWrite();
      if (!relativePath) throw new Error('新建文件夹必须提供相对路径');
      mkdirSync(deps.libraryPath(relativePath), { recursive: true });
      deps.notifyLibraryChanged?.();
      return { ok: true, action, path: relativePath };
    }
    if (action === 'move') {
      assertWrite();
      const toPath = (deps.normalizeAgentLibraryPath ?? ((value: unknown) => String(value || '')))(args.toPath || args.targetPath || '');
      if (!relativePath || !toPath) throw new Error('移动文件必须提供 path 和 toPath');
      const from = deps.libraryPath(relativePath);
      const to = deps.libraryPath(toPath);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      deps.updateImportedSourcePaths?.(from, to, statSync(to).isDirectory());
      deps.notifyLibraryChanged?.();
      return { ok: true, action, path: relativePath, toPath };
    }
    throw new Error(`不支持的工作区文件操作：${action}`);
  }

  async function fetchTextUrl(url: string, { timeoutMs = 12000, signal = null }: { timeoutMs?: number; signal?: AbortSignal | null } = {}): Promise<string> {
    assertNotAborted(signal);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, timeoutMs));
    try {
      const response = await fetchAgentWebText(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 IF-Tree-Agent-WebSearch/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5'
        },
        signal: controller.signal
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
      return response.text;
    } catch (error) {
      if (signal?.aborted) throw agentAbortError();
      if (timedOut) throw new Error('网页读取失败：请求超时');
      if (isAbortError(error)) throw error;
      throw new Error(`网页读取失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function agentWebSearch(args: AnyRecord = {}, { signal = null }: { signal?: AbortSignal | null } = {}): Promise<AnyRecord> {
    assertNotAborted(signal);
    const toolSettings = getToolSettings();
    const mode = String(args.mode || (args.url ? 'open' : 'search')).trim();
    const limit = Math.max(1, Math.min(toolSettings.webSearchResultLimit, Number(args.limit) || toolSettings.webSearchResultLimit));
    if (mode === 'open') {
      const url = assertAgentOpenUrlAllowed(args.url || '');
      const html = await fetchTextUrl(url, { signal });
      return {
        mode,
        url,
        title: stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
        content: clipText(stripHtml(html), Math.max(1000, Math.min(toolSettings.webOpenCharLimit, Number(args.charLimit) || toolSettings.webOpenCharLimit)))
      };
    }
    const query = String(args.query || args.q || '').trim();
    if (!query) throw new Error('web_search search 需要 query');
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await fetchTextUrl(url, { signal });
    return {
      mode: 'search',
      query,
      results: parseDuckDuckGoResults(html, limit)
    };
  }

  function splitCommandLine(command: unknown = ''): string[] {
    const text = String(command || '');
    const args: string[] = [];
    let current = '';
    let quote = '';
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === quote) quote = '';
        else current += char;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (/\s/.test(char)) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }
      current += char;
    }
    if (current) args.push(current);
    return args;
  }

  function resolveAgentShellCwd(value: unknown = ''): string {
    const workspaceRoot = deps.llmWorkspacePath?.() || '';
    const libraryRoot = deps.libraryPath('');
    const raw = String(value || '').trim();
    if (!raw || raw === '.' || raw === 'workspace' || raw === '.iftree-llm-workspace') return workspaceRoot;
    if (raw === 'library') return libraryRoot;
    const target = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')
      ? resolve(raw)
      : resolve(workspaceRoot, raw);
    if (isSameOrChildPath(target, workspaceRoot) || isSameOrChildPath(target, libraryRoot)) return target;
    throw new Error('bash cwd must stay inside library or .iftree-llm-workspace');
  }

  interface ShellResult { cwd: string; exitCode: number | null; stdout: string; stderr: string; ok: boolean }

  // 内置 agent 的 bash 只读写本地文档 / JSON / MD、只读 library，不需要任何 LLM 凭据。
  // host 启动时把整个 .env（含全部 IFTREE_LLM_API_KEY_* / OPENAI_API_KEY 等）灌进了
  // process.env，原样继承会让 agent 经 env/printenv 读走所有厂商 key。这里按 key 模式
  // 剔除敏感环境变量，PATH/HOME 等正常运行所需项保留。
  const SENSITIVE_ENV_PATTERN = /(^|_)(API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)(_|$)/i;
  function sanitizeShellEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (SENSITIVE_ENV_PATTERN.test(key)) continue;
      env[key] = value;
    }
    return env;
  }

  async function runShellCommand(command: string, options: { cwd?: unknown; timeoutMs?: number; context?: AnyRecord; signal?: AbortSignal | null } = {}): Promise<ShellResult> {
    const cwd = resolveAgentShellCwd(options.cwd);
    const timeoutMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(options.timeoutMs) || 120_000));
    const env: NodeJS.ProcessEnv = {
      ...sanitizeShellEnv(process.env),
      IFTREE_CURRENT_DOC_ID: String((options.context as { file?: { docId?: unknown } })?.file?.docId || ''),
      PATH: deps.llmWorkspaceBinPath?.()
        ? `${deps.llmWorkspaceBinPath()}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`
        : process.env.PATH
    };
    const shell = process.platform === 'win32'
      ? { command: 'powershell.exe', args: ['-NoProfile', '-Command', command] }
      : { command: 'bash', args: ['-lc', command] };
    return new Promise<ShellResult>((resolvePromise, rejectPromise) => {
      const child = spawn(shell.command, shell.args, { cwd, env, windowsHide: true });
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let stdout = '';
      let stderr = '';
      const settle = <T>(fn: (value: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener?.('abort', stopOnAbort);
        fn(value);
      };
      timer = setTimeout(() => {
        child.kill();
        settle(rejectPromise, new Error(`bash command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const stopOnAbort = (): void => {
        child.kill();
        settle(rejectPromise, agentAbortError());
      };
      options.signal?.addEventListener?.('abort', stopOnAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 200_000) stdout = `${stdout.slice(0, 200_000)}\n[stdout truncated]`;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 80_000) stderr = `${stderr.slice(0, 80_000)}\n[stderr truncated]`;
      });
      child.on('error', (error: Error) => settle(rejectPromise, error));
      child.on('close', (code: number | null) => settle(resolvePromise, { cwd, exitCode: code, stdout, stderr, ok: code === 0 }));
    });
  }

  async function agentBash(args: AnyRecord = {}, permissions: AgentPermissions, context: Partial<AgentContext> = {}, signal: AbortSignal | null = null): Promise<AnyRecord> {
    const command = String(args.command || '').trim();
    if (!command) throw new Error('bash requires command');
    const argv = splitCommandLine(command);
    if (argv[0] === 'db') {
      // 数据面动词（import/vectors/delete 含内）已经 db 契约走 L4 action，无需注入服务函数；
      // 只注入 agent 能力（ask_agent/shell/web 动词消费）。
      const result = await runDbShellArgv(databaseForAgentMode(permissions.mode) as never, argv as never, {
        currentDocId: context.file?.docId,
        agentMode: permissions.mode,
        captureScreenshot: () => sdk.request('ui.screenshot'),
        // 嵌套 ask_agent 继承父 abort：父请求取消时，子 agent 也用同一 signal 停下，
        // 否则 requestId 为空的子 agent 不入 activeAgentRequests、跑到完（孤儿）。
        askAgent: (payload: AnyRecord = {}) => runAgent({ ...payload, signal } as never),
        agentTool: ({ name, args: toolArgs }: { name: string; args: AnyRecord }) => runAgentTool(name, toolArgs, {
          mode: permissions.mode,
          sessionId: 0,
          context: context as AgentContext,
          signal
        })
      } as never) as { text?: string; image?: AgentImageAttachment };
      return {
        ok: true,
        command,
        stdout: result.text || '',
        stderr: '',
        exitCode: 0,
        ...(result.image ? { image: result.image } : {})
      };
    }
    if (permissions.mode !== 'full') {
      return { rejected: true, reason: '当前模式只允许通过 bash 执行 db 只读命令；真实 shell 命令需要完全权限。' };
    }
    return runShellCommand(command, {
      cwd: args.cwd,
      timeoutMs: Number(args.timeoutMs) || undefined,
      context,
      signal
    }) as unknown as Promise<AnyRecord>;
  }

  interface ToolDef {
    type: 'function';
    function: { name: string; description: string; parameters: Json };
  }

  function agentTools(mode: AgentMode): ToolDef[] {
    const tools: ToolDef[] = [
      {
        type: 'function',
        function: {
          name: 'admin_override',
          description: '进阶只读查询（高级/底层入口，绕过 db 直接调原始 action）。常规检索与读取请优先用 bash 的 db 命令（db find --semantic / db read / db index 等，已替你组装参数、注入当前文档、格式化输出）；仅当 db 命令满足不了时，才用本工具按 action 直调底层只读 API。可用 action 与参数用法见 `db help`。',
          parameters: databaseReadToolSchema() as Json
        }
      }
    ];
    tools.push(
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a command. db commands are available in every mode; non-db shell commands require full mode and cwd inside library or .iftree-llm-workspace.',
          parameters: bashToolSchema()
        }
      },
      {
        type: 'function',
        function: {
          name: 'workspace_file',
          description: 'Operate on files inside the library workspace. Current mode permissions decide whether write/delete/move are accepted.',
          parameters: workspaceFileToolSchema()
        }
      }
    );
    if (mode === 'edit' || mode === 'full') {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'import_library_document',
            description: '导入 library 内尚未导入的真实文件。relativePath 必须是 library 相对路径；工具调用进入无头普通导入入口。mode 默认 simple：simple=格式识别目录结构并切到段落；complete=simple 后切到句子；vector=按字数切文本块；direct=全文不切直接塞到节点 1。smart 仅为兼容值，通用入口尚未接入；智能导入应走应用内独立 Agent 工作流或 db import-json。',
            parameters: importLibraryDocumentToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'delete_library_document',
            description: '删除已导入文档的数据库 doc 及关联数据，不删除 library 中的真实文件。删除后 library_index 不应再看到该 doc id。',
            parameters: deleteLibraryDocumentToolSchema()
          }
        }
      );
    }
    if (mode === 'edit') {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'propose_node_patch',
            description: '协作模式专用：为一个已有节点生成待审修改。用户确认后才应用。',
            parameters: proposeNodePatchToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'propose_ref_delete',
            description: '协作模式专用：生成一条待审引用删除。用户确认后才应用。',
            parameters: proposeRefDeleteToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'propose_source_bind_path',
            description: '协作模式专用：生成当前文档绑定 library 相对路径的待审变更。用户确认后才应用。',
            parameters: proposeSourceBindPathToolSchema()
          }
        }
      );
    }
    if (mode === 'full') {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'database_write',
            description: '完全权限专用：白名单数据库写 API；不接受裸 SQL，也不暴露 human 专属 certify。',
            parameters: fullAgentDatabaseWriteToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'ensure_doc_vectors',
            description: '完全权限专用：为已导入文档补建语义向量。该操作消耗大量算力，只在 full 档开放。',
            parameters: ensureDocVectorsToolSchema()
          }
        },
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: '完全权限专用：联网搜索或读取网页内容。先用 search 拿结果，需要正文时再用 open 打开具体 URL。',
            parameters: webSearchToolSchema()
          }
        }
      );
    }
    const names = new Set<string>();
    return tools.filter((tool) => {
      const name = tool?.function?.name || '';
      if (!name || names.has(name)) return false;
      names.add(name);
      return true;
    });
  }

  interface RunAgentToolCtx { mode: AgentMode; sessionId: number; context: Partial<AgentContext>; signal: AbortSignal | null }

  async function runAgentTool(name: string, args: AnyRecord, { mode, sessionId, context, signal }: RunAgentToolCtx): Promise<unknown> {
    assertNotAborted(signal);
    const permissions = agentPermissionsForMode(mode);
    if (name === 'search_manifest' || name === 'fetch_content') {
      return { rejected: true, reason: '内容查询请用 bash 的 db 命令（db find/read/index…）；进阶可用 admin_override 工具。' };
    }
    if (name === 'admin_override') return database().run({ operation: 'read', payload: args }, 'read');
    if (name === 'bash') return agentBash(args, permissions, context, signal);
    if (name === 'workspace_file') return agentWorkspaceFile(args, permissions);
    if (name === 'web_search') {
      if (mode !== 'full') return { rejected: true, reason: '当前模式不能联网检索。' };
      return agentWebSearch(args, { signal });
    }
    if (name === 'propose_changes') {
      return { rejected: true, reason: '待审变更工具已拆分；请改用具体的 propose_node_*、propose_ref_* 或 propose_source_bind_path。' };
    }
    if (name === 'propose_node_patch') {
      if (mode !== 'edit') return { rejected: true, reason: '当前模式不能生成待审变更。' };
      return proposeAgentChanges({ operations: [{ ...args, action: 'node_patch' }] }, sessionId, context);
    }
    if (name === 'propose_ref_delete') {
      if (mode !== 'edit') return { rejected: true, reason: '当前模式不能生成待审变更。' };
      return proposeAgentChanges({ operations: [{ ...args, action: 'ref_delete' }] }, sessionId, context);
    }
    if (name === 'propose_source_bind_path') {
      if (mode !== 'edit') return { rejected: true, reason: '当前模式不能生成待审变更。' };
      return proposeAgentChanges({ operations: [{ ...args, action: 'source_bind_path' }] }, sessionId, context);
    }
    if (name === 'import_library_document') {
      if (mode !== 'edit' && mode !== 'full') return { rejected: true, reason: '当前模式不能导入 library 文档。' };
      return sdk.request('import.libraryDocument', { payload: args });
    }
    if (name === 'delete_library_document') {
      if (mode !== 'edit' && mode !== 'full') return { rejected: true, reason: '当前模式不能删除已导入文档。' };
      return sdk.request('import.deleteDocument', { payload: args });
    }
    if (name === 'ensure_doc_vectors') {
      if (mode !== 'full') return { rejected: true, reason: '向量补建消耗大量算力，只允许完全权限模式执行。' };
      return sdk.request('vector.ensureDoc', { payload: args });
    }
    if (name === 'database_write') {
      if (mode !== 'full') return { rejected: true, reason: '当前模式没有直接数据库写入权限。' };
      const baseDocId = normalizeStableId(args.docId ?? args.doc_id ?? context.file?.docId, null);
      if (!baseDocId) {
        return { rejected: true, reason: 'LLM 数据库写入需要当前 doc id。' };
      }
      return databaseForAgentMode(mode).write(args, {
        editBranchDocId: baseDocId
      });
    }
    return { rejected: true, reason: `未知工具：${name}` };
  }

  interface CallAgentChatOptions {
    requestId?: string;
    reasoningEffort?: string;
    signal?: AbortSignal | null;
    includeUsage?: boolean;
  }

  // Anthropic SSE 流式解析：message_start / content_block_* / message_delta 事件序列 →
  // 与 openai 流式分支同款 AgentMessage，并增量下发同款 reasoning/delta 流事件（面板追加式实时渲染）。
  // usage 不在此下发：回到循环后统一处理（与 openai 分支的 message.usage 路径一致）。
  async function readAnthropicStream(
    response: Response,
    requestId: string,
    api: ApiConfig,
    options: CallAgentChatOptions
  ): Promise<AgentMessage> {
    const message: AgentMessage = { role: 'assistant', content: '', tool_calls: [] };
    const thinkingBlocks: AnthropicThinkingBlock[] = [];
    const blockKinds = new Map<number, { type: string; thinkingIndex?: number; toolIndex?: number }>();
    const rawUsage: AnyRecord = {};
    await readJsonSseStream(response, (chunkRaw: unknown) => {
      const chunk = (chunkRaw || {}) as AnyRecord;
      assertNotAborted(options.signal);
      const type = String(chunk.type || '');
      if (type === 'message_start') {
        const usage = ((chunk.message as AnyRecord | undefined)?.usage || null) as AnyRecord | null;
        if (usage) Object.assign(rawUsage, usage);
        return;
      }
      if (type === 'content_block_start') {
        const index = Number(chunk.index) || 0;
        const block = (chunk.content_block || {}) as AnyRecord;
        const blockType = String(block.type || '');
        if (blockType === 'tool_use') {
          const toolCalls = message.tool_calls || (message.tool_calls = []);
          // 防御性 seed：规范网关（千问 anthropic-compatible 实测）start 帧给空对象 input={}、
          // 随后 input_json_delta 累加——此时绝不能把 "{}" 当种子（否则拼成 "{}{...}" 非法
          // JSON，parseToolArgs 解析失败工具收空参，即 review #2）。只有 start 帧带【非空】
          // input（个别不规范网关一次给全且不发 delta）才 seed 完整 JSON；空对象留空待 delta。
          const seedInput = (block.input != null && typeof block.input === 'object' && Object.keys(block.input).length > 0)
            ? JSON.stringify(block.input)
            : '';
          toolCalls.push({
            id: String(block.id || ''),
            type: 'function',
            function: { name: String(block.name || ''), arguments: seedInput }
          });
          blockKinds.set(index, { type: blockType, toolIndex: toolCalls.length - 1 });
        } else if (blockType === 'thinking') {
          thinkingBlocks.push({
            type: 'thinking',
            thinking: String(block.thinking || ''),
            signature: String(block.signature || '')
          });
          blockKinds.set(index, { type: blockType, thinkingIndex: thinkingBlocks.length - 1 });
        } else {
          blockKinds.set(index, { type: blockType });
        }
        return;
      }
      if (type === 'content_block_delta') {
        const index = Number(chunk.index) || 0;
        const delta = (chunk.delta || {}) as AnyRecord;
        const deltaType = String(delta.type || '');
        if (deltaType === 'text_delta' && delta.text) {
          const text = String(delta.text);
          message.content = `${message.content || ''}${text}`;
          sendAgentStream(requestId, { type: 'delta', text });
          return;
        }
        if (deltaType === 'thinking_delta' && delta.thinking) {
          const text = String(delta.thinking);
          const entry = blockKinds.get(index);
          const block = entry?.thinkingIndex != null ? thinkingBlocks[entry.thinkingIndex] : null;
          if (block) block.thinking = `${block.thinking}${text}`;
          appendReasoningContent(message, text);
          sendAgentStream(requestId, { type: 'reasoning', text });
          return;
        }
        if (deltaType === 'signature_delta' && delta.signature) {
          const entry = blockKinds.get(index);
          const block = entry?.thinkingIndex != null ? thinkingBlocks[entry.thinkingIndex] : null;
          if (block) block.signature = `${block.signature || ''}${String(delta.signature)}`;
          return;
        }
        if (deltaType === 'input_json_delta' && delta.partial_json) {
          const entry = blockKinds.get(index);
          const call = entry?.toolIndex != null ? message.tool_calls?.[entry.toolIndex] : null;
          if (call?.function) call.function.arguments = `${call.function.arguments || ''}${String(delta.partial_json)}`;
        }
        return;
      }
      if (type === 'message_delta') {
        const usage = (chunk.usage || null) as AnyRecord | null;
        if (usage) Object.assign(rawUsage, usage);
        return;
      }
      if (type === 'error') {
        const detail = (chunk.error || {}) as AnyRecord;
        throw new Error(`Agent API 流式返回错误：${String(detail.type || '')} ${String(detail.message || '')}`.trim());
      }
      // content_block_stop / message_stop / ping：无需处理。
    }, { signal: options.signal });
    message.tool_calls = (message.tool_calls || []).filter((call) => call?.id || call?.function?.name);
    const thinking = thinkingBlocks.filter((block) => block.thinking);
    if (thinking.length > 0) message.anthropic_thinking = thinking;
    message.usage = normalizeAgentUsage(rawUsage, api);
    return message;
  }

  // 视觉兜底（db screenshot 回执图片被接口拒绝时）：把请求历史里的图片块就地降级为文字占位，
  // 保证去掉图片后的重试不再因同一原因失败；持久化的 api 历史也随之不再携带图片。
  function dropImageBlocksFromMessages(list: OpenAiMessage[]): number {
    let dropped = 0;
    for (const item of list) {
      if (!Array.isArray(item?.content)) continue;
      const blocks = item.content as AnyRecord[];
      if (!blocks.some((block) => block?.type === 'image')) continue;
      item.content = blocks.map((block) => (
        block?.type === 'image' ? { type: 'text', text: '（图片内容已从请求中移除）' } : block
      ));
      dropped += 1;
    }
    return dropped;
  }

  function agentMessagesForDebug(messages: OpenAiMessage[]): OpenAiMessage[] {
    return messages.map((message) => {
      if (!Array.isArray(message?.content)) return message;
      return {
        ...message,
        content: message.content.map((block) => {
          if (!block || typeof block !== 'object' || (block as AnyRecord).type !== 'image') return block;
          const image = (block as AnyRecord).image as AnyRecord | undefined;
          return {
            ...(block as AnyRecord),
            image: {
              ...image,
              data: `[base64 ${String(image?.data || '').length} chars]`
            }
          };
        })
      };
    });
  }

  async function callAgentChat(api: ApiConfig, messages: OpenAiMessage[], tools: OpenAiToolDef[], options: CallAgentChatOptions = {}): Promise<AgentMessage> {
    const requestId = String(options.requestId || '');
    const stream = Boolean(requestId);
    const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort, api);
    assertNotAborted(options.signal);
    // LLM 调试（debug 功能，开关见 headless-agent-host：IFTREE_DEBUG_LOGGING / config.debugLogging）：
    // 记下每次发给模型的请求与模型返回；图片二进制只记类型和长度，避免 base64 淹没调试日志。
    const debugModel = api.model || 'deepseek-v4-pro';
    deps.debugLog?.('llm.request', {
      model: debugModel,
      stream,
      reasoningEffort: reasoningEffort || null,
      tools: Array.isArray(tools) ? tools.map((tool) => tool?.function?.name).filter(Boolean) : [],
      messages: agentMessagesForDebug(messages)
    });
    const logLlmResponse = (msg: AgentMessage): void => deps.debugLog?.('llm.response', {
      model: debugModel,
      content: String(msg?.content || ''),
      toolCalls: Array.isArray(msg?.tool_calls)
        ? msg.tool_calls.map((call) => ({ name: call?.function?.name || '', arguments: call?.function?.arguments || '' }))
        : [],
      usage: msg?.usage || null
    });
    if (llmProtocol(api) === 'anthropic-compatible') {
      const maxTokens = configuredMaxOutputTokens(api);
      if (!maxTokens) {
        throw new Error('Anthropic-compatible API 需要在 API 配置中填写最大输出 token。');
      }
      const converted = anthropicMessages(messages);
      const anthropicBody: AnyRecord = {
        model: api.model || 'deepseek-v4-pro',
        max_tokens: maxTokens,
        temperature: 0.2,
        system: converted.system,
        messages: converted.messages
      };
      const anthropicToolList = anthropicTools(tools);
      if (anthropicToolList.length > 0) anthropicBody.tools = anthropicToolList;
      if (stream) anthropicBody.stream = true;
      if (reasoningEffort) {
        if (String(api.model || '').trim().toLowerCase() === 'qwen3.8-max-preview') {
          anthropicBody.reasoning_effort = reasoningEffort;
        } else {
          anthropicBody.output_config = {
            ...(api.outputConfig && typeof api.outputConfig === 'object' ? api.outputConfig : {}),
            effort: reasoningEffort
          };
        }
      }
      const response = await fetchLlmResponse(anthropicMessagesUrl(api.baseUrl, api.fullUrl), {
        method: 'POST',
        headers: {
          'x-api-key': String(api.apiKey || ''),
          'anthropic-version': String(api.anthropicVersion || '2023-06-01'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(anthropicBody)
      }, {
        fetchers: deps.fetchers?.() as never,
        signal: options.signal,
        errorPrefix: 'Agent API 请求失败',
        timeoutMs: Math.max(1000, Number(process.env.IFTREE_AGENT_TIMEOUT_MS) || 45000)
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Agent API 请求失败：${response.status} ${response.statusText}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
      }
      // 流式（SSE）：与 openai 分支同事件契约——reasoning/delta 增量下发，面板追加式实时渲染；
      // 服务商若忽略 stream 回普通 JSON，content-type 不含 event-stream，落回整段解析兜底。
      const isEventStream = /event-stream/i.test(String(response.headers.get('content-type') || ''));
      if (stream && isEventStream) {
        const streamMessage = await readAnthropicStream(response, requestId, api, options);
        logLlmResponse(streamMessage);
        return streamMessage;
      }
      const json = await response.json() as AnyRecord;
      const anthropicMessage = agentMessageFromAnthropic(json, api);
      logLlmResponse(anthropicMessage);
      return anthropicMessage;
    }
    const body: AnyRecord = {
      model: api.model || 'deepseek-v4-pro',
      temperature: 0.2,
      messages: openAiMessagesForRequest(messages)
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (stream) {
      body.stream = true;
      if (options.includeUsage !== false) body.stream_options = { include_usage: true };
    }
    const response = await fetchLlmResponse(chatCompletionUrl(api.baseUrl, api.fullUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${api.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }, {
      fetchers: deps.fetchers?.() as never,
      signal: options.signal,
      errorPrefix: 'Agent API 请求失败',
      // 本地慢模型（如 ollama 小模型）单轮可能远超默认 45s；用 IFTREE_AGENT_TIMEOUT_MS 调大，默认仍 45s。
      timeoutMs: Math.max(1000, Number(process.env.IFTREE_AGENT_TIMEOUT_MS) || 45000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (stream && options.includeUsage !== false && /stream_options|include_usage/i.test(detail)) {
        return callAgentChat(api, messages, tools, { ...options, includeUsage: false });
      }
      throw new Error(`Agent API 请求失败：${response.status} ${response.statusText}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
    }
    if (stream) {
      const message: AgentMessage = { role: 'assistant', content: '', tool_calls: [] };
      await readJsonSseStream(response, (chunkRaw: unknown) => {
        const chunk = (chunkRaw || {}) as AnyRecord;
        assertNotAborted(options.signal);
        if (chunk?.usage) {
          message.usage = normalizeAgentUsage(chunk.usage, api);
          sendAgentStream(requestId, { type: 'usage', usage: message.usage });
        }
        const choice = (chunk?.choices as Array<AnyRecord> | undefined)?.[0];
        const delta = (choice?.delta as AnyRecord) || {};
        appendReasoningContent(message, delta.reasoning_content);
        if (delta.reasoning_content) {
          sendAgentStream(requestId, { type: 'reasoning', text: delta.reasoning_content });
        }
        if (typeof delta.content === 'string' && delta.content) {
          message.content = `${message.content || ''}${delta.content}`;
          sendAgentStream(requestId, { type: 'delta', text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const toolDelta of delta.tool_calls as AnyRecord[]) appendAgentToolCallDelta(message.tool_calls || [], toolDelta);
        }
      }, { signal: options.signal });
      message.tool_calls = (message.tool_calls || []).filter((call) => call?.id || call?.function?.name);
      logLlmResponse(message);
      return message;
    }
    const json = await response.json() as { choices?: Array<{ message?: AgentMessage }>; usage?: unknown };
    const message: AgentMessage = (json?.choices?.[0]?.message as AgentMessage) || { role: 'assistant' };
    message.usage = normalizeAgentUsage(json?.usage, api);
    logLlmResponse(message);
    return message;
  }

  function agentSystemPrompt(mode: AgentMode, personalPrompt: string = '', tone: string = ''): string {
    const fixedPrompt = String(personalPrompt || '').trim();
    // 提示词文案以 system_prompt.md 为单一真相（经语言模块按键取值）。原先这里硬编码了一整套
    // 与 md 重复的 fallback（agent.base 的 P0-P3 全文），但 md 段落齐全、运行时从不触发——已删。
    // 注：随之删除的还有 edit/full 模式往 fallback 里 push 的几条额外指令（本地文件相对路径限制、
    // 联网说明、database_write 用法）——它们因 md 的 agent.base 覆盖而一直未生效；若需生效，
    // 应补进 system_prompt.md 的 agent.base / agent.mode.* 段（内容决策，留给用户单独定）。
    const basePrompt = deps.systemPromptSection('agent.base', '');
    // 语气档位（个性化设置页）→ agent.tone.* 段；放在用户固定说明之前，用户的原话优先级更高。
    const tonePrompt = tone ? deps.systemPromptSection(`agent.tone.${tone}`, '') : '';
    const modePrompt = deps.systemPromptSection(`agent.mode.${mode}`, '');
    return [
      basePrompt,
      tonePrompt,
      fixedPrompt ? `用户固定额外说明：\n${fixedPrompt}` : '',
      modePrompt,
      '如果信息不足，说明需要读取哪些来源，不要编造。'
    ].filter(Boolean).join('\n');
  }


  async function runAgent(payload: AnyRecord = {}): Promise<RunAgentResult> {
    const mode = normalizeAgentMode(payload.mode);
    const prompt = String(payload.prompt || '').trim();
    const attachments = normalizeAgentImageAttachments(payload.attachments);
    const requestId = String(payload.requestId || '').trim();
    const reasoningEffort = String(payload.reasoningEffort || '').trim();
    if (!prompt && attachments.length === 0) throw new Error('Agent 输入为空');
    const abortController = new AbortController();
    // 嵌套 ask_agent 可传入父 signal：父 abort 时子 agent 一并停。自己仍是独立 controller
    // （可单独取消），但父 signal 触发时同步 abort 本 controller。
    const parentSignal = (payload.signal && typeof (payload.signal as AbortSignal).aborted === 'boolean')
      ? payload.signal as AbortSignal
      : null;
    if (parentSignal) {
      if (parentSignal.aborted) abortController.abort();
      else parentSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
    const signal = abortController.signal;
    if (requestId) activeAgentRequests.set(requestId, abortController);
    let context: AgentContext;
    try {
      context = await buildAgentContext(payload);
    } catch (error) {
      if (requestId && activeAgentRequests.get(requestId) === abortController) {
        activeAgentRequests.delete(requestId);
      }
      throw error;
    }
    const agentStore = getAgentStore();
    const incomingSessionId = Number(payload.sessionId);
    const existingSession = Number.isInteger(incomingSessionId) && incomingSessionId > 0
      ? agentStore.getSession(incomingSessionId)
      : null;
    const session = agentStore.startSessionTurn({
      sessionId: payload.sessionId,
      mode,
      prompt,
      docId: context.file?.docId || null,
      selectedNodeId: context.selectedNode?.nodeId || null,
      context
    });
    const agentSettings = readAgentSettings();
    const api = deps.agentApiFromPayload(payload);
    const tools = agentTools(mode) as unknown as OpenAiToolDef[];
    const history = mergeAgentHistorySources(
      storedSessionHistory(existingSession),
      payload.history
    );
    // 完整循环历史：优先逐字回放存储的 apiMessages（含 CoT + 工具调用与结果，跨轮不做任何裁剪，
    // 模型因此记得自己跑过哪些工具、拿到过什么结果）；老会话（尚无 apiMessages）退化为纯文本问答历史，
    // payload.history 仅作后端无记录时的兜底。
    const storedApiHistory = sanitizeApiHistoryForInjection(existingSession?.result?.apiMessages);
    const historyMessages: OpenAiMessage[] = storedApiHistory.length > 0
      ? storedApiHistory
      : history.map((item) => ({
          role: item.role,
          content: item.role === 'assistant'
            ? String(item.content || '')
            : agentUserMessageContent(item.content, normalizeAgentImageAttachments(item.attachments))
        }));
    // 拼接语义（只增不改）：每次调用 = 既有字节 + 本轮新增块。既有部分（系统提示、db 参考、
    // 全部历史）跨轮一字不动、恒定命中缓存；本轮新增块 = [当前文档上下文, 当前提问]（工具循环
    // 与收尾随后追加进同一块）。文档上下文随轮次入历史：第 N 轮在哪个文档查的，历史里就留着
    // 第 N 轮的文档状态——换文档不改写历史，a 文档查到的信息不会被误记成 b 文档的。
    const fixedPrefixMessages: OpenAiMessage[] = [
      { role: 'system', content: agentSystemPrompt(mode, agentSettings.personalPrompt, agentSettings.tone) },
      // db 帮助预置进默认上下文：模型几乎每轮先跑一次 db help 拿契约，灌入后省去这次往返。
      // 文本以 db-shell 的 dbShellHelp() 为单一真相（与 `db help` 输出逐字一致）；静态内容，
      // 紧跟系统提示放置，保持前缀稳定、可命中 prompt 缓存。
      { role: 'system', content: agentDbHelpContextText() }
    ];
    const currentTurnMessages: OpenAiMessage[] = [
      { role: 'system', content: formatAgentContextMessage(context) },
      { role: 'user', content: agentUserMessageContent(prompt, attachments) }
    ];
    const messages: OpenAiMessage[] = [
      ...fixedPrefixMessages,
      ...historyMessages,
      ...currentTurnMessages
    ];
    // 本轮新增块的起始下标（当前文档上下文起）：完成/取消/失败时截取这段完整追加进 apiMessages。
    let apiTurnStart = messages.length - currentTurnMessages.length;
    const toolEvents: ToolEvent[] = [];
    // 有序段（15-12 交错渲染）：assistant 一回合按时间线记 text / tool 段。tool 段只记 toolId 作
    // 顺序锚，工具数据仍在 toolEvents 单一来源；前端按同样顺序实时组装，历史重放读持久化的 segments。
    const segments: AnyRecord[] = [];
    const pushTextSegment = (content: unknown): void => {
      const text = String(content || '').trim();
      if (text) segments.push({ kind: 'text', text });
    };
    const emitToolEvent = (tool: ToolEvent): void => {
      const id = String(tool?.id || `${tool?.name || 'tool'}-${toolEvents.length}`);
      const next: ToolEvent = { ...tool, id };
      const index = toolEvents.findIndex((event) => event.id === id);
      if (index >= 0) toolEvents[index] = { ...toolEvents[index], ...next };
      else toolEvents.push(next);
      sendAgentStream(requestId, { type: 'tool', tool: next });
    };
    const compactHistoryBeforeNextModelCall = async (usage: NormalizedAgentUsage | null, initialCall: boolean): Promise<boolean> => {
      if (!shouldCompactAgentHistory(usage, api)) return false;
      const sourceMessages = initialCall ? messages.slice(0, apiTurnStart) : [...messages];
      if (sourceMessages.length <= fixedPrefixMessages.length) return false;
      const compactPrompt = deps.systemPromptSection('agent.history.compact', '').trim();
      const resumeTemplate = deps.systemPromptSection('agent.history.resume', '').trim();
      const continuePrompt = deps.systemPromptSection('agent.history.continue', '').trim();
      if (!compactPrompt || !resumeTemplate || !continuePrompt) {
        throw new Error('system_prompt.md 缺少 Agent 历史压缩提示词。');
      }
      const thresholdUsage = usageForCurrentApi(usage, api)!;
      sendAgentStream(requestId, {
        type: 'status',
        text: `上下文已达 ${Math.round(thresholdUsage.ratio * 100)}%，正在压缩历史...`
      });
      const compacted = await callAgentChat(api, [
        ...sourceMessages,
        { role: 'user', content: compactPrompt }
      ], [], { reasoningEffort, signal });
      const summary = String(compacted?.content || '').trim();
      if (!summary) throw new Error('Agent 历史压缩失败：模型未返回状态摘要。');
      const summaryMessage: OpenAiMessage = {
        role: 'system',
        content: resumeTemplate.replace('{{summary}}', () => summary)
      };
      agentStore.replaceSessionApiHistory(session.id, [summaryMessage]);
      const tailMessages = initialCall
        ? currentTurnMessages
        : [{ role: 'user', content: continuePrompt } as OpenAiMessage];
      messages.splice(0, messages.length, ...fixedPrefixMessages, summaryMessage, ...tailMessages);
      apiTurnStart = fixedPrefixMessages.length + 1;
      deps.debugLog?.('agent.history.compacted', {
        sessionId: session.id,
        model: api.model || '',
        ratio: thresholdUsage.ratio,
        sourceMessageCount: sourceMessages.length,
        summaryChars: summary.length,
        initialCall
      });
      return true;
    };
    // 默认上下文的面板预览 = 所见即所得：逐段展示本轮实际拼进 messages 的真实消息对象，
    // 分段、顺序、内容与模型收到的完全一致（一字不改；仅超长单条/整体截显示，不影响注入）。
    // 第一轮显示完整初始拼接（系统提示 → db 参考 → 当前文档上下文 → 当前提问）；第二轮起
    // 历史已在之前各轮的上下文卡里原样展示过，本轮只显示新拼接的后缀——不再额外渲染
    // 「会话历史预览」段（那不是模型收到的一条消息，只是每轮重复制造的展示副本）。
    const PREVIEW_ITEM_CHARS = 1200;
    const clipForPreview = (text: string): string => (text.length > PREVIEW_ITEM_CHARS
      ? `${text.slice(0, PREVIEW_ITEM_CHARS)}\n…（本条预览截断，完整内容已注入模型）`
      : text);
    const isFirstTurn = historyMessages.length === 0;
    const turnViewStart = isFirstTurn ? 0 : apiTurnStart;
    const turnViewLabel = (msg: OpenAiMessage, absoluteIndex: number): string => {
      if (absoluteIndex === apiTurnStart) return '当前文档上下文';
      if (absoluteIndex === messages.length - 1) return '当前提问';
      if (msg?.role === 'system' && absoluteIndex === 0) return '系统提示';
      if (msg?.role === 'system' && absoluteIndex === 1) return 'db 命令参考';
      if (msg?.role === 'user') return '用户';
      if (msg?.role === 'assistant') return '助手';
      if (msg?.role === 'tool') return '工具结果';
      return '系统';
    };
    const defaultContextFull = messages
      .slice(turnViewStart)
      .map((msg, index) => `${turnViewLabel(msg, turnViewStart + index)}：\n${clipForPreview(agentContentPreview(msg?.content))}`)
      .join('\n\n');
    const defaultContextPreview = defaultContextFull.length > 12000
      ? `${defaultContextFull.slice(0, 12000)}\n…（预览截断，完整内容已注入模型）`
      : defaultContextFull;
    emitToolEvent({
      id: 'default-context',
      name: 'default_context',
      status: 'done',
      resultPreview: defaultContextPreview
    });
    segments.push({ kind: 'tool', toolId: 'default-context' });

    try {
      let answer = '';
      let usage: NormalizedAgentUsage | null = usageForCurrentApi(existingSession?.result?.usage, api);
      // 终态 assistant 消息（无 tool_calls 的那条）不会进入 messages 数组，但它同样是本轮循环的
      // 一部分（最终回答 + 思考），单独捕获、存入 apiMessages，否则跨轮后模型看不到自己上轮的结论。
      let finalAssistantMessage: AgentMessage | null = null;
      const changedDocIds = new Set<string>();
      // db screenshot 回执图片若在后续请求中被接口拒绝（典型：当前模型无视觉能力），
      // 降级一次后不再重试：把失败原因 + 「你可能不具有视觉能力」作为 assistant 提示交还，
      // 让模型在保留上下文的前提下改用文本继续回答，而不是整轮宕机、也不反复调截图。
      // 仅在「图片发出但尚未被接口接受」期间的失败才进入兜底（pendingScreenshotToolIds 非空），
      // 成功接受后再失败与图片无关，直接上抛（见下方成功分支清空）。
      const pendingScreenshotToolIds: string[] = [];
      let visionRetried = false;
      let visionFallback = false;
      // 纯文字（非截图）API 请求连续失败计数：连续 5 次后提示用户检查网络 / API 状态，
      // 稍等或切换模型后重试，而不是无限重试。成功即清零。
      let textRequestFailures = 0;
      const TEXT_REQUEST_FAILURE_LIMIT = 5;
      // 主循环不设轮次上限是【设计决定，非疏漏】：agent 可自由地想看多少轮就看多少轮、
      // 调多少工具都行——复杂任务（跨多文档检索 + 多步下钻 + 汇总）本就需要长链工具调用，
      // 强行设步数上限会误伤正常长任务。失控防护已有且不在这里：纯文字 API 连续失败 5 次
      // 回退提示（下方 textRequestFailures）、用户可手动取消（cancelAgentRequest）、单次
      // 调用有 IFTREE_AGENT_TIMEOUT_MS 超时。review 不要再把「for(;;) 无上限」报成 bug。
      for (let step = 0; ; step += 1) {
        assertNotAborted(signal);
        if (await compactHistoryBeforeNextModelCall(usage, step === 0)) usage = null;
        sendAgentStream(requestId, { type: 'status', text: step === 0 ? '正在连接模型...' : '正在整理回答...' });
        let message: AgentMessage;
        try {
          message = await callAgentChat(api, messages, tools, { requestId, reasoningEffort, signal });
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (pendingScreenshotToolIds.length === 0) {
            // 纯文字（非截图）请求失败：累计并【重试】，连续 5 次仍失败才产出提示并 break
            // （不宕机、不无限重试）。计数后必须 continue 重试——若第一次失败就 throw，
            // 「5 次回退」永远不可达（review #6）。
            textRequestFailures += 1;
            if (textRequestFailures >= TEXT_REQUEST_FAILURE_LIMIT) {
              const failureText = (error as { message?: string } | null)?.message || String(error);
              const networkMessage: AgentMessage = {
                role: 'assistant',
                content: `API 请求已连续 ${textRequestFailures} 次失败（最近一次：${failureText}）。请检查网络或 API 状态，稍等片刻或切换模型后重试。`,
                kind: 'request-failed'
              } as AgentMessage;
              answer = String(networkMessage.content || '');
              finalAssistantMessage = networkMessage;
              sendAgentStream(requestId, { type: 'delta', text: answer });
              break;
            }
            sendAgentStream(requestId, { type: 'status', text: `API 请求失败（第 ${textRequestFailures} 次），正在重试…` });
            continue;
          }
          if (!visionRetried) {
            // 第一次失败：可能是网络抖动，【保留清单】降级图片后重试一次。若此处清空清单，
            // 第二次失败会因清单为空落入上面的普通错误分支，vision-fallback 永远不可达
            // （review #6）。清单留到重试结果出来再处理（成功清空 / 再失败走 vision-fallback）。
            visionRetried = true;
            const failureText = (error as { message?: string } | null)?.message || String(error);
            dropImageBlocksFromMessages(messages);
            sendAgentStream(requestId, { type: 'status', text: '接口未接受截图图片，正在改用文字重试…' });
            messages.push({
              role: 'system',
              content: `（系统回执：携带 db screenshot 截图的 API 请求失败——${failureText}。已改用文字重试。）`
            });
            continue;
          }
          // 重试后仍失败：确认是视觉能力问题，不再重试也不宕机。清空图片、产出带
          // vision-fallback 标记的提示消息（含失败原因），让模型在保留上下文的前提下用文本继续。
          visionFallback = true;
          const failureText = (error as { message?: string } | null)?.message || String(error);
          for (const id of pendingScreenshotToolIds.splice(0)) {
            emitToolEvent({ id, name: 'bash', status: 'error', error: `携带截图的 API 请求失败：${failureText}` });
          }
          dropImageBlocksFromMessages(messages);
          const fallbackMessage: AgentMessage = {
            role: 'assistant',
            content: `你可能不具有视觉能力，无法查看刚才截取的应用窗口画面（截图的 API 请求失败——${failureText}）。请和用户报告并确认，再决定是否改用文字方式继续。`,
            kind: 'vision-fallback'
          } as AgentMessage;
          answer = String(fallbackMessage.content || '');
          finalAssistantMessage = fallbackMessage;
          sendAgentStream(requestId, { type: 'delta', text: answer });
          break;
        }
        // 成功拿到响应：清空待降级清单与纯文字失败计数。截图已被接口接受，之后的失败
        // 与图片无关，不应落入图片降级兜底（原实现只在出错分支清空，导致成功后再失败被误判）。
        pendingScreenshotToolIds.length = 0;
        textRequestFailures = 0;
        if (message.usage) {
          usage = message.usage;
          sendAgentStream(requestId, { type: 'usage', usage });
        }
        if (message.reasoning_content) segments.push({ kind: 'reasoning', text: String(message.reasoning_content).trim() });
        pushTextSegment(message.content);
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (toolCalls.length === 0) {
          answer = String(message.content || '').trim();
          finalAssistantMessage = message;
          break;
        }
        messages.push(agentAssistantMessageForHistory(message, toolCalls) as OpenAiMessage);
        sendAgentStream(requestId, { type: 'status', text: '正在读取上下文...' });
        for (const call of toolCalls) {
          assertNotAborted(signal);
          const name = call?.function?.name || '';
          const args = parseToolArgs(call?.function?.arguments);
          const toolEventId = call?.id || `tool-${step}-${messages.length}`;
          emitToolEvent({ id: toolEventId, name, status: 'running', argsPreview: jsonPreview(args, 1200) });
          segments.push({ kind: 'tool', toolId: toolEventId });
          let result: AnyRecord & ToolResult;
          try {
            result = await runAgentTool(name, args, { mode, sessionId: session.id, context, signal }) as AnyRecord & ToolResult;
          } catch (error) {
            if (isAbortError(error)) throw error;
            result = {
              ok: false,
              recoverable: true,
              tool: name,
              error: {
                name: (error as { name?: string } | null)?.name || 'Error',
                message: (error as { message?: string } | null)?.message || String(error)
              },
              instruction: '本次工具调用失败。请修正参数、换用更合适的查询，或向用户说明缺少的信息。'
            };
            emitToolEvent({ id: toolEventId, name, status: 'error', error: (error as { message?: string } | null)?.message || String(error) });
          }
          // 图片回执（db screenshot）：正文路径一律用占位符，base64 只进图片消息，不污染摘要/预览/历史。
          const resultForText = result?.image
            ? { ...result, image: { ...(result.image as unknown as AnyRecord), data: `[base64 ${String((result.image as unknown as AnyRecord).data || '').length} chars]` } }
            : result;
          const resultJson = JSON.stringify(sanitize(resultForText));
          const displayPreview = toolDisplayPreview(name, resultForText, 5000);
          const resultEvent: ToolEvent & { displayPreview?: string; resultJson?: string; images?: AgentImageAttachment[] } = {
            id: toolEventId,
            name,
            resultPreview: jsonPreview(resultForText, 5000),
            ...(displayPreview === null ? {} : { displayPreview, resultJson }),
            // 图片回执随事件下发（面板直接渲染缩略图）；文本预览仍走上面的占位符版本。
            ...(result?.image ? { images: [result.image as unknown as AgentImageAttachment] } : {})
          };
          if (result?.ok === false && result?.recoverable) {
            emitToolEvent({ ...resultEvent, status: 'error', error: (result.error as { message?: string } | null | undefined)?.message || '工具调用失败' });
          } else {
            emitToolEvent({ ...resultEvent, status: 'done' });
          }
          if (Array.isArray(result?.changedDocIds)) {
            for (const docId of result.changedDocIds) {
              const normalizedDocId = normalizeStableId(docId, null);
              if (normalizedDocId) changedDocIds.add(normalizedDocId);
            }
          }
          const toolText = summarizeToolResultForHistory(name, args, resultForText, resultJson);
          if (result?.image) {
            // 截图（db screenshot）作为工具结果注入：文本与图片合进【同一个】tool 消息的
            // content 数组（与用户主动发图的 user 消息区分）。拆成两个同 tool_call_id 的
            // tool 消息会在 Anthropic 转换后产生两个同 tool_use_id 的 tool_result，违反
            // 「同一 tool_use 对应一个 tool_result」的协议（review #5），严格网关会拒。
            pendingScreenshotToolIds.push(toolEventId);
            messages.push({
              role: 'tool',
              tool_call_id: call.id || toolEventId,
              content: [
                { type: 'text', text: toolText },
                { type: 'image', image: result.image as unknown as AgentImageAttachment },
                { type: 'text', text: '（db screenshot 截取的应用窗口当前画面）' }
              ]
            });
          } else {
            messages.push({
              role: 'tool',
              tool_call_id: call.id || toolEventId,
              content: toolText
            });
          }
        }
      }

      if (!answer) answer = mode === 'edit' ? '已生成待审变更。' : '没有生成可用回答，请追问或换个问法。';
      const diffs = await listAgentDiffs();
      const turnMessages: HistoryItem[] = [
        {
          role: 'user',
          mode,
          content: prompt,
          attachments,
          createdAt: new Date().toISOString()
        },
        {
          role: 'assistant',
          mode,
          content: answer,
          status: '完成',
          diffCount: diffs.length,
          usage,
          toolEvents,
          segments,
          ...(visionFallback ? { kind: 'vision-fallback' } : {}),
          createdAt: new Date().toISOString()
        }
      ];
      // 完整循环入库：user prompt 起 + 全部中间 assistant/tool + 终态 assistant（含思考与最终回答）。
      // JSON 深拷贝零加工（一字不改）；终态消息不带工具调用，空 tool_calls 数组不入库。
      const finalTrailer = finalAssistantMessage ? agentAssistantMessageForHistory(finalAssistantMessage, []) : null;
      if (finalTrailer) delete finalTrailer.tool_calls;
      const apiTurnMessages = apiTurnMessagesForStorage(messages, apiTurnStart, finalTrailer);
      agentStore.finishSessionTurn(session.id, {
        answer,
        pendingDiffCount: diffs.length,
        diffIds: diffs.map((diff) => diff.id),
        usage,
        toolEvents,
        changedDocIds: Array.from(changedDocIds),
        ...(visionFallback ? { visionFallback: true } : {})
      }, turnMessages, apiTurnMessages);
      sendAgentStream(requestId, { type: 'done', answer, diffCount: diffs.length, usage });
      return { sessionId: session.id, answer, diffs, usage, toolEvents, segments, changedDocIds: Array.from(changedDocIds), ...(visionFallback ? { visionFallback: true } : {}) };
    } catch (error) {
      if (isAbortError(error)) {
        const answer = '已取消。';
        const diffs = await listAgentDiffs();
        const turnMessages: HistoryItem[] = [
          {
            role: 'user',
            mode,
            content: prompt,
            attachments,
            createdAt: new Date().toISOString()
          },
          {
            role: 'assistant',
            mode,
            content: answer,
            status: '已取消',
            canceled: true,
            toolEvents,
            segments,
            createdAt: new Date().toISOString()
          }
        ];
        // 取消时的部分循环也完整入库：悬空 tool_calls 在入库时由 apiTurnMessagesForStorage 补好
        // 「被中断」合成结果（修复一次完成，注入侧零加工）；末尾如实补一条「已取消」assistant 收尾。
        const apiTurnMessages = apiTurnMessagesForStorage(messages, apiTurnStart, { role: 'assistant', content: answer });
        agentStore.finishSessionTurn(session.id, {
          canceled: true,
          answer,
          pendingDiffCount: diffs.length,
          diffIds: diffs.map((diff) => diff.id),
          toolEvents
        }, turnMessages, apiTurnMessages);
        sendAgentStream(requestId, { type: 'done', answer, diffCount: diffs.length, canceled: true });
        return { sessionId: session.id, answer, diffs, toolEvents, segments, canceled: true, changedDocIds: [] };
      }
      const turnMessages: HistoryItem[] = [
        {
          role: 'user',
          mode,
          content: prompt,
          attachments,
          createdAt: new Date().toISOString()
        },
        {
          role: 'assistant',
          mode,
          content: (error as { message?: string } | null)?.message || String(error),
          status: '失败',
          error: true,
          imageRequestRejected: attachments.length > 0,
          toolEvents,
          segments,
          createdAt: new Date().toISOString()
        }
      ];
      // 失败路径同样保留部分循环（悬空 tool_calls 入库时一并修复），末尾如实标注中断原因。
      const apiTurnMessages = apiTurnMessagesForStorage(messages, apiTurnStart, {
        role: 'assistant',
        content: `（本轮因错误中断：${(error as { message?: string } | null)?.message || String(error)}）`
      });
      agentStore.finishSessionTurn(session.id, {
        error: (error as { message?: string } | null)?.message || String(error),
        imageRequestRejected: attachments.length > 0,
        toolEvents
      }, turnMessages, apiTurnMessages);
      throw error;
    } finally {
      if (requestId && activeAgentRequests.get(requestId) === abortController) {
        activeAgentRequests.delete(requestId);
      }
    }
  }

  async function listAgentDiffs(): Promise<AnyRecord[]> {
    // A2A 待审复用所有文档的唯一活跃草稿，不再按 owner 或会话过滤。
    const pending = await database().run({ operation: 'query', payload: { action: 'editBranch.listPending' } }, 'query') as { branches?: AnyRecord[] } | null | undefined;
    return pending?.branches || [];
  }

  async function listAgentSessions(payload: AnyRecord = {}): Promise<unknown> {
    return getAgentStore().listSessions({ limit: payload.limit });
  }

  function getAgentSession(payload: AnyRecord = {}): StoredSession | null {
    const sessionId = Number(payload.sessionId ?? payload.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) return null;
    return getAgentStore().getSession(sessionId);
  }

  async function deleteAgentSession(payload: AnyRecord = {}): Promise<AnyRecord> {
    const sessionId = Number(payload.sessionId ?? payload.id);
    if (!Number.isInteger(sessionId) || sessionId <= 0) return { ok: false, sessions: await listAgentSessions() };
    getAgentStore().deleteSession(sessionId);
    return { ok: true, sessions: await listAgentSessions() };
  }

  function cancelAgentRequest(payload: AnyRecord | string = {}): AnyRecord {
    const requestId = String((typeof payload === 'object' ? (payload?.requestId ?? payload) : payload) ?? '').trim();
    if (!requestId) return { ok: false, canceled: false, reason: 'missing requestId' };
    const controller = activeAgentRequests.get(requestId);
    if (!controller) return { ok: false, canceled: false, requestId };
    controller.abort();
    return { ok: true, canceled: true, requestId };
  }

  async function runTool(payload: AnyRecord = {}): Promise<unknown> {
    const name = String(payload.name || payload.tool || '').trim();
    if (!name) throw new Error('agent tool name is required');
    const args = payload.args && typeof payload.args === 'object' ? payload.args as AnyRecord : {};
    const mode = normalizeAgentMode(payload.mode);
    const context = await buildAgentContext({ ...payload, mode });
    return runAgentTool(name, args, {
      mode,
      sessionId: Number(payload.sessionId) || 0,
      context,
      signal: null
    });
  }

  async function applyAgentDiff(diffId: unknown): Promise<AnyRecord> {
    const branchId = Number(diffId);
    if (!Number.isInteger(branchId) || branchId <= 0) return { ok: false, diffs: await listAgentDiffs() };
    const branch = (await listAgentDiffs()).find((item) => Number(item.id) === branchId);
    if (!branch?.base_doc_id) return { ok: false, diffs: await listAgentDiffs() };
    const result = await database().write(
      { action: 'editBranch.save', docId: branch.base_doc_id, includeDoc: false },
      {}
    ) as AnyRecord;
    return { ok: true, result, diffs: await listAgentDiffs() };
  }

  async function rejectAgentDiff(diffId: unknown): Promise<AnyRecord> {
    const branchId = Number(diffId);
    if (!Number.isInteger(branchId) || branchId <= 0) return { ok: false, diffs: await listAgentDiffs() };
    const branch = (await listAgentDiffs()).find((item) => Number(item.id) === branchId);
    if (!branch?.base_doc_id) return { ok: false, diffs: await listAgentDiffs() };
    await database().write({ action: 'editBranch.discard', docId: branch.base_doc_id, includeDoc: false }, {});
    return { ok: true, diffs: await listAgentDiffs() };
  }

  return {
    runAgent,
    runTool,
    listAgentDiffs,
    listAgentSessions,
    getAgentSession,
    deleteAgentSession,
    cancelAgentRequest,
    applyAgentDiff,
    rejectAgentDiff
  };
}
