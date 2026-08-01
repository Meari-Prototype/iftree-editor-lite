import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { createBackendClient } from '../llm/backend-client.js';
import {
  activeLlmApiFromSettings,
  cleanupLegacyLlmEnvValues,
  createLlmSettingsReader,
  llmApiKeyEnvValues,
  stripLlmSecrets
} from '../llm/settings.js';
import { normalizeAgentToolSettings } from '../llm/defaults.js';
import { createLibraryFs, normalizeLibraryRelativePath } from '../library/library-fs.js';
import { isSameOrChildPath, pathKey } from '../path-utils.js';
import { normalizeDocMeta, resolveMarkdownImagePath, workspaceSearchRoots } from '../../core/image-paths.js';
import { VECTOR_COMPUTE_OPTIONS, VECTOR_MODEL_OPTIONS } from '../../vector/embeddings.js';
import { huggingFaceResolveUrl, huggingFaceTreeUrl, selectTransformerModelFiles } from '../../vector/model-download.js';
import { createSettingsIo, type VectorConfig } from './settings-io.js';

type JsonRecord = Record<string, unknown>;
type RpcHandler = (...args: unknown[]) => unknown | Promise<unknown>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..');
const DIST_ROOT = join(PROJECT_ROOT, 'dist');
const LIBRARY_ROOT = join(PROJECT_ROOT, 'library');
const DATABASE_ROOT = join(PROJECT_ROOT, 'database');
const HOST_SCRIPT = join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js');
const PORT = Number(process.env.IFTREE_WEB_PORT) || 4317;
const HOST = '127.0.0.1';
const SSE_CLIENTS = new Set<ServerResponse>();
const ASSET_URLS = new Map<string, string>();

export function isAllowedWebHost(rawHost: unknown): boolean {
  const value = String(rawHost || '').trim();
  if (!value || /[\s/?#@\\]/.test(value)) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase();
    return hostname === HOST || hostname === 'localhost';
  } catch {
    return false;
  }
}

export function isAllowedWebOrigin(rawOrigin: unknown): boolean {
  const value = String(rawOrigin || '').trim();
  if (!value) return false;
  try {
    const origin = new URL(value);
    const hostname = origin.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (!(hostname === HOST || hostname === 'localhost')) return false;
    if (origin.protocol !== 'http:' || origin.origin !== value.replace(/\/$/, '')) return false;
    // 端口必须匹配：本服务端口（4317 / IFTREE_WEB_PORT），或本机 Vite dev 端口。
    // 只比 hostname 会放行 http://localhost（80 简写）等本机 80 端口的恶意/被注入页面
    // 借道 CSRF 全部写接口；但 Vite dev 代理（changeOrigin:false）保留浏览器 5173 的
    // Origin 转发到后端，属于合法开发场景，必须额外放行——否则 dev 下全部写请求 403。
    const devPorts = (process.env.IFTREE_WEB_DEV_PORTS || '5173').split(',').map((p) => p.trim());
    return origin.port === String(PORT) || devPorts.includes(origin.port);
  } catch {
    return false;
  }
}

function isJsonContentType(rawContentType: unknown): boolean {
  return /^application\/json(?:\s*;|$)/i.test(String(rawContentType || '').trim());
}

function appHome() {
  return process.env.IFTREE_HOME || DATABASE_ROOT;
}

function ensureLibraryRoot() {
  mkdirSync(LIBRARY_ROOT, { recursive: true });
  return LIBRARY_ROOT;
}

// 落盘前保留 4GB 余量：除文件本身外,给同盘其它读写(库事务/源文档/系统)留缓冲,
// 避免上传写满磁盘后关键位置失败。
const DISK_FREE_MARGIN_BYTES = 4 * 1024 * 1024 * 1024;

// 目标盘剩余空间是否容得下「待写字节 + 4GB 余量」。statfsSync 失败(老 Node/特殊卷)
// 时放行(不阻断导入),交给流式写盘自身报错。
function hasDiskSpaceFor(targetPath: string, bytesNeeded: number): boolean {
  try {
    const stats = statfsSync(dirname(targetPath));
    const free = Number(stats.bavail) * Number(stats.bsize);
    return free >= bytesNeeded + DISK_FREE_MARGIN_BYTES;
  } catch {
    return true;
  }
}

const backend = createBackendClient({
  projectRoot: PROJECT_ROOT,
  hostScriptPath: HOST_SCRIPT
});

const settingsIo = createSettingsIo({ projectRoot: PROJECT_ROOT, appHome });
const {
  projectEnvPath,
  projectConfigPath,
  readDotEnv,
  writeDotEnvValues,
  readProjectConfig,
  writeProjectConfig,
  settingsPath,
  isVectorModuleEnabled,
  getVectorConfig,
  saveVectorSettings: saveVectorSettingsIo,
  nodeLayoutSettingsPayload,
  saveNodeLayoutConfig
} = settingsIo;

const llmSettings = createLlmSettingsReader({
  envPath: projectEnvPath(),
  configPath: projectConfigPath(),
  readEnv: readDotEnv,
  readProjectConfig
});
const {
  normalizeLlmSummarySettings,
  readSharedLlmSettings,
  readLlmSummarySettings,
  readAgentSettings
} = llmSettings;

const libraryFs = createLibraryFs({ ensureRoot: ensureLibraryRoot });
const { libraryPath, listLibraryChildren } = libraryFs;

function listLibraryTree() {
  return {
    type: 'folder',
    name: '主文件夹',
    relativePath: '',
    fullPath: ensureLibraryRoot(),
    children: listLibraryChildren('')
  };
}

async function moveLibraryEntry(payload: JsonRecord = {}) {
  const sourceRel = normalizeLibraryRelativePath(String(payload.sourceRelativePath || ''));
  if (!sourceRel) throw new Error('Cannot move the library root');
  const targetFolderRel = normalizeLibraryRelativePath(String(payload.targetFolderRelativePath || ''));
  const source = libraryPath(sourceRel);
  const targetFolder = libraryPath(targetFolderRel);
  const sourceStat = statSync(source);
  if (!statSync(targetFolder).isDirectory()) throw new Error('Move target is not a folder');
  if (sourceStat.isDirectory() && isSameOrChildPath(targetFolder, source)) throw new Error('Cannot move a folder into itself');
  const target = join(targetFolder, parse(source).base);
  if (pathKey(source) === pathKey(target)) return listLibraryTree();
  if (existsSync(target)) throw new Error(`Target already exists: ${parse(source).base}`);
  renameSync(source, target);
  await backend.updateSourceBinding({ fromPath: source, toPath: target, isDirectory: sourceStat.isDirectory() });
  publish('library.changed', {});
  return listLibraryTree();
}

async function importLocalFiles(payload: JsonRecord = {}) {
  // 该 RPC 接收任意服务器本地路径并拷贝导入——只在 Electron 壳下可用（filePaths 来自
  // 原生文件对话框）。Web 模式下浏览器无法弹原生对话框，任何能调 RPC 的人都能绕过
  // 对话框直接喂路径读本机任意文件；Web 导入应走 /api/import-upload 文件上传。
  if (process.env.IFTREE_ELECTRON_SHELL !== '1') {
    throw new Error('importLocalFiles 仅在应用窗口（Electron）模式可用；Web 模式请用文件上传导入');
  }
  const filePaths = Array.isArray(payload.filePaths) ? payload.filePaths.map((path) => String(path || '')).filter(Boolean) : [];
  const results: unknown[] = [];
  for (const source of filePaths) {
    if (!statSync(source).isFile()) continue;
    const parsed = parse(source);
    let name = parsed.base;
    let target = join(ensureLibraryRoot(), name);
    let suffix = 1;
    while (existsSync(target) && pathKey(source) !== pathKey(target)) {
      name = `${parsed.name}-${suffix}${parsed.ext}`;
      target = join(ensureLibraryRoot(), name);
      suffix += 1;
    }
    if (pathKey(source) !== pathKey(target)) copyFileSync(source, target);
    results.push(await backend.importLibraryDocument({
      ...payload,
      filePaths: undefined,
      relativePath: name
    }));
  }
  publish('library.changed', {});
  return results;
}

function writeLlmSummarySettings(payload: JsonRecord = {}) {
  const current = readLlmSummarySettings();
  const next = normalizeLlmSummarySettings({
    ...current,
    ...payload,
    providers: Array.isArray(payload.providers) ? payload.providers : current.providers
  });
  const config = readProjectConfig();
  const llm = config.llm || {};
  writeProjectConfig({
    llm: {
      ...llm,
      shared: next.independent === true ? llm.shared : (llm.shared || stripLlmSecrets(next)),
      summary: stripLlmSecrets({
        ...((llm.summary as JsonRecord | undefined) || {}),
        activeProviderId: next.activeProviderId,
        activeApiId: next.activeApiId,
        independent: next.independent,
        providers: next.independent === true ? next.providers : undefined,
        summaryStrategies: next.summaryStrategies,
        activeArticleSummaryStrategyId: next.activeArticleSummaryStrategyId,
        activeNodeSummaryStrategyId: next.activeNodeSummaryStrategyId,
        summaryConcurrency: next.summaryConcurrency
      })
    }
  });
  writeDotEnvValues(cleanupLegacyLlmEnvValues(llmApiKeyEnvValues(next)));
  return readLlmSummarySettings();
}

function writeAgentSettings(payload: JsonRecord = {}) {
  const currentAgent = readAgentSettings();
  const current = readSharedLlmSettings();
  const next = normalizeLlmSummarySettings({
    ...current,
    ...payload,
    providers: Array.isArray(payload.providers) ? payload.providers : current.providers
  });
  const active = activeLlmApiFromSettings(next);
  const config = readProjectConfig();
  writeProjectConfig({
    llm: {
      ...(config.llm || {}),
      shared: stripLlmSecrets(next),
      agent: {
        ...((((config.llm || {}) as JsonRecord).agent as JsonRecord | undefined) || {}),
        personalPrompt: String(payload.personalPrompt ?? currentAgent.personalPrompt ?? ''),
        tone: String(payload.tone ?? currentAgent.tone ?? ''),
        toolSettings: normalizeAgentToolSettings(payload.toolSettings || currentAgent.toolSettings || {})
      }
    }
  });
  writeDotEnvValues(cleanupLegacyLlmEnvValues({
    ...llmApiKeyEnvValues(next),
    OPENAI_API_KEY: active?.apiKey || ''
  }));
  return readAgentSettings();
}

function vectorSettingsPayload() {
  const config = getVectorConfig();
  return {
    ...config,
    enabled: isVectorModuleEnabled(),
    disabledReason: isVectorModuleEnabled() ? '' : '向量模块已由用户禁用',
    modelOptions: VECTOR_MODEL_OPTIONS.map((option) => ({ ...option })),
    computeOptions: VECTOR_COMPUTE_OPTIONS.map((option) => ({ ...option })),
    appHome: appHome(),
    settingsPath: settingsIo.settingsPath(),
    lanceDbPath: join(appHome(), 'vectors', 'nodes.lance'),
    vectorTable: 'nodes_vec'
  };
}

async function saveVectorSettings(payload: JsonRecord = {}) {
  const wasEnabled = isVectorModuleEnabled();
  const { previous, next, enabled } = saveVectorSettingsIo(payload);
  if (enabled && (!wasEnabled || previous.modelId !== next.modelId || previous.dimensions !== next.dimensions || previous.localModelRoot !== next.localModelRoot)) {
    await backend.resetVectorStore({ dimensions: next.dimensions });
  }
  return vectorSettingsPayload();
}

// 常规设置 payload：调试开关（iftree.config.json）+ 关键存储路径 + 环境变量覆盖标记，
// 设置屏「常规」分类整页消费这一份。
function generalSettingsPayload() {
  return {
    debugLogging: readProjectConfig().debugLogging === true,
    paths: {
      appHome: appHome(),
      mainDb: process.env.IFTREE_DB || join(appHome(), 'store.sqlite'),
      agentDb: join(appHome(), 'agent.sqlite'),
      vectorDb: join(appHome(), 'vectors', 'nodes.lance'),
      libraryDir: process.env.IFTREE_LIBRARY_ROOT || LIBRARY_ROOT,
      settingsPath: settingsPath()
    },
    envOverrides: {
      home: Boolean(process.env.IFTREE_HOME),
      db: Boolean(process.env.IFTREE_DB),
      library: Boolean(process.env.IFTREE_LIBRARY_ROOT)
    }
  };
}

// 白名单保存：只接 debugLogging，其余键（尤其 llm 配置）一律忽略，防误写 iftree.config.json。
function saveGeneralSettings(payload: JsonRecord = {}) {
  writeProjectConfig({ debugLogging: payload.debugLogging === true });
  return generalSettingsPayload();
}

async function fetchModelFileList(config: VectorConfig) {
  const response = await fetch(huggingFaceTreeUrl(config.modelName));
  if (!response.ok) {
    throw new Error(`读取 Hugging Face 模型文件列表失败：${response.status} ${response.statusText}`);
  }
  const files = selectTransformerModelFiles(await response.json(), config.dtype);
  if (files.length === 0) throw new Error(`未找到 ${config.modelName} 的 ${config.dtype} ONNX 文件`);
  return files;
}

async function downloadFile(url: string, targetPath: string, progress: (bytes: number) => void) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：${response.status} ${response.statusText} ${url}`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.download`;
  rmSync(tempPath, { force: true });
  const stream = createWriteStream(tempPath);
  try {
    for await (const chunk of response.body) {
      progress(chunk.length || 0);
      if (!stream.write(chunk)) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'finish');
    rmSync(targetPath, { force: true });
    renameSync(tempPath, targetPath);
  } catch (error) {
    stream.destroy();
    rmSync(tempPath, { force: true });
    throw error;
  }
}

async function downloadVectorModel(payload: JsonRecord = {}) {
  const config = getVectorConfig();
  if (!config.supportsLocalDownload) {
    throw new Error(`${config.label} 由 Ollama 提供，不支持下载为本地 Transformers.js 模型`);
  }
  const root = resolve(String(payload.downloadRoot || config.localModelRoot || join(appHome(), 'models')));
  mkdirSync(root, { recursive: true });
  const files = await fetchModelFileList(config);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let loaded = 0;
  let currentFile = 0;
  publish('progress', { label: `准备下载 ${config.label}`, step: 0, total: total || files.length });
  for (const file of files) {
    currentFile += 1;
    const targetPath = resolve(root, ...config.modelName.split('/'), ...file.path.split('/'));
    if (!targetPath.startsWith(`${root}${sep}`)) throw new Error(`模型文件路径越界：${file.path}`);
    if (existsSync(targetPath) && (!file.size || statSync(targetPath).size === file.size)) {
      loaded += file.size;
      publish('progress', {
        label: `下载 ${config.label}：${file.path}`,
        step: total ? loaded : currentFile,
        total: total || files.length
      });
      continue;
    }
    await downloadFile(huggingFaceResolveUrl(config.modelName, file.path), targetPath, (bytes) => {
      loaded += bytes;
      publish('progress', {
        label: `下载 ${config.label}：${file.path}`,
        step: total ? loaded : currentFile,
        total: total || files.length
      });
    });
  }
  publish('progress', {
    label: `下载 ${config.label}`,
    step: total || files.length,
    total: total || files.length,
    done: true
  });
  const next = await saveVectorSettings({ localModelRoot: root });
  return { ...next, downloadedModelPath: join(root, ...config.modelName.split('/')) };
}

async function resolveImageSources(payload: JsonRecord = {}) {
  const docId = String(payload.docId || '');
  const sources = Array.isArray(payload.sources) ? payload.sources.map((source) => String(source || '')) : [];
  if (!docId || sources.length === 0) return {};
  const info = await backend.databaseRead({ action: 'doc.getInfo', docId }) as JsonRecord;
  const doc = (info.doc && typeof info.doc === 'object' ? info.doc : {}) as JsonRecord;
  const docMeta = normalizeDocMeta(doc.meta as Parameters<typeof normalizeDocMeta>[0]);
  const searchRoots = workspaceSearchRoots(docMeta.sourcePath);
  const result: Record<string, string> = {};
  for (const source of sources) {
    if (/^(?:https?:|data:|blob:)/i.test(source)) {
      result[source] = source;
      continue;
    }
    const path = resolveMarkdownImagePath({ src: source, docMeta, appHome: appHome(), searchRoots });
    if (!path) {
      result[source] = source;
      continue;
    }
    // 包含校验：只放行落在 appHome 或文档 sourcePath 目录内的文件。绝对路径 src
    // 此前无包含校验，可借 ASSET_URLS 经 /api/assets/<uuid> 读本机任意文件（如 .env/.ssh）。
    // 正常用法的相对路径（相对 sourcePath / appHome assets）本就在这些根内，不受影响。
    const allowed = isSameOrChildPath(path, appHome())
      || (docMeta.sourcePath ? isSameOrChildPath(path, dirname(resolve(String(docMeta.sourcePath)))) : false);
    if (!allowed) {
      result[source] = source;
      continue;
    }
    const id = randomUUID();
    ASSET_URLS.set(id, path);
    result[source] = `/api/assets/${id}`;
  }
  return result;
}

function publish(type: string, payload: unknown) {
  const chunk = `data: ${JSON.stringify({ type, payload })}\n\n`;
  // per-client try/catch：某个客户端 socket 已销毁但 close 未触发时 write 会同步抛
  // ERR_STREAM_DESTROYED。不能让一个死连接中断整个广播（排在其后的客户端都收不到），
  // 也不能让异常上抛把已成功的写操作误判成 500。写失败即清理该客户端、继续广播。
  for (const response of [...SSE_CLIENTS]) {
    try {
      response.write(chunk);
    } catch {
      SSE_CLIENTS.delete(response);
    }
  }
}

function eventOptions(requestId: unknown) {
  return {
    onEvent(event: unknown) {
      publish('agent.stream', { requestId, ...(event && typeof event === 'object' ? event : { value: event }) });
    }
  };
}

const handlers: Record<string, RpcHandler> = {
  readDatabase: (payload = {}) => backend.databaseRead(payload),
  writeDatabase: async (payload = {}) => {
    const result = await backend.databaseWrite(payload);
    publish('library.changed', {});
    return result;
  },
  runDatabaseCommand: (command = {}) => backend.databaseRun(command),
  readSourcePdfData: (docId) => backend.readPdfData(docId),
  readSourcePdfHighlights: (payload = {}) => backend.readPdfHighlights(payload),
  readSourcePdfSpanRects: (docId) => backend.readPdfSpanRects(docId),
  readLibraryTree: () => listLibraryTree(),
  moveLibraryEntry: (payload = {}) => moveLibraryEntry(payload as JsonRecord),
  importLibraryDocument: async (payload = {}) => {
    const result = await backend.request('import.libraryDocument', { payload }, {
      onEvent: (event: unknown) => publish('progress', event)
    });
    publish('library.changed', {});
    return result;
  },
  importLocalFiles: (payload = {}) => importLocalFiles(payload as JsonRecord),
  smartImportTask: (payload = {}) => backend.smartImportTask(payload),
  generateNodeSummary: (payload = {}) => backend.generateNodeSummary(payload),
  cancelNodeSummary: (payload = {}) => backend.cancelNodeSummary(payload),
  runAgent: (payload = {}) => backend.runAgent(payload, eventOptions((payload as JsonRecord).requestId)),
  cancelAgent: (payload = {}) => backend.cancelAgent(payload),
  listAgentDiffs: () => backend.listAgentDiffs(),
  listAgentSessions: (payload = {}) => backend.listAgentSessions(payload),
  getAgentSession: (payload = {}) => backend.getAgentSession(payload),
  deleteAgentSession: (payload = {}) => backend.deleteAgentSession(payload),
  applyAgentDiff: (payload = {}) => backend.applyAgentDiff(payload),
  rejectAgentDiff: (payload = {}) => backend.rejectAgentDiff(payload),
  readVectorSettings: () => vectorSettingsPayload(),
  saveVectorSettings: (payload = {}) => saveVectorSettings(payload as JsonRecord),
  downloadVectorModel: (payload = {}) => downloadVectorModel(payload as JsonRecord),
  readLlmSummarySettings: () => readLlmSummarySettings(),
  saveLlmSummarySettings: (payload = {}) => writeLlmSummarySettings(payload as JsonRecord),
  readAgentSettings: () => readAgentSettings(),
  saveAgentSettings: (payload = {}) => writeAgentSettings(payload as JsonRecord),
  readNodeLayoutSettings: () => nodeLayoutSettingsPayload(),
  saveNodeLayoutSettings: (payload = {}) => saveNodeLayoutConfig(payload as JsonRecord),
  readGeneralSettings: () => generalSettingsPayload(),
  saveGeneralSettings: (payload = {}) => saveGeneralSettings(payload as JsonRecord),
  resolveImageSources: (payload = {}) => resolveImageSources(payload as JsonRecord),
  debugLog: () => true
};

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

// RPC 请求体上限：readJson 把整段 body 缓冲进内存，完全无上限会让无限/畸形请求
// 持续吃内存直到进程爆掉。这里只兜底「永不合拢的流」——10GB 对正常 RPC（设置/查询/
// 文本块/图片）远不可达，不限正常用；真到这份上是请求方该优化，不是这里该限流。
const RPC_BODY_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

class PayloadTooLargeError extends Error {
  constructor() {
    super(`请求体超过 ${RPC_BODY_LIMIT_BYTES} 字节上限`);
    this.name = 'PayloadTooLargeError';
  }
}

async function readJson(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > RPC_BODY_LIMIT_BYTES) {
      request.destroy();
      throw new PayloadTooLargeError();
    }
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
};

function serveFile(response: ServerResponse, path: string) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': path.includes(`${join(DIST_ROOT, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache'
  });
  createReadStream(path).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    if (!isAllowedWebHost(request.headers.host)) {
      sendJson(response, 403, { ok: false, error: 'Host 请求头不允许' });
      return;
    }
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    if (url.pathname === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      response.write(': connected\n\n');
      SSE_CLIENTS.add(response);
      // socket ECONNRESET 时 ServerResponse 发出 error；无监听会成 uncaughtException
      // 崩掉整个 web 后端。error 与 close 都做同一清理（从广播集合剔除）。
      const drop = () => SSE_CLIENTS.delete(response);
      response.on('error', drop);
      request.on('close', drop);
      return;
    }
    if (url.pathname === '/api/rpc' && request.method === 'POST') {
      if (!isAllowedWebOrigin(request.headers.origin)) {
        sendJson(response, 403, { ok: false, error: 'Origin 请求头不允许' });
        return;
      }
      if (!isJsonContentType(request.headers['content-type'])) {
        sendJson(response, 415, { ok: false, error: 'RPC 只接受 application/json' });
        return;
      }
      let body: JsonRecord;
      try {
        body = await readJson(request);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          sendJson(response, 413, { ok: false, error: 'RPC 请求体过大' });
          return;
        }
        throw error;
      }
      const method = String(body.method || '');
      const handler = handlers[method];
      if (!handler) throw new Error(`Unsupported WebUI method: ${method}`);
      const args = Array.isArray(body.args) ? body.args : [];
      sendJson(response, 200, { ok: true, result: await handler(...args) });
      return;
    }
    if (url.pathname === '/api/import-upload' && request.method === 'POST') {
      if (!isAllowedWebOrigin(request.headers.origin)) {
        sendJson(response, 403, { ok: false, error: 'Origin 请求头不允许' });
        return;
      }
      const rawName = url.searchParams.get('name') || 'document';
      // 上传文件名来自浏览器 file.name,是客户端磁盘上的真实名。macOS/Linux 允许 NTFS
      // 保留字符(如 ?),原样落盘才能与源系统行为一致;Windows 本地文件本就不含这些字符,
      // 仅当跨平台把 mac 上含保留字符的文件传到 Windows 后端时才需要拒绝——在落盘前显式
      // 400 并提示改名,比 createWriteStream 抛 500 更诚实,也不会留下半截文件。
      if (/[<>:"/\\|?*]/.test(rawName)) {
        sendJson(response, 400, { ok: false, error: `文件名含 Windows 不允许的字符（<>:"/\\|?*），请改名后重新导入：${rawName}` });
        return;
      }
      const parsed = parse(rawName);
      let name = parsed.base || 'document';
      let target = join(ensureLibraryRoot(), name);
      let suffix = 1;
      while (existsSync(target)) {
        name = `${parsed.name || 'document'}-${suffix}${parsed.ext}`;
        target = join(ensureLibraryRoot(), name);
        suffix += 1;
      }
      // 磁盘空间预检：声明大小(Content-Length)+ 4GB 余量须 ≤ 目标盘剩余,否则先拒绝。
      // 避免写到一半磁盘满、关键位置(库文件/源文档)落半截;上传是流式落盘,不留内存上限,
      // 但磁盘写满会让 importLibraryDocument 拿到损坏文件。Content-Length 缺失时跳过预检
      // (无法预知大小,交给流式写盘自身报错)。
      const declared = Number(request.headers['content-length']) || 0;
      if (declared > 0 && !hasDiskSpaceFor(target, declared)) {
        sendJson(response, 507, { ok: false, error: '磁盘空间不足（需保留 4GB 余量），无法导入该文件' });
        return;
      }
      await pipeline(request, createWriteStream(target));
      const mode = url.searchParams.get('mode') || undefined;
      const result = await backend.importLibraryDocument({ relativePath: name, mode });
      publish('library.changed', {});
      sendJson(response, 200, { ok: true, result });
      return;
    }
    if (url.pathname.startsWith('/api/assets/')) {
      const path = ASSET_URLS.get(url.pathname.slice('/api/assets/'.length));
      if (!path) return sendJson(response, 404, { error: 'Asset not found' });
      serveFile(response, path);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const candidate = resolve(DIST_ROOT, relative || 'index.html');
    if ((candidate === DIST_ROOT || candidate.startsWith(`${DIST_ROOT}${sep}`)) && existsSync(candidate) && statSync(candidate).isFile()) {
      serveFile(response, candidate);
      return;
    }
    serveFile(response, join(DIST_ROOT, 'index.html'));
  } catch (error) {
    sendJson(response, 500, { ok: false, error: String((error as { message?: unknown })?.message || error) });
  }
});

server.listen(PORT, HOST, async () => {
  await backend.ping();
  console.log(`IFTree WebUI: http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close();
  backend.close();
}

// 由 Vite dev server 拉起时带父进程 pid；父进程被强杀后自收，避免残留 4317 后端。
const parentPid = Number(process.env.IFTREE_WEB_PARENT_PID);
if (Number.isFinite(parentPid) && parentPid > 0) {
  const watchdog = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(watchdog);
      shutdown();
      process.exit(0);
    }
  }, 1000);
  watchdog.unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
