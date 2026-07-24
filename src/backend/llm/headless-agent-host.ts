import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { createDatabaseService } from '../database-service.js';
import { createDerivedIndexReconciler } from '../derived-index/derived-index-reconciler.js';
import { createLibraryDocumentService } from '../import/import-service.js';
import { getProjectedDoc } from '../projection/doc-view.js';
import { runDbShellArgv, resolveDocRef } from '../db-shell.js';
import { normalizeStableId } from '../db/ids.js';
import { AgentStore } from '../../agent/agent-store.js';
import {
  DEFAULT_VECTOR_CONFIG,
  normalizeVectorConfig
} from '../../vector/embeddings.js';
import { createEmbeddingService } from '../../vector/embedding-service.js';
import { createSummaryService } from './summary.js';
import { renderPrompt } from '../../lang/prompt-catalog.js';
import { loadPromptCatalog } from '../../lang/prompt-loader.js';
import { createAgentRuntime } from './agent-runtime.js';
import {
  createLlmSettingsReader,
  readDotEnv
} from './settings.js';
import {
  createLibraryFs,
  createLlmWorkspace
} from '../library/library-fs.js';
import { normalizeRelativePath } from '../path-utils.js';

const DEFAULT_TREE_SLICE_DEPTH = 1;

interface StrippedTreeNode {
  id: unknown;
  doc_id: unknown;
  parent_id: unknown;
  sort_order: unknown;
  node_type: unknown;
  text: unknown;
  node_note: unknown;
  source_position: unknown;
  child_count: unknown;
  trust_level: unknown;
  created_at: unknown;
  updated_at: unknown;
  address: unknown;
  children: StrippedTreeNode[];
}

interface TreeNodeLike {
  id?: unknown;
  doc_id?: unknown;
  parent_id?: unknown;
  sort_order?: unknown;
  node_type?: unknown;
  text?: unknown;
  node_note?: unknown;
  source_position?: unknown;
  child_count?: unknown;
  trust_level?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  address?: unknown;
  children?: TreeNodeLike[];
}

function stripTree(node: TreeNodeLike | null | undefined): StrippedTreeNode | null {
  if (!node) return null;
  return {
    id: node.id,
    doc_id: node.doc_id,
    parent_id: node.parent_id,
    sort_order: node.sort_order,
    node_type: node.node_type,
    text: node.text,
    node_note: node.node_note,
    source_position: node.source_position,
    child_count: node.child_count,
    trust_level: node.trust_level,
    created_at: node.created_at,
    updated_at: node.updated_at,
    address: node.address,
    children: (node.children || [])
      .map((child) => stripTree(child))
      .filter((child): child is StrippedTreeNode => child !== null)
  };
}

export interface HeadlessAgentHostOptions {
  projectRoot?: string;
  enqueueWrite?: ((task: () => unknown) => unknown) | null;
  sendEvent?: ((event: Record<string, unknown>) => void) | null;
  fetchers?: () => unknown[];
}

interface MaintenanceCapableStore {
  maintenance?: {
    setSerialize?: (enqueue: (task: () => unknown) => unknown) => void;
    register: (name: string, handler: () => unknown) => void;
    start: () => void;
  } | null;
}

type RequestEnvelope = Record<string, unknown> & {
  type?: unknown;
  method?: unknown;
  command?: unknown;
  id?: unknown;
  argv?: unknown[];
  currentDocId?: unknown;
  docId?: unknown;
  databaseCommand?: Record<string, unknown>;
  commandPayload?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  fallbackOperation?: 'read' | 'write';
  dryRun?: boolean;
};

type RequestHandler = (request: RequestEnvelope) => unknown;

export interface HeadlessAgentHost {
  handleRequest(request?: RequestEnvelope): Promise<unknown>;
  close(): void;
}

export function createHeadlessAgentHost(options: HeadlessAgentHostOptions = {}): HeadlessAgentHost {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const enqueueWrite = typeof options.enqueueWrite === 'function' ? options.enqueueWrite : null;
  const libraryRoot = process.env.IFTREE_LIBRARY_ROOT || join(projectRoot, 'library');
  const workspaceRoot = join(projectRoot, '.iftree-llm-workspace');
  const workspaceBin = join(workspaceRoot, '.bin');
  const databaseRoot = join(projectRoot, 'database');
  const configPath = join(projectRoot, 'iftree.config.json');
  const envPath = join(projectRoot, '.env');
  // .env 作为统一配置入口：headless 子进程继承 MCP server 的 process.env，而 MCP
  // server 不加载 .env 文件，导致读 process.env 的项（如嵌入后端 IFTREE_EMBED_*）
  // 拿不到 .env 配置。这里在子进程内把 .env 灌进 process.env，只填未显式设置的键
  // （不覆盖外部注入），restart_backend 即可让 .env 生效，无需重连 MCP。
  for (const [dotEnvKey, dotEnvValue] of Object.entries(readDotEnv(envPath))) {
    if (process.env[dotEnvKey] === undefined && dotEnvValue !== undefined) process.env[dotEnvKey] = dotEnvValue;
  }
  type DatabaseService = ReturnType<typeof createDatabaseService>;
  let database: DatabaseService | null = null;
  let readDatabase: DatabaseService | null = null;
  let agentStore: AgentStore | null = null;
  type AgentRuntime = ReturnType<typeof createAgentRuntime>;
  let agentRuntime: AgentRuntime | null = null;
  let llmWorkspaceState: ReturnType<ReturnType<typeof createLlmWorkspace>['refreshLlmWorkspaceState']> | null = null;
  const dbShellState: Record<string, unknown> = {};
  let vectorConfigCache: ReturnType<typeof normalizeVectorConfig> | null = null;
  const streamRequestIds = new Map<string, unknown>();

  interface ProjectConfig {
    debugLogging?: boolean;
    [extra: string]: unknown;
  }

  function readProjectConfig(): ProjectConfig {
    if (!existsSync(configPath)) return {};
    try {
      return (JSON.parse(readFileSync(configPath, 'utf8')) as ProjectConfig) || {};
    } catch {
      return {};
    }
  }

  // LLM 调试日志（debug 功能）：开关同主进程——IFTREE_DEBUG_LOGGING=1 或项目配置 debugLogging=true；
  // 开启时把 agent 的每次 LLM 请求/响应原文逐行写入 .iftree-debug/agent-<起始时刻>.jsonl，
  // 便于排查"上下文拼接 / 模型实际输出"。请求 body 不含 api key（key 在 HTTP header，不入日志）。
  // 日志层异常一律吞掉，绝不影响 agent 运行。
  const debugSessionStamp = new Date().toISOString().replace(/[:.]/g, '-');
  function agentDebugLoggingEnabled(): boolean {
    return process.env.IFTREE_DEBUG_LOGGING === '1' || readProjectConfig().debugLogging === true;
  }
  function agentDebugLog(event: string, payload: Record<string, unknown> = {}): void {
    if (!agentDebugLoggingEnabled()) return;
    try {
      const dir = join(projectRoot, '.iftree-debug');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`;
      appendFileSync(join(dir, `agent-${debugSessionStamp}.jsonl`), line);
    } catch {
      // debug 日志绝不影响 agent 运行
    }
  }

  // LLM 三套设置（shared/summary/agent + 策略）统一走共享读取器；
  // 进程特异的只有 envPath/configPath 两个事实。
  const llmSettings = createLlmSettingsReader({ envPath, configPath, readProjectConfig });
  const {
    readAgentSettings,
    agentApiFromPayload,
    activeLlmSummaryApi
  } = llmSettings;

  // provider 选择逻辑（.env 直连覆盖 / 共享 provider / 独立摘要 provider / legacy env）已下沉到
  // settings.mjs 的 createLlmSettingsReader，从上面 llmSettings 解构取用（解耦第 2 步）。

  // 提示词/文案读取走语言模块（src/lang）：每次取时读 system_prompt.md 解析成目录
  // （md 小、保持「改后即时生效」、无需重启）。systemPromptSection 保留同名薄适配——
  // summary 与注入 agent 框架处沿用它，实现改为「按键取值 + {{占位}} 插值 + 缺省回退」。
  const getPromptCatalog = () => loadPromptCatalog(projectRoot);
  const systemPromptSection = (name: string, fallback: string = ''): string => renderPrompt(getPromptCatalog(), name, {}, fallback);

  // 摘要子系统已下沉到 ./summary.mjs（解耦第 1b 步）：host 只注入「摘要 API 配置读取 / 提示词目录 /
  // 外部 fetch」，提示词拼装与 provider 协议调用收在模块内。requestHandlers 的 summary.* 转调它。
  const summaryService = createSummaryService({
    activeLlmSummaryApi: activeLlmSummaryApi as never,
    getPromptCatalog,
    fetchers: (() => options.fetchers?.() || []) as never
  });

  function ensureLibraryRoot(): string {
    mkdirSync(libraryRoot, { recursive: true });
    return libraryRoot;
  }

  const libraryFs = createLibraryFs({ ensureRoot: ensureLibraryRoot });
  const { libraryPath, listLibraryChildren, libraryRelativePathForAgent } = libraryFs;

  function normalizeAgentLibraryPath(value: unknown = ''): string {
    const raw = String(value || '').trim();
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
      throw new Error('Agent 本地文件路径必须是 library 工作区相对路径');
    }
    return normalizeRelativePath(raw);
  }

  const llmWorkspace = createLlmWorkspace({ workspaceRoot, workspaceBin, projectRoot, readProjectConfig });

  function refreshLlmWorkspaceState() {
    llmWorkspaceState = llmWorkspace.refreshLlmWorkspaceState();
    return llmWorkspaceState;
  }

  function dbPath(): string {
    return process.env.IFTREE_DB || join(databaseRoot, 'store.sqlite');
  }

  function agentDbPath(): string {
    return join(databaseRoot, 'agent.sqlite');
  }

  function appHome(): string {
    // 默认锚工作区内（与 dbPath/agentDbPath 同根 databaseRoot），不再回落用户主目录 ~/.iftree。
    // 早期布局曾把向量/settings 放 ~/.iftree，导致 IFTREE_HOME 未设时向量库与 SQLite 分家
    // （SQLite 在工作区、向量回落 C 盘空库）。显式 IFTREE_HOME 仍可 override（压测等场景）。
    return process.env.IFTREE_HOME || databaseRoot;
  }

  function settingsPath(): string {
    return join(appHome(), 'settings.json');
  }

  interface UserSettings {
    vector?: { enabled?: boolean; [extra: string]: unknown };
    [extra: string]: unknown;
  }

  function readSettingsFile(): UserSettings {
    try {
      return (JSON.parse(readFileSync(settingsPath(), 'utf8').replace(/^﻿/, '')) as UserSettings) || {};
    } catch {
      return {};
    }
  }

  function isVectorModuleEnabled(settings: UserSettings = readSettingsFile()): boolean {
    const configured = settings?.vector?.enabled;
    return configured !== false;
  }

  function lanceDbPath(): string {
    return join(appHome(), 'vectors', 'nodes.lance');
  }

  function getVectorConfig() {
    if (!vectorConfigCache) {
      const settings = readSettingsFile();
      vectorConfigCache = normalizeVectorConfig(settings.vector || DEFAULT_VECTOR_CONFIG);
    }
    return vectorConfigCache;
  }

  // 嵌入计算已下沉到 src/vector/embedding-service.mjs（解耦第 1a 步）：host 只注入向量配置读取与模块开关，
  // 本地 transformers 推理 / 远近后端选择 / 嵌入入口 / token 计数收在模块内。derivedIndexes 用它的 embed / countTokens。
  const embeddingService = createEmbeddingService({ getVectorConfig, isVectorModuleEnabled });

  const derivedIndexes = createDerivedIndexReconciler({
    lanceDbPath,
    getStore: () => getDatabase().getStore() as never,
    getVectorConfig,
    isVectorModuleEnabled,
    vectorDisabledMessage: '向量模块已由用户禁用',
    embedTexts: embeddingService.embed,
    countTokens: embeddingService.countTokens
  });

  // 启动后台回填 docs.meta.semantic（读取侧改读这一列后，存量文档需一次性补上、否则显示退化）。
  // fire-and-forget：延到微任务、不阻塞初始化，单文档失败在内部吞掉。
  Promise.resolve().then(() => derivedIndexes.backfillDocSemanticMeta()).catch(() => {});

  function databaseReadContext() {
    return derivedIndexes.readContext();
  }

  function databaseWriteContext() {
    return {
      refreshDoc,
      // 单写队列（架构不变量：所有写硬串行）注入，供 mutation-api 的 fire-and-forget
      // 派生索引维护入队执行，避免脱离队列与正常写撞 meta / LanceDB manifest。
      enqueueWrite: enqueueWrite || undefined,
      // 导入生命周期域服务（handlers/write/import.ts 的 import.libraryDocument /
      // import.deleteDocument 消费）；ensureDocVectors 随 derivedIndexes.writeContext() 注入。
      // 函数体求值在写请求时，晚于下方 libraryDocService 初始化，无 TDZ 顾虑。
      importLibraryDocument,
      deleteImportedDocument,
      ...derivedIndexes.writeContext()
    };
  }

  function getAgentStore(): AgentStore {
    if (!agentStore) agentStore = new AgentStore(agentDbPath());
    return agentStore;
  }

  interface RefreshDocOptions {
    full?: boolean;
    maxTreeDepth?: number | null;
    includeSourceSpans?: boolean;
    includeSourceDocumentContent?: boolean;
    includeNodes?: boolean;
  }

  interface DocFetchResult {
    doc: Record<string, unknown>;
    nodes: Array<Record<string, unknown>>;
    tree: TreeNodeLike | null;
    refs: Array<Record<string, unknown>>;
    history: Array<Record<string, unknown>>;
    sourceDocument?: Record<string, unknown> | null;
    sourcePdfPages?: Array<Record<string, unknown>>;
    sourceSpans?: Array<Record<string, unknown>>;
    treeDepthStats?: Record<string, unknown> | null;
    idByAddress: Record<string, unknown>;
  }

  function refreshDoc(docId: unknown, options: RefreshDocOptions = {}): Record<string, unknown> | null {
    const data = getProjectedDoc(getDatabase().getStore(), docId, {
      maxTreeDepth: options.full === true ? null : (options.maxTreeDepth || DEFAULT_TREE_SLICE_DEPTH),
      includeSourceSpans: options.includeSourceSpans === true,
      includeSourceDocumentContent: options.includeSourceDocumentContent === true
    }) as DocFetchResult | null;
    if (!data) return null;
    return {
      doc: { ...data.doc },
      nodes: options.includeNodes === true ? data.nodes.map((node) => ({ ...node })) : [],
      tree: data.tree ? stripTree(data.tree) : null,
      refs: data.refs.map((item) => ({ ...item })),
      history: data.history.map((item) => ({ ...item })),
      sourceDocument: data.sourceDocument ? { ...data.sourceDocument } : null,
      sourcePdfPages: (data.sourcePdfPages || []).map((item) => ({ ...item })),
      sourceSpans: options.includeSourceSpans === true ? (data.sourceSpans || []).map((item) => ({ ...item })) : [],
      treeDepthStats: data.treeDepthStats ? { ...data.treeDepthStats } : null,
      idByAddress: { ...data.idByAddress }
    };
  }

  function notifyLibraryChanged(): void {
    options.sendEvent?.({ type: 'library.changed' });
  }

  // 维护接线：scheduler 在主库（store）位置、只派发信号。这里注册向量模块的 handler（自给自足），注入
  // 单写队列做硬串行，并启动后台 tick。主库自己的 handler 已在 IftreeStore 构造时注册（互不内联）。
  function attachMaintenance(store: MaintenanceCapableStore): void {
    if (!store?.maintenance) return;
    if (enqueueWrite) store.maintenance.setSerialize?.(enqueueWrite);
    store.maintenance.register('derived', () => derivedIndexes.runMaintenance());
    store.maintenance.start();
  }

  function getDatabase(): DatabaseService {
    if (!database) {
      database = createDatabaseService({
        dbPath: dbPath(),
        libraryRoot,
        readContext: databaseReadContext,
        writeContext: databaseWriteContext,
        seed: (store: MaintenanceCapableStore) => attachMaintenance(store)
      } as Parameters<typeof createDatabaseService>[0]);
    }
    return database;
  }

  // 只读 service（第二个连接，query_only=ON）：database.read 绕全局串行队列直跑的落点。
  // WAL 下读写连接分离 = 读永远只见已提交快照，绝不与写连接的事务中间态照面（同连接绕队列
  // 读会在写 handler 的 await 间隙读到未提交数据，这正是必须分连接的原因）；query_only 让
  // 任何混进读路径的写 SQL 当场报错而不是绕过队列偷写。
  function getReadDatabase(): DatabaseService {
    if (!readDatabase) {
      readDatabase = createDatabaseService({
        dbPath: dbPath(),
        libraryRoot,
        readContext: databaseReadContext,
        initOptions: { readonly: true }
      } as Parameters<typeof createDatabaseService>[0]);
    }
    return readDatabase;
  }

  // 已导入库文档生命周期（导入 / 删除 / 库文件移动后源路径重写）已下沉到 import-service 的
  // createLibraryDocumentService（解耦第 1c 步）：host 只注入 store / 写信封 / 派生索引维护 / 刷新 /
  // library 通知 / 路径解析，落库仍直接走 store 整篇建库能力。解构出同名句柄，下方注入与注册表沿用。
  const libraryDocService = createLibraryDocumentService({
    getStore: () => getDatabase().getStore() as never,
    runWrite: (payload) => getDatabase().run({ operation: 'write', payload }, 'write') as Promise<{ ok?: boolean; changed?: unknown } | null | undefined>,
    maintainDerivedAfterWrite: derivedIndexes.maintainDerivedAfterWrite,
    refreshDoc: refreshDoc as (docId: string, options?: Record<string, unknown>) => Record<string, unknown>,
    notifyLibraryChanged,
    libraryPath,
    treeSliceDepth: DEFAULT_TREE_SLICE_DEPTH
  });
  const { importLibraryDocument, smartImportTask, deleteImportedDocument, updateImportedSourcePaths } = libraryDocService;

  function sendAgentStream(requestId: unknown, event: Record<string, unknown>): void {
    const id = streamRequestIds.get(String(requestId));
    options.sendEvent?.({
      id,
      type: 'agent.stream',
      event: { requestId, ...event }
    } as Record<string, unknown>);
  }

  function getAgentRuntime(): AgentRuntime {
    if (!agentRuntime) {
      // host 实际签名（refreshDoc(docId: unknown, options?) → Record<string, unknown> | null；sdk.request body: Record<string, unknown>）
      // 与 AgentRuntimeDeps（refreshDoc(docId: string) → AgentDoc | null；body: AnyRecord）结构同质但 TS narrow 差异——
      // 单点 as unknown as 必要边界 cast，让对象字面量从 host 形态映射到 agent runtime 真签名。
      agentRuntime = createAgentRuntime({
        // in-process SDK 句柄：agent 框架经它发 request 信封访问后端（与外部 agent 经 MCP 同契约），
        // 不再直连 database 实例。封装 host 的 handleRequest、in-process 直调，保持流式回调与单进程。
        sdk: { request: (type: string, body: Record<string, unknown> = {}) => handleRequest({ type, ...body }) },
        getAgentStore,
        refreshDoc,
        readAgentSettings,
        agentApiFromPayload,
        systemPromptSection,
        sendAgentStream,
        fetchers: () => options.fetchers?.() || [],
        libraryPath,
        listLibraryChildren,
        normalizeAgentLibraryPath,
        libraryRelativePathForAgent,
        llmWorkspacePath: () => workspaceRoot,
        llmWorkspaceBinPath: () => workspaceBin,
        llmWorkspaceStatus: () => llmWorkspaceState || refreshLlmWorkspaceState(),
        notifyLibraryChanged,
        updateImportedSourcePaths,
        debugLog: agentDebugLog
      } as unknown as Parameters<typeof createAgentRuntime>[0]);
    }
    return agentRuntime;
  }

  async function runAgent(payload: Record<string, unknown> = {}, requestId: unknown = ''): Promise<unknown> {
    const agentRequestId = String(payload.requestId || requestId || `headless-${Date.now()}`).trim();
    streamRequestIds.set(agentRequestId, requestId);
    try {
      // ask_agent 的 docId 可传文档标题（与 find 对齐）：标题→docId，唯一即定位、重名抛候选 UUID、未找到报错；
      // 选填，空则不限定文档；合法 UUID 原样通过。MCP(agent.run) 与 CLI(askAgent) 都汇入此处，一处解析覆盖两路。
      let nextPayload = payload;
      if (payload.docId != null && String(payload.docId).trim() !== '') {
        nextPayload = { ...payload, docId: await resolveDocRef(getDatabase() as never, payload.docId) };
      }
      const runtime = getAgentRuntime() as unknown as { runAgent: (payload: Record<string, unknown>) => Promise<unknown> };
      return await runtime.runAgent({ ...nextPayload, requestId: agentRequestId });
    } finally {
      streamRequestIds.delete(agentRequestId);
    }
  }

  // db screenshot：经 Electron 壳的 /capture 口拿主窗口当前画面的 PNG，
  // 暂存 .iftree-llm-workspace/screenshot/（时间戳命名，字典序即时间序）。
  async function requestUiScreenshot() {
    const captureUrl = process.env.IFTREE_CAPTURE_URL
      || `http://127.0.0.1:${Number(process.env.IFTREE_CAPTURE_PORT) || 4318}/capture`;
    let response;
    try {
      response = await fetch(captureUrl);
    } catch (error) {
      throw new Error(`应用窗口未运行，无法截图（db screenshot 仅在应用窗口打开时可用）：${String((error as { message?: unknown })?.message || error)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`窗口截图失败（HTTP ${response.status}）：${detail.slice(0, 200)}`);
    }
    const png = Buffer.from(await response.arrayBuffer());
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
      throw new Error('截图服务返回的不是有效 PNG。');
    }
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const dir = join(workspaceRoot, 'screenshot');
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const pad = (value: number, length = 2) => String(value).padStart(length, '0');
    const name = `screenshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}.png`;
    writeFileSync(join(dir, name), png);
    return {
      image: { id: name, name, mediaType: 'image/png', data: png.toString('base64') },
      width,
      height,
      savedPath: `.iftree-llm-workspace/screenshot/${name}`
    };
  }

  // 薄 dispatch 注册表（解耦第 10 步）：请求类型 → 处理函数。host 是编排层，每个 handler 接 request、
  // 调对应域模块（store / import / vector / summary / agent），自身不含业务。加动词＝加一项、不接 if 链。
  const requestHandlers: Record<string, RequestHandler> = {
    ping: () => ({ ok: true, pid: process.pid }),
    'ui.screenshot': () => requestUiScreenshot(),
    // 数据面动词（import/vectors/delete 含内）已全部经 db 契约走 L4 action（写 ctx 注入域服务，
    // 见 databaseWriteContext）；这里只注入 agent 能力（ask_agent/shell/web 动词消费，不属数据面）。
    'db.shell': (request) => runDbShellArgv(getDatabase() as never, ((request.argv as unknown[]) || []) as never, {
      currentDocId: request.currentDocId ?? request.docId,
      agentMode: request.agentMode,
      shellState: dbShellState,
      askAgent: (payload: Record<string, unknown> = {}) => runAgent(payload, request.id),
      agentTool: (payload: Record<string, unknown> = {}) => (getAgentRuntime() as unknown as { runTool: (p: Record<string, unknown>) => unknown }).runTool(payload),
      captureScreenshot: () => requestUiScreenshot()
    } as never),
    'database.run': (request) => getDatabase().run((request.databaseCommand || request.commandPayload || request.payload || {}) as never, (request.fallbackOperation || 'read') as 'read' | 'write'),
    // 读走只读连接 + 单请求只读快照事务（同步读动词的多条 SELECT 钉在同一提交点；async
    // 读动词退回逐查询快照）。库文件还没建成时（首启未写，readonly 打开 fileMustExist 抛）
    // 退回写 service——那一瞬也没有并发写事务可撞；写 store 一旦建库，下次读即回到只读连接。
    'database.read': (request) => {
      let svc: DatabaseService | null = null;
      try {
        svc = getReadDatabase();
        svc.getStore();
      } catch {
        readDatabase?.close();
        readDatabase = null;
        // 退化裸读不开快照事务：写连接上与队列写共用一条连接，绕行读在这儿开事务会与
        // 队列写事务交错（inTransaction 直通互相吞并）。裸读每条查询自成快照，够用。
        return getDatabase().read(request.payload || {});
      }
      const store = svc.getStore() as unknown as { withReadSnapshot<T>(fn: () => T): T };
      return store.withReadSnapshot(() => svc.read(request.payload || {}));
    },
    'database.write': (request) => getDatabase().run({ operation: 'write', payload: request.payload || {} } as never, 'write'),
    // source 只读（路 B：前端去 native，PDF 原件/高亮也走后端 RPC，内部调既有 store 方法）。
    'source.readPdfData': (request) => {
      const docId = normalizeStableId((request.payload?.docId as unknown) ?? request.docId, null);
      if (!docId) return null;
      const store = getDatabase().getStore() as { db: { prepare: (sql: string) => { get: (...params: unknown[]) => { source_type?: string; original_path?: string | null } | undefined } } };
      const sourceDocument = store.db.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get(docId);
      if (!sourceDocument || sourceDocument.source_type !== 'pdf' || !sourceDocument.original_path) return null;
      return {
        fileName: basename(sourceDocument.original_path),
        base64: readFileSync(sourceDocument.original_path).toString('base64')
      };
    },
    // PDF 几何走 L4 action（§6-1：不再经 store 门面）；管道回执保持裸数组，前端不动。
    'source.readPdfHighlights': async (request) => {
      const docId = normalizeStableId((request.payload?.docId as unknown) ?? request.docId, null);
      if (!docId) return [];
      const res = await (getDatabase().read({ ...(request.payload || {}), action: 'source.pdfHighlightRects', docId }) as Promise<{ rects?: unknown[] }>);
      return res?.rects || [];
    },
    'source.readPdfSpanRects': async (request) => {
      const docId = normalizeStableId((request.payload?.docId as unknown) ?? request.docId, null);
      if (!docId) return [];
      const res = await (getDatabase().read({ action: 'source.pdfHitRects', docId }) as Promise<{ rects?: unknown[] }>);
      return res?.rects || [];
    },
    'import.libraryDocument': (request) => importLibraryDocument(request.payload || {}),
    'import.smartTask': (request) => smartImportTask(request.payload || {}),
    'import.deleteDocument': (request) => deleteImportedDocument(request.payload || {}),
    'database.updateSourceBinding': (request) => (getDatabase() as { updateSourceBinding: (payload: Record<string, unknown>) => unknown }).updateSourceBinding(request.payload || {}),
    'library.updateImportedSourcePaths': (request) => {
      const payload = (request.payload || {}) as { fromPath?: string; from?: string; toPath?: string; to?: string; isDirectory?: boolean };
      updateImportedSourcePaths(payload.fromPath ?? payload.from ?? '', payload.toPath ?? payload.to ?? '', payload.isDirectory === true);
      notifyLibraryChanged();
      return { ok: true };
    },
    'vector.resetStore': async (request) => {
      vectorConfigCache = null;
      await derivedIndexes.resetVectorStoreTable(Number((request.payload as { dimensions?: unknown })?.dimensions) || getVectorConfig().dimensions);
      return { ok: true };
    },
    'vector.ensureDoc': (request) => {
      const payload = request.payload || {};
      const docId = normalizeStableId((payload as Record<string, unknown>).docId ?? (payload as Record<string, unknown>).doc_id ?? request.docId ?? (request as Record<string, unknown>).doc_id, null);
      if (!docId) throw new Error('vector.ensureDoc requires docId');
      return derivedIndexes.ensureDocVectors(docId, {
        onProgress: (event) => options.sendEvent?.({
          id: request.id,
          type: 'agent.stream',
          event: { type: 'vector.ensureDoc.progress', ...event }
        } as Record<string, unknown>)
      });
    },
    'summary.generateNode': (request) => summaryService.generateNodeSummary(request.payload || {}),
    'summary.cancelNode': (request) => summaryService.cancelNodeSummary(request.payload || {}),
    'agent.run': (request) => runAgent(request.payload || {}, request.id),
    'agent.tool': (request) => (getAgentRuntime() as unknown as { runTool: (p: Record<string, unknown>) => unknown }).runTool(request.payload || {}),
    'agent.cancel': (request) => (getAgentRuntime() as unknown as { cancelAgentRequest: (p: Record<string, unknown>) => unknown }).cancelAgentRequest(request.payload || {}),
    'agent.diffs': () => (getAgentRuntime() as unknown as { listAgentDiffs: () => unknown }).listAgentDiffs(),
    'agent.sessions': (request) => (getAgentRuntime() as unknown as { listAgentSessions: (p: Record<string, unknown>) => unknown }).listAgentSessions(request.payload || {}),
    'agent.session': (request) => (getAgentRuntime() as unknown as { getAgentSession: (p: Record<string, unknown>) => unknown }).getAgentSession(request.payload || {}),
    'agent.deleteSession': (request) => (getAgentRuntime() as unknown as { deleteAgentSession: (p: Record<string, unknown>) => unknown }).deleteAgentSession(request.payload || {}),
    'agent.applyDiff': (request) => (getAgentRuntime() as unknown as { applyAgentDiff: (p: unknown) => unknown }).applyAgentDiff((request.payload as { diffId?: unknown })?.diffId ?? request.payload),
    'agent.rejectDiff': (request) => (getAgentRuntime() as unknown as { rejectAgentDiff: (p: unknown) => unknown }).rejectAgentDiff((request.payload as { diffId?: unknown })?.diffId ?? request.payload),
    shutdown: () => {
      close();
      return { ok: true };
    }
  };

  async function handleRequest(request: RequestEnvelope = {}): Promise<unknown> {
    const type = String(request.type || request.method || request.command || '').trim();
    const handler = requestHandlers[type];
    if (!handler) throw new Error(`Unknown headless agent request: ${type || '(empty)'}`);
    return handler(request);
  }

  function close(): void {
    if (readDatabase) readDatabase.close();
    readDatabase = null;
    if (database) database.close();
    database = null;
    if (agentStore) agentStore.close();
    agentStore = null;
    derivedIndexes.close();
  }

  ensureLibraryRoot();
  llmWorkspace.cleanupExpiredWorkspaceEntries();
  refreshLlmWorkspaceState();

  return {
    handleRequest,
    close
  };
}
