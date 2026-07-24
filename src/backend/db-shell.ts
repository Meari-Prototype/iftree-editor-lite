import { normalizeStableId, isStableId } from './db/ids.js';
import { runImportJson, type ImportJsonDatabase } from './import/import-json.js';
import { normalizeNodeType, nodeTypeDisplayLabel } from '../core/node-model.js';
import { formatDiffText, slimDiffView } from './text/diff-text.js';
import { parseDiffRef } from './diff/diff-refs.js';
import {
  formatWriteResult,
  formatSqlResult, formatImportResult, formatVectorsResult, formatDeleteResult,
  formatGcResult, slimWriteResult
} from './text/write-result-text.js';
import type { SnapshotReadNodeResult } from '../core/snapshot-tree.js';

// db-shell 是 endpoint：处理 IPC 返回的扁平 JSON（混 camelCase + snake_case + 派生字段），
// 不接数据库真行类型——下面这组 shell-layer 接口描述显示形态、字段全 optional。
// run 返回 any 是有意为之的 IPC 边界：不同 action 返回结构差异巨大，下游靠 result?.rows / result?.tree 形态分支。

type FlagValue = string | number | boolean;
type ShellRunMode = 'read' | 'write' | 'edit' | 'full';

interface ShellRunEnvelope {
  operation: 'read' | 'write';
  payload: Record<string, unknown>;
}

interface ShellDatabase {
  run(envelope: ShellRunEnvelope, mode: ShellRunMode): Promise<any>;
  getStore(): ReturnType<ImportJsonDatabase['getStore']>;
}

interface ParsedFlags {
  // value-flags（parseValue → string | number）
  scopeDocId?: FlagValue;
  scopeAddress?: FlagValue;
  depth?: FlagValue;
  limit?: FlagValue;
  timeoutMs?: FlagValue;
  charLimit?: FlagValue;
  history?: FlagValue;
  mode?: FlagValue;
  docId?: FlagValue;
  sessionId?: FlagValue;
  set?: FlagValue;
  insert?: FlagValue;
  cwd?: FlagValue;
  at?: FlagValue;
  trust?: FlagValue;
  since?: FlagValue;
  until?: FlagValue;
  matchMode?: FlagValue;
  excludeFolder?: FlagValue;
  sections?: FlagValue;
  range?: FlagValue;
  start?: FlagValue;
  before?: FlagValue;
  spansLimit?: FlagValue;
  nodeId?: FlagValue;
  minScore?: FlagValue;
  detail?: FlagValue;
  folder?: FlagValue;
  from?: FlagValue;
  to?: FlagValue;
  params?: FlagValue;
  current?: FlagValue;
  // 可带可不带值（无值时为 true）
  summary?: FlagValue;
  tag?: FlagValue;
  strategy?: FlagValue;
  resolutions?: FlagValue;
  // boolean 开关
  entity?: boolean;
  expand?: boolean;
  allDocs?: boolean;
  all?: boolean;
  or?: boolean;
  semantic?: boolean;
  yes?: boolean;
  delete?: boolean;
  uuid?: boolean;
  dryRun?: boolean;
  embed?: boolean;
  force?: boolean;
  labels?: boolean;
  spans?: boolean;
  json?: boolean;
  node?: boolean;
  atAddress?: boolean;
  includeHidden?: boolean;
  fresh?: boolean;
}

interface ParsedArgs {
  flags: ParsedFlags;
  positional: string[];
}

interface ShellSemanticStatus {
  status?: string;
  vectorCount?: number;
  nodeCount?: number;
}

interface ShellNodeMeta {
  subtreeTextChars?: number;
  textChars?: number;
  semantic?: ShellSemanticStatus | null;
}

interface ShellDoc {
  id?: string | number;
  docId?: string | number;
  doc_id?: string | number;
  title?: string;
  docTitle?: string;
  doc_title?: string;
  name?: string;
}

interface ShellNode {
  id?: string | number;
  node_id?: string | number;
  nodeId?: string | number;
  docId?: string | number;
  doc_id?: string | number;
  address?: string;
  parentId?: string | number | null;
  parent_id?: string | number | null;
  sortOrder?: number;
  sort_order?: number;
  type?: string;
  nodeType?: string;
  node_type?: string;
  title?: string;
  text?: string;
  textPreview?: string;
  note?: string;
  node_note?: string;
  tags?: { trustLevel?: string | null } & Record<string, unknown>;
  trustLevel?: string | null;
  trust_level?: string | null;
  contentHash?: string;
  score?: number | string;
  rowHits?: number;
  row_hits?: number;
  termCount?: number;
  term_count?: number;
  updatedAt?: string | null;
  updated_at?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  meta?: ShellNodeMeta;
  source?: { position?: number | string | null } & Record<string, unknown>;
  doc?: ShellDoc;
  docTitle?: string;
  doc_title?: string;
  children?: ShellNode[];
}

type ShellHitRow = ShellNode & {
  node?: ShellNode;
  doc?: ShellDoc;
};

interface ShellEntityRow {
  id?: string;
  literal?: string;
  term?: string;
  hitCount?: number;
  hit_count?: number;
  docId?: string | number;
  doc_id?: string | number;
  doc?: ShellDoc;
  entity?: ShellEntityRow;
  seed?: ShellEntityRow;
  relation?: string;
}

interface ShellHistoryRow {
  id?: string;
  commit_id?: string;
  commitId?: string;
  committed_at?: string;
  committedAt?: string;
  saved_at?: string;
  savedAt?: string;
  summary?: string;
  doc_id?: string;
  docId?: string;
}

interface ShellHistorySpec {
  kind: string;
  value: string | number | boolean;
  docId: string | null;
}

interface ShellRefRow {
  id?: string | number;
  refId?: string | number;
  ref_id?: string | number;
  source_id?: string | number;
  sourceId?: string | number;
  target_id?: string | number;
  targetId?: string | number;
  ref_kind?: string;
  refKind?: string;
  kind?: string;
  note?: string;
}

interface ShellSourceSpan {
  id?: string | number;
  spanId?: string | number;
  span_id?: string | number;
  sentence_index?: number;
  sentenceIndex?: number;
  absolute_start_offset?: number;
  absoluteStartOffset?: number;
  start_offset?: number;
  startOffset?: number;
  absolute_end_offset?: number;
  absoluteEndOffset?: number;
  end_offset?: number;
  endOffset?: number;
  node_id?: string | number;
  nodeId?: string | number;
}

interface ShellArticleWindow {
  startOffset?: number;
  endOffset?: number;
  totalLength?: number;
  hasBefore?: boolean;
  hasAfter?: boolean;
}

interface ShellArticleResult {
  article?: unknown;
  text?: string | null;
  window?: ShellArticleWindow;
  sourceSpans?: ShellSourceSpan[];
  spansTotal?: number;
}

interface ShellBranchTarget {
  docId?: FlagValue | null;
}

interface ShellState {
  selectedDocId?: FlagValue | null;
}

interface ShellContext {
  currentDocId?: string | number | null;
  docId?: string | number | null;
  agentMode?: 'qa' | 'edit' | 'full';
  shellState?: ShellState;
  // agent 能力注入（headless-agent-host / agent-runtime）：ask_agent/shell/web 动词消费，不属数据面；
  // 存在性由动词在调用前检查（contextFunction）。数据面动词一律走 database.run → db 契约 → L4。
  askAgent?: (payload: Record<string, unknown>) => Promise<any>;
  agentTool?: (payload: Record<string, unknown>) => Promise<any>;
  captureScreenshot?: (payload: Record<string, unknown>) => Promise<any>;
  [key: string]: unknown;
}

function cleanLine(value: unknown = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value: unknown = '', limit = 80) {
  const text = cleanLine(value);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

const READ_SUBTREE_TEXT_LIMIT = 10000;

function normalizeShellDocId(value: unknown, fallback: string | null = null): string | null {
  return normalizeStableId(value, fallback);
}

// 取裸 doc 标识：兼容 doc:UUID（规范形式）与 doc#UUID、#UUID 误抄写法——
// 模型从输出里原样复制标识是常态，解析侧宽容一次，避免「未找到文档」假失败。
function bareDocRef(value: unknown = '') {
  let raw = cleanLine(value);
  if (raw.startsWith('doc:') || raw.startsWith('doc#')) raw = raw.slice(4).trim();
  if (raw.startsWith('#')) raw = raw.slice(1).trim();
  return raw;
}

// 把用户/agent 传入的 doc 标识解析为真实 docId：合法 UUIDv7 直接用；否则按文档标题精确匹配——
// 唯一命中返回其 docId，重名报冲突并列出候选 UUID，无命中报未找到。
// 让 read/tree 等默认用标题下钻：库内标题唯一时 UUID 完全不必出现，只有重名才被逼出来。
// 重载：默认 allowMissing=false 时不为空（找不到即抛）；显式 allowMissing=true 才可能返回 null。
export async function resolveDocRef(
  database: ShellDatabase,
  input: unknown
): Promise<string>;
export async function resolveDocRef(
  database: ShellDatabase,
  input: unknown,
  options: { allowMissing?: false }
): Promise<string>;
export async function resolveDocRef(
  database: ShellDatabase,
  input: unknown,
  options: { allowMissing: true }
): Promise<string | null>;
export async function resolveDocRef(
  database: ShellDatabase,
  input: unknown,
  { allowMissing = false }: { allowMissing?: boolean } = {}
): Promise<string | null> {
  const bare = bareDocRef(input);
  if (!bare) {
    if (allowMissing) return null;
    throw new Error('需要 doc 标识（文档标题或 doc:UUID）');
  }
  if (isStableId(bare)) return bare;
  const listed = await database.run({ operation: 'read', payload: { action: 'doc.list' } }, 'read');
  const docs: ShellDoc[] = Array.isArray(listed) ? listed : (listed?.rows || listed?.docs || []);
  const target = cleanLine(bare);
  const matches = docs.filter((doc) => cleanLine(doc.title ?? doc.doc_title ?? '') === target);
  if (matches.length === 1) return String(matches[0].id ?? matches[0].docId ?? matches[0].doc_id);
  if (matches.length === 0) {
    if (allowMissing) return null;
    throw new Error(`未找到文档「${bare}」（按标题精确匹配）。用 library_index / find 查看可用文档，或改用 doc:UUID。`);
  }
  const candidates = matches.map((doc) => `doc:${doc.id ?? doc.docId ?? doc.doc_id}`).join('  ');
  throw new Error(`文档标题「${bare}」重名（${matches.length} 个），无法用标题定位，请改用其中之一的 UUID：${candidates}`);
}

function parseValue(value: unknown): string | number {
  const raw = String(value ?? '').trim();
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

function normalizeArgv(argv: unknown[] = []): string[] {
  const source = Array.isArray(argv) ? argv.map((item) => String(item)) : [];
  return source[0] === 'db' ? source.slice(1) : source;
}

function parseFlags(argv: string[] = []): ParsedArgs {
  // 内部用宽松 Record 接收动态键写入；返回时收口为 ParsedFlags，让下游 typo 在使用点被抓到。
  const flags: Record<string, FlagValue> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === 'scope') {
      const docId = argv[index + 1];
      const address = argv[index + 2];
      if (!docId || !address || docId.startsWith('--') || address.startsWith('--')) {
        throw new Error('db --scope requires <doc_id> <node_address>');
      }
      flags.scopeDocId = parseValue(docId);
      flags.scopeAddress = address;
      index += 2;
      continue;
    }
    if (name === 'depth' || name === 'limit' || name === 'timeout-ms' || name === 'char-limit') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = parseValue(value);
      index += 1;
      continue;
    }
    if (name === 'summary' || name === 'tag') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        flags[name] = true;
        continue;
      }
      flags[name] = value;
      index += 1;
      continue;
    }
    if (['history', 'mode', 'doc-id', 'session-id', 'set', 'insert', 'cwd', 'at', 'trust', 'since', 'until', 'match-mode', 'exclude-folder', 'sections', 'range', 'start', 'before', 'spans-limit', 'node-id', 'min-score', 'detail', 'params'].includes(name)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = parseValue(value);
      index += 1;
      continue;
    }
    if (name === 'folder') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('db --folder requires a library relative path');
      flags.folder = value;
      index += 1;
      continue;
    }
    if (name === 'from' || name === 'to') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name] = value;
      index += 1;
      continue;
    }
    if (['entity', 'expand', 'all-docs', 'all', 'or', 'semantic', 'yes', 'delete', 'uuid', 'dry-run', 'embed', 'force', 'labels', 'spans', 'json', 'node', 'at-address', 'include-hidden', 'fresh'].includes(name)) {
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (name === 'tags') { flags.entity = true; continue; }
    if (name === 'fuzzy') throw new Error('db find --fuzzy is not supported; use db find --entity to browse related entities.');
    throw new Error(`Unknown db option: --${name}`);
  }
  return { flags: flags as ParsedFlags, positional };
}

function parseLooseFlags(argv: unknown[] = [], valueFlagNames: string[] = []): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const positional: string[] = [];
  const valueFlags = new Set(valueFlagNames);
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--') {
      positional.push(...argv.slice(index + 1).map((item) => String(item)));
      break;
    }
    const name = token.startsWith('--') ? token.slice(2) : '';
    if (valueFlags.has(name)) {
      const value = argv[index + 1];
      if (!value || String(value).startsWith('--')) throw new Error(`db --${name} requires a value`);
      flags[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = parseValue(value);
      index += 1;
      continue;
    }
    positional.push(token);
  }
  return { flags: flags as ParsedFlags, positional };
}

interface ShellDocScope {
  allDocs?: boolean;
  // docId 只在 allowMissing=true 且没有可用 currentDocId 时缺省；其余分支若返回则必有值。
  docId?: string;
  scopeDocId?: string;
  scopeAddress?: string;
}

function currentDocIdFrom(context: ShellContext = {}): string | null {
  return normalizeShellDocId(context.currentDocId ?? context.docId ?? process.env.IFTREE_CURRENT_DOC_ID, null);
}

function docScope(
  flags: ParsedFlags = {},
  context: ShellContext = {},
  options: { allowMissing?: boolean } = {}
): ShellDocScope {
  if (flags.allDocs) return { allDocs: true };
  const scopedDocId: string | null = normalizeShellDocId(flags.scopeDocId, null);
  if (scopedDocId) return { docId: scopedDocId, scopeDocId: scopedDocId, scopeAddress: String(flags.scopeAddress || '') };
  const currentDocId = currentDocIdFrom(context);
  if (currentDocId) return { docId: currentDocId };
  if (options.allowMissing) return {};
  throw new Error('db command requires current document id, --scope, or --all-docs');
}

function nodePreview(node: ShellNode = {}) {
  return clip(node.textPreview || node.text || '', 80);
}

// find 命中行的内容预览：标题后拼接正文、共截 30 字——无标题/短标题能带出一部分正文开头，
// 标题长则只显示标题。比单显 title（会话卷里 title 就是「用户/助手」角色名、会遮蔽正文）更利于挑候选。
function hitContentPreview(node: ShellNode = {}) {
  const title = '';
  const body = cleanLine(node.textPreview || node.text || '');
  const combined = title ? (body && body !== title ? `${title} ${body}` : title) : body;
  return clip(combined, 30);
}

function nodeTypeLabel(node: ShellNode = {}) {
  return nodeTypeDisplayLabel(node.type || node.nodeType || node.node_type || 'TEXT');
}

function nodeTrustLabel(node: ShellNode = {}) {
  const trust = node.tags?.trustLevel ?? node.trustLevel ?? node.trust_level ?? null;
  return `trust:${trust == null || trust === '' ? 'null' : cleanLine(trust)}`;
}

interface DocDisplayOptions {
  uuid?: boolean;
  docId?: string | number;
  title?: string;
}

function docDisplayLabel(doc: ShellDoc = {}, options: DocDisplayOptions = {}) {
  const docId = doc.docId ?? doc.doc_id ?? doc.id ?? options.docId ?? '';
  if (options.uuid) return docId ? `doc:${docId}` : '';
  return cleanLine(doc.title || doc.docTitle || doc.doc_title || doc.name || options.title || '') || (docId ? `doc:${docId}` : '');
}

interface FormatNodeLineOptions {
  uuid?: boolean;
  omitDocLabel?: boolean;
  docLabel?: string;
  score?: number | string | null;
  scoreKind?: 'sim' | 'hit';
  labels?: boolean;
}

function formatNodeLine(item: ShellHitRow = {}, options: FormatNodeLineOptions = {}) {
  const node: ShellNode = item.node || item;
  const docId = item.doc?.docId ?? item.doc?.id ?? node.docId ?? node.doc_id;
  const label = options.omitDocLabel ? '' : docDisplayLabel(item.doc || node.doc || {
    docId,
    title: options.docLabel ?? item.docTitle ?? item.doc_title ?? node.docTitle ?? node.doc_title
  }, { uuid: options.uuid, docId });
  const score = options.score ?? node.score ?? item.score ?? null;
  const parts = [label, node.address || '', nodeTypeLabel(node), hitContentPreview(node)];
  if (score != null) {
    // 字面命中(hit:命中词数，整数)与语义相似度(sim:0~1)两套量纲，加前缀消歧；无 scoreKind 时保持裸值兼容旧调用。
    if (options.scoreKind === 'sim') parts.push(`sim:${Number(score).toFixed(2)}`);
    else if (options.scoreKind === 'hit') parts.push(`hit:${Math.round(Number(score))}`);
    else parts.push(Number(score).toFixed(2));
  }
  const rowHits = node.rowHits ?? node.row_hits;
  const termCount = node.termCount ?? node.term_count;
  if (rowHits != null && termCount != null) parts.push(`terms:${rowHits}/${termCount}`);
  // find --labels（opt-in）：命中行带节点信任标，便于一眼分受控/不受控。
  if (options.labels) parts.push(nodeTrustLabel(node));
  // 召回结果必须附带时间元数据（projectneed 15-12-6）：命中行尾缀更新时间。
  const updated = node.updatedAt || node.updated_at || null;
  if (updated) parts.push(`upd:${String(updated).replace(' ', 'T')}`);
  // --uuid：文档标签换 doc:UUID 的同时，行尾附节点稳定 id——find 命中可直接喂给
  // edit/read/inspect/log 的 nodeId，免去 tree --uuid / inspect 的二跳换算。
  if (options.uuid) {
    const nid = node.node_id ?? node.nodeId ?? node.id;
    if (nid) parts.push(`#${nid}`);
  }
  return parts.filter(Boolean).join(' ');
}

interface FormatGroupedHitsOptions extends FormatNodeLineOptions {
  fallbackDocId?: string | number;
  fallbackTitle?: string;
}

interface GroupedHitBucket {
  docId: string;
  title: string;
  lines: string[];
}

// find 命中按文档分组：文档标识（标题/docId）只在组头出一次，组内行省略 doc label，
// 消除每行重复 doc 标签的 token 开销，并让外部调用方从组头一次拿到下钻所需的 doc 标识。
// 单文档检索传 fallbackDocId/fallbackTitle 兜底（命中行不自带 doc 信息时用它）。
// 本次结果内出现同名文档（或显式 --uuid）时，组头带 doc:UUID 消歧。
function formatGroupedHits(rows: ShellHitRow[] = [], options: FormatGroupedHitsOptions = {}) {
  const groups = new Map<string, GroupedHitBucket>();
  const order: string[] = [];
  for (const row of rows) {
    const node: ShellNode = row.node || row;
    const docId = String(row.doc?.docId ?? row.doc?.id ?? node.docId ?? node.doc_id ?? options.fallbackDocId ?? '');
    const title = cleanLine(row.doc?.title ?? row.doc?.doc_title ?? row.docTitle ?? node.doc?.title ?? node.docTitle ?? options.fallbackTitle ?? '');
    const key = docId || title;
    if (!groups.has(key)) {
      groups.set(key, { docId, title, lines: [] });
      order.push(key);
    }
    groups.get(key)!.lines.push(formatNodeLine(row, { ...options, omitDocLabel: true }));
  }
  const titleCounts = new Map<string, number>();
  for (const key of order) {
    const { title } = groups.get(key)!;
    if (title) titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
  }
  const lines: string[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const ambiguous = Boolean(options.uuid) || (group.title && (titleCounts.get(group.title) || 0) > 1);
    const head = group.title
      ? (ambiguous && group.docId ? `[doc:${group.docId} | ${group.title}]` : `[${group.title}]`)
      : (group.docId ? `[doc:${group.docId}]` : '[?]');
    lines.push(head);
    for (const line of group.lines) lines.push(line ? `  ${line}` : '  ');
  }
  return lines.join('\n');
}

// 检索范围的人读描述（统计行用）：单篇 / 全库 / folder + 各过滤维度。
function searchScopeDescriptor(flags: ParsedFlags = {}, scope: ShellDocScope = {}) {
  const parts: string[] = [];
  if (scope.docId && !scope.allDocs) parts.push('单篇');
  else if (flags.folder) parts.push(`folder:${flags.folder}`);
  else parts.push('全库');
  if (flags.excludeFolder) parts.push(`排除folder:${flags.excludeFolder}`);
  if (flags.trust) parts.push(`trust:${flags.trust}`);
  if (flags.since || flags.until) parts.push(`time:${flags.since || ''}~${flags.until || ''}`);
  return parts.join(' ');
}

interface ShellSearchResult {
  rows?: ShellHitRow[];
  returned?: number;
  total?: number;
  scopeDocs?: number;
  matchMode?: string;
  groups?: Array<{ term?: string; rows?: ShellHitRow[] }>;
  error?: string;
}

// find 返回统计行：让命中数/范围一目了然，尤其让"0 命中"能区分范围空 vs 范围内没命中。
function findStatsLine(result: ShellSearchResult = {}, scopeDesc = '') {
  const returned = Number(result.returned ?? (result.rows?.length || 0)) || 0;
  const total = Number(result.total) || returned;
  const docs = new Set((result.rows || []).map((row) => String(row.doc?.docId ?? row.doc?.id ?? '')).filter(Boolean)).size;
  const scopeDocs = result.scopeDocs;
  const coverage = scopeDocs != null ? `，范围内可检索 ${scopeDocs} 篇` : '';
  const mode = result.matchMode ? `，matchMode=${result.matchMode}` : '';
  const docModeNote = result.matchMode === 'doc'
    ? '；doc 模式表示全部词在同一文档内命中，单行可能只命中部分词；同节点 AND 用 matchMode=node'
    : '';
  if (returned === 0) {
    return `— 0 命中（范围：${scopeDesc}${coverage}${mode}）；可拆词 / 调 kind/folder / 用 library_index 看目录${docModeNote}`;
  }
  const more = total > returned ? `，共 ${total}（已截 ${returned}）` : '';
  return `— 命中 ${returned} 节点 / ${docs} 文档${more}（范围：${scopeDesc}${coverage}${mode}）${docModeNote}`;
}

interface EntityFormatOptions {
  uuid?: boolean;
}

function formatEntityLabel(entity: ShellEntityRow = {}, options: EntityFormatOptions = {}) {
  const literal = cleanLine(entity.literal || entity.term || '');
  const label = docDisplayLabel(entity.doc || (entity as ShellDoc), {
    uuid: options.uuid,
    docId: entity.docId ?? entity.doc_id
  });
  return literal ? `${literal}${label ? `(${label})` : ''}` : '';
}

function formatEntityList(rows: ShellEntityRow[] = [], options: EntityFormatOptions = {}) {
  if (rows.length === 0) return '(无实体)';
  return rows.map((row) => {
    const literal = cleanLine(row.literal || '');
    const hits = Number(row.hitCount ?? row.hit_count) || 0;
    const label = docDisplayLabel(row as ShellDoc, { uuid: options.uuid, docId: row.docId ?? row.doc_id });
    return `${literal} x${hits}${label ? ` (${label})` : ''}`;
  }).filter(Boolean).join('\n');
}

function formatEntityTags(rows: ShellEntityRow[] = [], options: EntityFormatOptions = {}) {
  const synonym: string[] = [];
  const related: string[] = [];
  for (const row of rows) {
    const label = formatEntityLabel(row.entity || row, options);
    if (!label) continue;
    if (row.relation === 'synonym') synonym.push(label);
    else related.push(label);
  }
  return [
    synonym.length ? `同义: ${synonym.join('；')}` : '',
    related.length ? `相关: ${related.join('；')}` : ''
  ].filter(Boolean).join('\n');
}

function formatHistoryLine(row: ShellHistoryRow = {}) {
  const commit = row.id ?? row.commit_id ?? row.commitId ?? '';
  const savedAt = row.committed_at ?? row.committedAt ?? row.saved_at ?? row.savedAt ?? '';
  const summary = cleanLine(row.summary || '');
  const parts = [`commit:${commit}`];
  if (savedAt) parts.push(savedAt);
  if (summary) parts.push(summary);
  return parts.filter(Boolean).join(' ');
}

function historyRefSpec(flags: ParsedFlags = {}, positional: string[] = []): ShellHistorySpec {
  const flaggedDocId = normalizeShellDocId(flags.docId ?? positional[0], null);
  if (flags.history) return { kind: 'id', value: flags.history, docId: flaggedDocId };
  if (flags.at) return { kind: 'committed_at', value: flags.at, docId: flaggedDocId };
  if (flags.tag && flags.tag !== true) return { kind: 'summary', value: flags.tag, docId: flaggedDocId };
  const ref = String(positional[0] || '').trim();
  const docId = normalizeShellDocId(flags.docId ?? positional[1], null);
  if (!ref) return { kind: '', value: '', docId };
  if (isStableId(ref)) return { kind: 'id', value: ref, docId };
  return { kind: 'committed_at_or_summary', value: ref, docId };
}

// 历史 ref 的解析（id/committed_at/summary/模糊）已下沉 L4（handlers/read/history.resolveHistoryCommitRow）；
// shell 只把 CLI 语法解析成 ref/refKind 参数转发（historyRefSpec），不再自查 commits 表。

// article 原文窗口文本化：窗口头一行 + 原文（含 [原文开始]/[原文结束] 边界标记）+ 可选 source spans 紧凑行。
// db article（CLI/测试）与 MCP article 工具共用这一个格式化器——一套实现。传 --json 给原始结构。
function formatArticleWindow(res: ShellArticleResult = {}) {
  if (!res || typeof res !== 'object' || res.article === null || (res.text == null && !res.window)) {
    return '(无原文：该文档无 source 文档或窗口为空)';
  }
  const w: ShellArticleWindow = res.window || {};
  const head = `[原文窗口 offset ${w.startOffset ?? '?'}-${w.endOffset ?? '?'} / 全长 ${w.totalLength ?? '?'}`
    + `${w.hasBefore ? ' ↑上文更多' : ''}${w.hasAfter ? ' ↓下文更多' : ''}]`;
  const lines = [head, String(res.text ?? '')];
  const spans = Array.isArray(res.sourceSpans) ? res.sourceSpans : null;
  if (spans) {
    const total = Number.isFinite(Number(res.spansTotal)) ? Number(res.spansTotal) : spans.length;
    lines.push('', total > spans.length ? `[source spans ${spans.length} / 窗口共 ${total}]` : `[source spans ${spans.length}]`);
    for (const span of spans) {
      const start = span.absolute_start_offset ?? span.start_offset;
      const end = span.absolute_end_offset ?? span.end_offset;
      lines.push(`span:${span.id} s${span.sentence_index} ${start}-${end}`);
    }
  }
  return lines.join('\n');
}

// 快照内目标定位（稳定身份穿透 / --at-address 历史地址）已下沉 L4：
// history.snapshot/read 的 address + atAddress 参数（handlers/read/history.resolveSnapshotTarget）。

function formatRefLine(row: ShellRefRow = {}, addrById: Map<string, string> | null = null) {
  // 引用存的是稳定节点 UUID（位置变了也不断）；显示时若给了 id→address 映射，则把当前地址放前面作导航、
  // UUID 收进括号作稳定锚——地址方便直接 read，UUID 保证编辑后仍能定位、悬空引用也能暴露。
  const refEnd = (id: string | number | undefined) => {
    const ref = `node:${id ?? '?'}`;
    if (addrById && id !== undefined && id !== null && addrById.has(String(id))) {
      return `${addrById.get(String(id))} (${ref})`;
    }
    return ref;
  };
  const source = refEnd(row.source_id ?? row.sourceId);
  const target = refEnd(row.target_id ?? row.targetId);
  const kind = cleanLine(row.ref_kind || row.refKind || row.kind || '');
  const note = clip(row.note || '', 120);
  // 末尾带 ref:<id>——ref.delete 要 refId，inspect links 是拿到它的正路（端点地址只够人看、删不了引用）。
  const refId = row.id ?? row.refId ?? row.ref_id;
  return [`${source} -> ${target}`, kind ? `[${kind}]` : '', refId != null ? `ref:${refId}` : '', note].filter(Boolean).join(' ');
}

function valueOrNull(value: unknown) {
  return value === null || value === undefined || value === '' ? 'null' : String(value);
}

function formatSourceSpanLine(row: ShellSourceSpan = {}) {
  const id = row.id ?? row.spanId ?? row.span_id ?? '';
  const sentence = row.sentence_index ?? row.sentenceIndex ?? '';
  const start = row.absolute_start_offset ?? row.absoluteStartOffset ?? row.start_offset ?? row.startOffset ?? '';
  const end = row.absolute_end_offset ?? row.absoluteEndOffset ?? row.end_offset ?? row.endOffset ?? '';
  const parts: string[] = [];
  if (id !== '') parts.push(`span:${id}`);
  if (sentence !== '') parts.push(`sentence:${sentence}`);
  if (start !== '' || end !== '') parts.push(`offsets:${valueOrNull(start)}-${valueOrNull(end)}`);
  return parts.join(' ') || cleanLine(JSON.stringify(row));
}

function selectedDraftTarget(context: ShellContext = {}): ShellBranchTarget {
  return { docId: context.shellState?.selectedDocId ?? null };
}

function updateSelectedBranch(context: ShellContext = {}, next: ShellBranchTarget = {}): ShellBranchTarget {
  if (!context.shellState) context.shellState = {};
  context.shellState.selectedDocId = next.docId ?? null;
  return selectedDraftTarget(context);
}

function branchTarget(
  flags: ParsedFlags = {},
  context: ShellContext = {},
  fallbackDocId: string | number | null = null
): ShellBranchTarget {
  const selected = selectedDraftTarget(context);
  const docId = normalizeShellDocId(flags.docId ?? fallbackDocId, null);
  return { docId: docId ?? selected.docId ?? null };
}

function branchTargetLabel(target: ShellBranchTarget = {}) {
  return [
    target.docId ? `doc:${target.docId}` : ''
  ].filter(Boolean).join(' ');
}

// 把唯一草稿的 docId 铺进 payload。
function applyBranchTarget(payload: Record<string, unknown>, target: ShellBranchTarget = {}) {
  if (target.docId) payload.docId = target.docId;
  return payload;
}

function contextFunction(context: ShellContext = {}, name: string): (payload: Record<string, unknown>) => Promise<any> {
  const fn = context[name];
  if (typeof fn !== 'function') throw new Error(`db ${name} context is not available`);
  return fn as (payload: Record<string, unknown>) => Promise<any>;
}

function contextAgentMode(context: ShellContext = {}): 'qa' | 'edit' | 'full' {
  const mode = context.agentMode;
  if (mode === 'qa' || mode === 'edit' || mode === 'full') return mode;
  throw new Error('db agent bridge requires caller mode');
}

function parseJsonObjectArgument(value: unknown = '', fallback: Record<string, unknown> = {}): Record<string, unknown> {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('db edit json_payload must be a JSON object');
  }
  return parsed;
}

function normalizeEditSetField(value: unknown = '') {
  const field = String(value || '').trim();
  if (field === 'note' || field === 'node_note' || field === 'nodeNote') return 'node_note';
  if (field === 'type' || field === 'node_type' || field === 'nodeType') return 'node_type';
  throw new Error(`db edit --set unsupported field: ${field || '(empty)'}`);
}

function requireEditNodeArgs(positional: string[] = [], action = 'edit'): { docId: string; address: string } {
  const docId = normalizeShellDocId(positional[0], null);
  const address = String(positional[1] || '').trim();
  if (!docId || !address) throw new Error(`db edit ${action} requires <doc_id> <address>`);
  return { docId, address };
}

async function readEditTargetNode(database: ShellDatabase, docId: string, address: string): Promise<ShellNode> {
  const result = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary' }
  }, 'read');
  const node: ShellNode | null = result?.node || null;
  if (!node?.id) throw new Error(`db edit target not found: doc ${docId} ${address}`);
  return node;
}

function editBranchWriteTarget(
  flags: ParsedFlags = {},
  context: ShellContext = {},
  docId: string | null = null
): { docId: FlagValue | null } {
  const target = branchTarget(flags, context);
  if (target.docId && docId && String(target.docId) !== String(docId)) {
    throw new Error('db edit target doc_id must match switch 当前 docId');
  }
  return { docId: target.docId || docId };
}

interface FriendlyEditResult {
  kind: 'db_edit';
  text: string;
}

async function runFriendlyEdit(
  database: ShellDatabase,
  flags: ParsedFlags = {},
  positional: string[] = [],
  context: ShellContext = {}
): Promise<FriendlyEditResult | null> {
  if (flags.set) {
    const { docId, address } = requireEditNodeArgs(positional, '--set');
    const field = normalizeEditSetField(flags.set);
    const rawValue = positional.slice(2).join(' ');
    if (rawValue === '') throw new Error('db edit --set requires value');
    const value = field === 'node_type' ? normalizeNodeType(rawValue) : rawValue;
    const node = await readEditTargetNode(database, docId, address);
    const target = editBranchWriteTarget(flags, context, docId);
    const payload: Record<string, unknown> = {
      action: 'node.update',
      nodeId: node.id,
      patch: { [field]: value },
      docId: target.docId
    };
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_edit', text: flags.json ? JSON.stringify(result, null, 2) : formatWriteResult(result) };
  }

  return null;
}

function treeFromFlatNodes(nodes: ShellNode[] = []): ShellNode[] {
  const byId = new Map<string, ShellNode>();
  const roots: ShellNode[] = [];
  for (const node of nodes) byId.set(String(node.id), { ...node, children: [] });
  for (const node of byId.values()) {
    const parent = byId.get(String(node.parentId || ''));
    if (parent) parent.children!.push(node);
    else roots.push(node);
  }
  return roots;
}

interface FormatIndexNodeOptions {
  uuid?: boolean;
}

// 同时吃 shell 形态（content.getIndex / treeFromFlatNodes 产物）和历史快照展开形态（snapshotReadNode 返回 SnapshotReadNodeResult）。
function formatIndexNode(node: ShellNode | SnapshotReadNodeResult = {} as ShellNode, depth = 0, options: FormatIndexNodeOptions = {}): string[] {
  const shellNode = node as ShellNode;
  const title = nodePreview(shellNode);
  const chars = Number(shellNode.meta?.subtreeTextChars ?? shellNode.meta?.textChars) || 0;
  const semantic = semanticLabel(shellNode.meta?.semantic);
  const idSuffix = options.uuid && shellNode.id ? ` #${shellNode.id}` : '';
  const line = `${'  '.repeat(depth)}${shellNode.address || ''} ${nodeTypeLabel(shellNode)}${title ? ` ${title}` : ''} (${chars})${semantic ? ` ${semantic}` : ''}${idSuffix}`.trimEnd();
  const children = Array.isArray(shellNode.children) ? shellNode.children : [];
  return [line, ...children.flatMap((child) => formatIndexNode(child, depth + 1, options))];
}

function semanticLabel(semantic: ShellSemanticStatus | null = null) {
  if (!semantic?.status) return '';
  const vc = Number(semantic.vectorCount) || 0;
  const nc = Number(semantic.nodeCount) || 0;
  // 向量/节点 覆盖率（如 49/50），分子<分母即缺、不再用裸 vectors=N 让人误判齐了。
  const cov = (nc > 0 || vc > 0) ? ` ${vc}/${nc}` : '';
  return `[semantic:${semantic.status}${cov}]`;
}

// 跨库语义检索覆盖提示（projectneed 14-2）：allDocs 向量检索扫的是整个向量索引，只覆盖已向量化的节点，
// 未建向量的文档/节点根本不进结果——必须显式告知，否则"搜了空"会被误读成"库里没有"。
// （单篇语义不在此提示：requireDocVectorIndex 闸门会在向量不完整时先行报错，更具体，无需此处兜底。）
function semanticCoverageNotice({ allDocs = false }: { allDocs?: boolean } = {}) {
  if (!allDocs) return '';
  return '注意：语义检索只覆盖已建向量的节点；未向量化的节点/文档不会出现在结果里。用 library_index 看各文档 [semantic:] 状态，db vectors <doc> 补建。';
}

interface ReadDocDisplayLabelOptions {
  uuid?: boolean;
  docLabel?: string;
}

async function readDocDisplayLabel(
  database: ShellDatabase,
  docId: string,
  options: ReadDocDisplayLabelOptions = {}
): Promise<string> {
  if (options.docLabel !== undefined) return options.docLabel;
  try {
    const doc = await database.run({
      operation: 'read',
      payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false }
    }, 'read');
    return docDisplayLabel(doc?.doc || {}, { uuid: options.uuid, docId });
  } catch {
    return docDisplayLabel({}, { uuid: options.uuid, docId });
  }
}

interface LimitReadTextOptions {
  limit?: number;
  docId?: string;
  address?: string;
}

function limitReadText(text: unknown = '', options: LimitReadTextOptions = {}) {
  const value = String(text || '');
  const limit = Number(options.limit) || 0;
  if (limit > 0 && value.length > limit) {
    return [
      `该子树正文 ${value.length} 字，超过 ${limit} 字。`,
      `请先用 tree 查看 doc ${options.docId || ''} ${options.address || ''} 的下级地址，再分批 read 更小子树。`
    ].join('\n');
  }
  return value;
}

interface FlatSubtreeText {
  text: string;
  truncated: boolean;
  totalChars: number;
  used: number;
}

// 子树扁平正文（DFS 先序 + 字符预算）已下沉 L4（subtree.getFlatText，§6-2）；这里只转发。
async function collectFlatSubtreeText(
  database: ShellDatabase,
  docId: string,
  rootAddress: string,
  budget: number
): Promise<FlatSubtreeText> {
  const res = await database.run({
    operation: 'read',
    payload: { action: 'subtree.getFlatText', docId, address: rootAddress, charLimit: budget }
  }, 'read');
  return {
    text: typeof res?.text === 'string' ? res.text : '',
    truncated: res?.truncated === true,
    totalChars: Number(res?.totalChars) || 0,
    used: Number(res?.used) || 0
  };
}

// read scope=siblings：同父前/中/后三条的纯正文，带轻量导航标 〈role 地址〉、不带节点头。
// 额度向 target 倾斜（target 是细读主角、邻居只是上下文）：target 给完整 limit、邻居各给 limit/4，
// 都走 collectFlatSubtreeText 的 DFS 扁平截断——避免「大章 target 早停只剩标题、小邻居却整章刷屏」的反常。
async function readNeighborNodes(
  database: ShellDatabase,
  docId: string,
  address: string,
  options: { limit?: number } = {}
): Promise<string> {
  const indexResult = await database.run({
    operation: 'read',
    payload: { action: 'content.getIndex', docId, depth: 10000, detail: 'summary', limit: 0 }
  }, 'read');
  const nodes: ShellNode[] = Array.isArray(indexResult.nodes) ? indexResult.nodes : [];
  const target = nodes.find((node) => String(node.address || '') === String(address || '')) || null;
  if (!target?.id) throw new Error(`db read siblings target not found: doc ${docId} ${address}`);
  const siblings = nodes
    .filter((node) => String(node.parentId ?? '') === String(target.parentId ?? ''))
    .sort((left, right) => {
      const order = Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
      return order || String(left.address || '').localeCompare(String(right.address || ''));
    });
  const index = siblings.findIndex((node) => String(node.id) === String(target.id));
  const selected: (ShellNode | null)[] = [
    index > 0 ? siblings[index - 1] : null,
    target,
    index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null
  ];
  const labels = ['previous', 'target', 'next'];
  const limit = options.limit || READ_SUBTREE_TEXT_LIMIT;
  const neighborBudget = Math.max(1, Math.floor(limit / 4));
  const sections: string[] = [];
  for (let i = 0; i < selected.length; i += 1) {
    const node = selected[i];
    if (!node) {
      // 首/末子节点无前驱/后继：显式标「无」，避免静默少一条被当成漏读。
      sections.push(`〈${labels[i]} 无〉`);
      continue;
    }
    const isTarget = labels[i] === 'target';
    const budget = isTarget ? limit : neighborBudget;
    const { text, truncated, totalChars, used } = await collectFlatSubtreeText(database, docId, node.address || '', budget);
    sections.push(`〈${labels[i]} ${node.address || ''}〉`.trimEnd());
    if (text) sections.push(text);
    if (truncated) {
      sections.push(isTarget
        ? `— target 子树共 ${totalChars} 字，已显示前 ${used} 字；要全文：read address=${node.address} limit=${totalChars}`
        : `— ${labels[i]}（上下文）子树共 ${totalChars} 字，已截前 ${used} 字`);
    }
  }
  return sections.join('\n');
}

function dbReadTargetNotFoundError(docId: string, address: string) {
  return new Error(`db read target not found: doc ${docId} ${address}`);
}

async function requireDbReadTargetNode(database: ShellDatabase, docId: string, address: string): Promise<ShellNode> {
  const result = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary' }
  }, 'read');
  const node: ShellNode | null = result?.node || null;
  if (!node?.id) throw dbReadTargetNotFoundError(docId, address);
  return node;
}

// 只读动词（read/inspect/tree/log）的统一定位入口：address 是主定位方式；给了 --node-id 时
// 按节点稳定 UUID 兼容定位，解析成当前版本的 address 后复用 address 流程（address 仍是主路径，
// nodeId 只是兼容入口；两者都给时以 nodeId 为准）。节点在当前版本不存在（已删 / UUID 有误）
// 即报错——查历史里某版本的位置仍用 address + --at-address。
async function resolveNodeAddress(
  database: ShellDatabase,
  docId: string,
  address: unknown,
  nodeId: unknown
): Promise<string> {
  const raw = nodeId === undefined || nodeId === null ? '' : String(nodeId).trim();
  if (!raw) return String(address || '').trim();
  const result = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, nodeId: raw, detail: 'summary' }
  }, 'read');
  const node: ShellNode | null = result?.node || null;
  if (!node?.id) {
    throw new Error(`db: --node-id 未命中当前版本（doc ${docId} node ${raw}）：节点可能已删除或 UUID 有误；查历史位置请用 address + --at-address。`);
  }
  const resolvedAddress = String(node.address || '').trim();
  if (!resolvedAddress) {
    throw new Error(`db: --node-id 命中了节点（doc ${docId} node ${raw}）但它没有有效地址（疑似文档根/异常节点）；改用 address 定位。`);
  }
  return resolvedAddress;
}

interface BlameOptions {
  uuid?: boolean;
  limit?: number | string | boolean;
}

async function readSourceBlame(
  database: ShellDatabase,
  docId: string,
  address: string,
  options: BlameOptions = {}
): Promise<string> {
  const nodeResult = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary', include: ['source', 'timestamps', 'tags'] }
  }, 'read');
  const node = nodeResult?.node || null;
  if (!node?.id) throw new Error(`db read --blame target not found: doc ${docId} ${address}`);

  const doc = await database.run({
    operation: 'read',
    payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false }
  }, 'read');
  const sourceDocument = doc?.sourceDocument || null;
  const docLabel = docDisplayLabel(doc?.doc || {}, { uuid: options.uuid, docId });
  const lines = [
    `[${docLabel} ${node.address || address} ${nodeTypeLabel(node)} ${nodeTrustLabel(node)} ${nodePreview(node)}]`.trim(),
    `node_id: ${node.id}`,
    `source_position: ${valueOrNull(node.source?.position)}`,
    `node_created_at: ${valueOrNull(node.createdAt)}`,
    `node_updated_at: ${valueOrNull(node.updatedAt)}`
  ];

  if (!sourceDocument) {
    lines.push('source: none');
    return lines.join('\n');
  }

  lines.push(`source: ${valueOrNull(sourceDocument.source_type || sourceDocument.sourceType)} ${valueOrNull(sourceDocument.original_path || sourceDocument.originalPath)}`);
  if (sourceDocument.created_at || sourceDocument.createdAt) {
    lines.push(`source_created_at: ${valueOrNull(sourceDocument.created_at || sourceDocument.createdAt)}`);
  }

  const article = await database.run({
    operation: 'read',
    payload: {
      action: 'content.getArticle',
      docId,
      nodeId: node.id,
      include: ['spans'],
      // blame 要的是本节点自己的 spans：取全窗口 spans 再按 node_id 过滤，
      // 不能受 article 默认 span 上限(30)截断——否则靠窗口后段的节点其 spans 会被丢掉。
      spansLimit: 20000,
      ...(options.limit ? { limit: options.limit } : {})
    }
  }, 'read');
  const directSpans: ShellSourceSpan[] = (Array.isArray(article?.sourceSpans) ? article.sourceSpans : [])
    .filter((span: ShellSourceSpan) => String(span.node_id ?? span.nodeId ?? '') === String(node.id));
  const hasAnchor = directSpans.length > 0 || node.source?.position !== null && node.source?.position !== undefined;
  if (hasAnchor && article?.window) {
    lines.push(`window: ${article.window.startOffset}-${article.window.endOffset}/${article.window.totalLength} before:${Boolean(article.window.hasBefore)} after:${Boolean(article.window.hasAfter)}`);
  } else {
    lines.push('window: none');
  }
  lines.push('[source_spans]');
  lines.push(...(directSpans.length ? directSpans.map(formatSourceSpanLine) : ['none']));
  return lines.join('\n');
}

interface InspectOptions {
  sections?: string[];
  uuid?: boolean;
  limit?: number | string | boolean;
}


// inspect（D1）：节点/文档档案——身份段(总在) + 选取的 meta/source/links/note 段，输出一种一致结构。
// read 回归纯正文，身份/元信息一律来这里。
async function dbInspect(
  database: ShellDatabase,
  docId: string,
  address: string,
  options: InspectOptions = {}
): Promise<string> {
  const sections = Array.isArray(options.sections) && options.sections.length ? options.sections : ['meta', 'note'];
  const nodeResult = await database.run({
    operation: 'read',
    payload: { action: 'content.getNode', docId, address, detail: 'summary', include: ['source', 'timestamps', 'tags', 'note', 'hash'] }
  }, 'read');
  const node: ShellNode | null = nodeResult?.node || null;
  if (!node?.id) throw dbReadTargetNotFoundError(docId, address);
  const docLabel = await readDocDisplayLabel(database, docId, { uuid: options.uuid });
  const lines = [`[${[docLabel, node.address || address, nodeTypeLabel(node), nodeTrustLabel(node), nodePreview(node)].filter(Boolean).join(' ')}]`];
  let docCache: any = null;
  const loadDoc = async () => {
    if (!docCache) {
      docCache = await database.run({ operation: 'read', payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false } }, 'read');
    }
    return docCache;
  };
  if (sections.includes('meta')) {
    // sort/hash 随 content.getNode 的 include=hash 口径返回（原 debug.sql 自查已下沉，§6-2）。
    lines.push(`[meta] updated:${valueOrNull(node.updatedAt)} created:${valueOrNull(node.createdAt)} sort:${valueOrNull(node.sortOrder)} chars:${valueOrNull(node.meta?.textChars)} hash:${node.contentHash || 'null'}`);
  }
  if (sections.includes('note')) {
    const note = node.note ?? node.node_note ?? '';
    lines.push(`[note] ${String(note).trim() ? cleanLine(note) : '(无)'}`);
  }
  if (sections.includes('source')) {
    // 复用 blame 的 source/window/spans 渲染，去掉它自带的身份行（本函数已有统一身份段）。
    const blame = await readSourceBlame(database, docId, address, { uuid: options.uuid, limit: options.limit });
    lines.push(String(blame).split('\n').slice(1).join('\n'));
  }
  if (sections.includes('links')) {
    const doc = await loadDoc();
    const refs: ShellRefRow[] = (doc?.refs || []).filter((row: ShellRefRow) => (
      String(row.source_id) === String(node.id) || String(row.target_id) === String(node.id)
    ));
    const idx = await database.run({ operation: 'read', payload: { action: 'content.getIndex', docId, depth: 10000, detail: 'summary', limit: 0 } }, 'read');
    const addrById = new Map<string, string>((idx?.nodes || []).map((entry: ShellNode) => [String(entry.id), String(entry.address || '')]));
    lines.push(['[links]', ...(refs.length ? refs.map((row) => formatRefLine(row, addrById)) : ['(无)'])].join('\n'));
  }
  return lines.join('\n');
}

// tree --at（D3）：快照树的解析/定位/修剪已下沉 L4（history.snapshot 的 ref/address/depth 参数），
// 这里只转发 + formatIndexNode 渲染（复用在线 tree 的渲染器）。
async function treeHistorySnapshot(
  database: ShellDatabase,
  docId: string,
  address: string,
  flags: ParsedFlags = {}
): Promise<string> {
  const payload: Record<string, unknown> = {
    action: 'history.snapshot',
    docId,
    ref: String(flags.at ?? '').trim(),
    depth: Number(flags.depth) > 0 ? Number(flags.depth) : 2
  };
  if (address) {
    payload.address = address;
    if (flags.atAddress) payload.atAddress = true;
  }
  const result = await database.run({ operation: 'read', payload }, 'read');
  const roots: SnapshotReadNodeResult[] = Array.isArray(result?.roots) ? result.roots : [];
  const lines = roots.flatMap((root) => formatIndexNode(root, 0, { uuid: Boolean(flags.uuid) }));
  const docDepth = Number(result?.docDepth) || 0;
  const prunedDepth = Number(result?.prunedDepth) || 0;
  if (docDepth > prunedDepth) {
    lines.push(`— 已展开 ${prunedDepth} / 共 ${docDepth} 层（历史快照 @${flags.at}）；加大 depth 或指定 address 下钻`);
  }
  return lines.join('\n');
}

// find --at（D3）：快照内字面 node-AND 检索已下沉 L4（history.find），这里只转发 + 命中渲染；
// 语义/跨文档不支持（向量只建在 HEAD）。
async function findHistorySnapshot(
  database: ShellDatabase,
  terms: string[],
  flags: ParsedFlags = {},
  context: ShellContext = {}
): Promise<string> {
  const scope = docScope(flags, context);
  if (!scope.docId || scope.allDocs) {
    throw new Error('find --at 需限定单篇（给 docId 或 --scope）；历史快照不支持跨文档检索');
  }
  const payload: Record<string, unknown> = {
    action: 'history.find',
    docId: scope.docId,
    ref: String(flags.at ?? '').trim(),
    terms
  };
  if (flags.scopeAddress) payload.scopeAddress = String(flags.scopeAddress);
  if (Number(flags.limit) > 0) payload.limit = Number(flags.limit);
  const result = await database.run({ operation: 'read', payload }, 'read');
  const hitRows: ShellHitRow[] = Array.isArray(result?.rows) ? result.rows : [];
  const docLabel = await readDocDisplayLabel(database, scope.docId, { uuid: flags.uuid });
  const body = formatGroupedHits(hitRows, {
    uuid: flags.uuid,
    scoreKind: 'hit',
    fallbackDocId: scope.docId,
    fallbackTitle: flags.uuid ? '' : docLabel
  });
  const total = Number(result?.total) || 0;
  const returned = Number(result?.returned) || hitRows.length;
  const more = returned < total ? `，共 ${total}（已截 ${returned}）` : '';
  const stats = returned === 0
    ? `— 0 命中（历史快照 @${flags.at}，字面 node-AND）；可拆词重试`
    : `— 历史命中 ${returned} 节点${more}（历史快照 @${flags.at}，字面 node-AND；语义/跨文档不支持）`;
  return [body, stats].filter(Boolean).join('\n\n').replace(/^\n+/, '') || stats;
}

// read --at（历史快照）：正文读取已下沉 L4（history.read 的 range 参数），这里只转发 +
// siblings 三段拼排 + subtree 的 L5 文本预算截断。历史元信息/出处/引用是另一回事
//（snapshot 也不存 source spans），不在 read 里兼。
async function readHistorySnapshot(
  database: ShellDatabase,
  docId: string,
  address: string,
  flags: ParsedFlags = {}
): Promise<string> {
  const range = ['node', 'subtree', 'siblings'].includes(String(flags.range)) ? String(flags.range) : 'subtree';
  const payload: Record<string, unknown> = {
    action: 'history.read',
    docId,
    ref: String(flags.at ?? '').trim(),
    address,
    range
  };
  if (flags.atAddress) payload.atAddress = true;
  const result = await database.run({ operation: 'read', payload }, 'read');
  if (range === 'siblings') {
    return ([
      ['previous', result?.previous ?? null],
      ['target', result?.target ?? null],
      ['next', result?.next ?? null]
    ] as Array<[string, { address?: unknown; text?: unknown } | null]>).map(([label, row]) => (row
      ? [`〈${label} ${row.address || ''}〉`.trimEnd(), String(row.text || '')].filter(Boolean).join('\n')
      : `〈${label} 无〉`)).join('\n');
  }
  if (range === 'node') {
    return String(result?.text ?? '');
  }
  return limitReadText(String(result?.text ?? ''), { docId, address, limit: Number(flags.limit) || READ_SUBTREE_TEXT_LIMIT });
}

export function dbShellHelp() {
  return [
    'Usage:',
    '  db find <term>... [--semantic] [--entity [--expand]] [--scope <doc_id> <address>] [--all-docs] [--at <ref>] [--limit N] [--uuid]',
    '  db index [--folder <library_relative_path>] [--summary] [--include-hidden] [--uuid]',
    '  db tree <doc_id> [address] [--from <address>] [--depth N] [--at <ref>] [--uuid]',
    '  db read <doc_id> <address> [--range node|subtree|siblings] [--at <ref>] [--limit N] [--uuid]  (只回正文；元信息/出处/引用/事实用 inspect、原文窗口用 article)',
    '  db inspect <doc_id> <address> [--sections meta,source,links,note] [--limit N] [--uuid]  (节点/文档档案：身份+元信息/出处/引用/备注)',
    '  db article <doc_id> [address] [--node-id <uuid>] [--start <offset>] [--before N] [--limit N] [--spans] [--spans-limit N] [--json]  (导入原件原文窗口，按字符偏移)',
    '  db log <doc_id> [--limit N]',
    '  db diff <doc_id> <commit_id> | <doc_id> <from_commit_id> <to_commit_id>  (两版历史)',
    '  db diff [doc_id]  (草稿↔正文；省略 docId 时用 switch 当前文档)',
    '  db diff [doc_id] --from <ref> --to <ref>  (refA↔refB；ref ∈ head · <commitId> · draft[:docId])',
    '    diff 通用：[--detail summary|full]（默认 full 逐行，summary 出节点+计数）[--json]（结构化输出）',
    '  db sql <SELECT_or_WITH_sql> [--params <json>] [--limit N] [--json]',
    '  db screenshot  (只读：截取应用窗口当前画面，图片随回执返回；PNG 暂存 .iftree-llm-workspace/screenshot/；查看截图需模型具备视觉能力)',
    '  db ask_agent <prompt> [--doc-id <doc_id>] [--session-id <id>]',
    '  db edit <database_write_action> [json_payload] [--doc-id <doc_id>]',
    '  db edit <doc_id> <address> --set <field> <value>',
    '    --set fields: node_note/node_type；node_type: 文本/如果/那么/否则/错误',
    '  db restore <commit_id|committed_at|tag> [doc_id]',
    '  db revert <commit_id> [doc_id]  (恢复该 commit 的父快照，并在当前 HEAD 上创建新 commit)',
    '  db gc  (对象库垃圾回收 mark-sweep：回收不被任何 commit 引用的历史对象)',
    '  db certify <doc_id> <address> [--node-id <uuid>] [--node] [--trust 受控|不受控]  (human 背书：标受控唯一入口；--node 只本节点，默认整子树)',
    '  db import <library_relative_path> [--mode simple|complete|direct|vector] [--embed]  (smart 走应用内 Agent 或 db import-json)',
    '  db import-json <json_file> <source_file> [--dry-run] [--embed]  (智能导入 4-3-3：校验节点树 JSON 并入库)',
    '  db vectors <doc_id>',
    '  db delete <doc_id>',
    '  db relink <doc_id> <source_path>  (重绑 doc 的源文件路径；锚改名/迁移后用，只改绑定不动正文)',
    '  db draft <doc_id>  (幂等开稿)',
    '  db discard [doc_id] [--yes]  (省略 docId 时用 switch 当前文档)',
    '  db undo [doc_id]',
    '  db redo [doc_id]',
    '  db switch <doc_id>',
    '  db commit [doc_id] [--summary text] [--tag text]',
    '  db shell [--cwd workspace|library|path] [--timeout-ms N] [--] <command>',
    '  db web search <query> [--limit N]',
    '  db web open <url> [--char-limit N]',
    '  db keyword/query ... (compat aliases for db find)',
    '',
    '# 进阶：admin_override 工具（绕过 db，直接调底层只读查询 API）',
    '  常规检索/读取一律用上面的 db 命令；仅当 db 满足不了时，才用 admin_override 工具传 {action, 参数}。',
    '  常用 action：content.search（searchMode=vector 语义 / keyword 子串）、content.searchKeyword（terms 多词 AND）、content.searchAll（跨文档）、content.getNode/getSubtree/getIndex（读正文/结构）、history.*/node.*/debug.sql。',
    '  db 命令本质就是这些 action 的封装（已替你注入 docId、设默认、格式化输出），所以优先用 db。'
  ].join('\n');
}

interface DbShellResult {
  kind: string;
  text: string;
  image?: {
    id: string;
    name: string;
    mediaType: string;
    data: string;
  };
  width?: number;
  height?: number;
}

export async function runDbShellArgv(
  database: ShellDatabase,
  argv: unknown[] = [],
  context: ShellContext = {}
): Promise<DbShellResult> {
  if (!database?.run) throw new Error('db command requires database service');
  const args = normalizeArgv(argv);
  const command = args[0] || '';
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { kind: 'db_help', text: dbShellHelp() };
  }

  if (command === 'screenshot') {
    if (args.length !== 1) throw new Error('db screenshot 不接收参数。');
    const captureScreenshot = contextFunction(context, 'captureScreenshot');
    const captured = await captureScreenshot({});
    const image = captured?.image;
    if (image?.mediaType !== 'image/png' || !String(image?.data || '')) {
      throw new Error('截图服务没有返回有效的 PNG。');
    }
    const width = Number(captured?.width) || 0;
    const height = Number(captured?.height) || 0;
    const savedPath = String(captured?.savedPath || '');
    return {
      kind: 'db_screenshot',
      text: [
        `已截取应用窗口当前画面${width > 0 && height > 0 ? `（${width}×${height} px）` : ''}，见附图。`,
        savedPath ? `截图已暂存：${savedPath}` : ''
      ].filter(Boolean).join('\n'),
      image: {
        id: String(image.id || ''),
        name: String(image.name || 'screenshot.png'),
        mediaType: 'image/png',
        data: String(image.data)
      },
      width,
      height
    };
  }

  if (command === 'find') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (flags.scopeDocId) flags.scopeDocId = await resolveDocRef(database, flags.scopeDocId);
    // --folder/--exclude-folder 是「文件夹虚拟文档」范围：folder 本身即跨文档（在该子树内开 allDocs），
    // 无需再单独给 --all-docs；排除则是从当前虚拟文档里挖掉子树。
    if ((flags.folder || flags.excludeFolder) && !flags.scopeDocId) flags.allDocs = true;
    if (flags.semantic && (flags.folder || flags.excludeFolder)) {
      throw new Error('db find 的 --folder/--exclude-folder 暂只支持字面检索，不支持 --semantic（语义路径的范围过滤待接入）。');
    }
    // find 限定单篇时 docId 经 currentDocId 通道传入（mcp-server 无 scopeAddress 时走第三参），
    // 此前只解析了 --scope、漏接了这条通道——标题被当成裸 id 直接撞 docScope 守卫。与 --scope 对齐：
    // 仅当原值不是合法 UUID/整数时才过 resolveDocRef（标题唯一直接定位、重名抛候选 UUID，15-5-1-2）。
    if (!flags.allDocs && !flags.scopeDocId) {
      const rawCurrentDocId = context.currentDocId ?? context.docId;
      if (rawCurrentDocId != null && String(rawCurrentDocId).trim() !== '' && normalizeShellDocId(rawCurrentDocId, null) == null) {
        context = { ...context, currentDocId: await resolveDocRef(database, rawCurrentDocId) };
      }
    }
    if (flags.semantic && flags.entity) throw new Error('db find cannot combine --semantic and --entity');
    if (flags.expand && !flags.entity) throw new Error('db find --expand requires --entity');
    if (flags.or) throw new Error('db find --or is not supported; run db find once per term for OR.');
    if (flags.at) {
      if (flags.semantic) throw new Error('find --at 仅支持字面检索（语义向量只建在 HEAD，历史快照无向量）');
      if (flags.entity) throw new Error('find --at 不支持 --entity（实体库随 HEAD，不查历史快照）');
      if (positional.length === 0) throw new Error('find --at requires at least one term');
      return { kind: 'db_find', text: await findHistorySnapshot(database, positional, flags, context) };
    }
    if (flags.semantic) {
      const query = positional.join(' ').trim();
      if (!query) throw new Error('db find --semantic requires natural language text');
      const scope = docScope(flags, context);
      // 语义相似度下限：默认 0.51（过滤 sim < 0.51 的弱相关）；--min-score 覆盖（高级搜索可调）。
      // 过滤与 scopeAddress 范围收窄都已下沉 L4（content.search/searchAll 的 minScore/scopeAddress 参数）。
      const minSim = flags.minScore != null ? Number(flags.minScore) : 0.51;
      const payload = scope.allDocs
        ? { action: 'content.searchAll', query, searchMode: 'vector', allDocs: true, limit: flags.limit, includeHidden: flags.includeHidden, minScore: minSim }
        : { action: 'content.search', query, searchMode: 'vector', docId: scope.docId, limit: flags.limit, minScore: minSim, scopeAddress: flags.scopeAddress || undefined };
      const result = await database.run({ operation: 'read', payload }, 'read');
      if (result.error) throw new Error(result.error);
      const rows: ShellHitRow[] = result.rows || [];
      const weakFilteredOut = Number(result.weakFilteredOut) || 0;
      const docLabel = scope.allDocs ? '' : await readDocDisplayLabel(database, scope.docId!, { uuid: flags.uuid });
      const body = formatGroupedHits(rows, {
        uuid: flags.uuid,
        scoreKind: 'sim',
        fallbackDocId: scope.docId || '',
        fallbackTitle: (scope.allDocs || flags.uuid) ? '' : docLabel
      });
      const notice = semanticCoverageNotice({ allDocs: scope.allDocs });
      // 语义检索此前不发统计行（字面检索发），命中后直接结束、看不出是 top-K 截断还是全部。
      // 补一条与字面检索对齐的尾行，并标明是按相似度排序取 top-K。
      const scopeDesc = searchScopeDescriptor(flags, scope);
      const docCount = scope.allDocs
        ? new Set(rows.map((row) => String(row.doc?.docId ?? row.doc?.id ?? row.docId ?? row.doc_id ?? '')).filter(Boolean)).size
        : (rows.length ? 1 : 0);
      const weakNote = weakFilteredOut > 0 ? `（已滤除 ${weakFilteredOut} 条 sim<${minSim} 弱相关，--min-score 可调）` : '';
      const stats = rows.length === 0
        ? (weakFilteredOut > 0
          ? `— 0 命中（范围：${scopeDesc}）：召回 ${weakFilteredOut} 条但 sim 均 <${minSim} 被判弱相关已滤；--min-score 调低可纳入 / 换近义词 / 用 library_index 看目录`
          : `— 0 命中（范围：${scopeDesc}）；可换近义词重试 / 调大 limit / 用 library_index 看目录`)
        : `— 语义命中 ${rows.length} 节点 / ${docCount} 文档（范围：${scopeDesc}）；按相似度排序取 top ${rows.length}${weakNote}`;
      return {
        kind: 'db_find',
        text: [body, stats, notice].filter(Boolean).join('\n\n').replace(/^\n+/, '')
      };
    }
    if (flags.entity) {
      const scope = docScope(flags, context);
      if (positional.length === 0) {
        const result = await database.run({
          operation: 'read',
          payload: { action: 'entity.list', ...scope, limit: flags.limit }
        }, 'read');
        return {
          kind: 'db_find_entity',
          text: formatEntityList(result.rows || [], { uuid: flags.uuid })
        };
      }
      if (!flags.expand) {
        const result = await database.run({
          operation: 'read',
          payload: {
            action: 'entity.listRelated',
            terms: positional,
            ...scope,
            limit: flags.limit
          }
        }, 'read');
        return {
          kind: 'db_find_entity',
          text: formatEntityTags(result.rows || [], { uuid: flags.uuid })
        };
      }
      // --entity --expand: 同义扩展 + OR 召回 + AND 框架过滤的编排已下沉 L4
      //（content.searchEntityExpand），这里只转发 + 渲染扩展提示行与命中。
      const result = await database.run({
        operation: 'read',
        payload: {
          action: 'content.searchEntityExpand',
          terms: positional,
          ...scope,
          limit: flags.limit,
          trust: flags.trust,
          since: flags.since,
          until: flags.until,
          folder: flags.folder,
          excludeFolder: flags.excludeFolder,
          includeLabels: flags.labels,
          includeHidden: flags.includeHidden
        }
      }, 'read');
      const filteredRows: ShellHitRow[] = Array.isArray(result?.rows) ? result.rows : [];
      const expansions: Array<{ term?: unknown; expanded?: unknown[] }> = Array.isArray(result?.expansions) ? result.expansions : [];
      const docLabel = scope.allDocs ? '' : await readDocDisplayLabel(database, scope.docId!, { uuid: flags.uuid });
      const expandNote = expansions.some((entry) => (entry.expanded || []).length > 1)
        ? `同义扩展: ${expansions.map((entry) => ((entry.expanded || []).length > 1
            ? `${entry.term} → [${(entry.expanded || []).join(', ')}]`
            : String(entry.term ?? ''))).join('；')}`
        : '';
      const body = formatGroupedHits(filteredRows, {
        uuid: flags.uuid,
        scoreKind: 'hit',
        fallbackDocId: scope.docId || '',
        fallbackTitle: (scope.allDocs || flags.uuid) ? '' : docLabel,
        labels: flags.labels
      });
      const scopeDesc = searchScopeDescriptor(flags, scope);
      const stats = `— 命中 ${filteredRows.length} 节点（范围：${scopeDesc}；实体同义扩展）`;
      return {
        kind: 'db_find_entity',
        text: [expandNote, body, stats].filter(Boolean).join('\n\n').replace(/^\n+/, '')
      };
    }
    if (positional.length === 0) throw new Error('db find requires at least one term');
    const scope = docScope(flags, context);
    const result = await database.run({
      operation: 'read',
      payload: {
        action: 'content.searchKeyword',
        terms: positional,
        matchMode: flags.matchMode || 'doc',
        ...scope,
        limit: flags.limit,
        // 字面命中次数下限（高级搜索）：过滤已下沉 L4（分页前过滤，returned/total 即真实统计）。
        minScore: flags.minScore != null ? Number(flags.minScore) : undefined,
        trust: flags.trust,
        since: flags.since,
        until: flags.until,
        folder: flags.folder,
        excludeFolder: flags.excludeFolder,
        includeLabels: flags.labels,
        includeHidden: flags.includeHidden
      }
    }, 'read');
    const docLabel = scope.allDocs ? '' : await readDocDisplayLabel(database, scope.docId!, { uuid: flags.uuid });
    const body = formatGroupedHits(result.rows || [], {
      uuid: flags.uuid,
      scoreKind: 'hit',
      fallbackDocId: scope.docId || '',
      fallbackTitle: (scope.allDocs || flags.uuid) ? '' : docLabel,
      labels: flags.labels
    });
    const stats = findStatsLine(result, searchScopeDescriptor(flags, scope));
    return {
      kind: 'db_find',
      text: [body, stats].filter(Boolean).join('\n\n').replace(/^\n+/, '')
    };
  }

  if (command === 'keyword') {
    return runDbShellArgv(database, ['find', ...args.slice(1)], context);
  }

  if (command === 'query') {
    return runDbShellArgv(database, ['find', '--semantic', ...args.slice(1)], context);
  }

  if (command === 'index') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (positional.length > 0) throw new Error('db index does not accept doc id; use db tree <doc_id> for document structure');
    const payload: Record<string, unknown> = { action: 'library.index', format: 'ascii_tree' };
    if (flags.folder) payload.path = flags.folder;
    if (flags.summary) payload.includeSummary = true;
    if (flags.includeHidden) payload.includeHidden = true;
    if (flags.uuid) payload.uuid = true;
    const result = await database.run({ operation: 'read', payload }, 'read');
    return {
      kind: 'db_index',
      text: result.text || ''
    };
  }

  if (command === 'tree') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (!positional[0]) throw new Error('db tree requires doc_id');
    const docId = await resolveDocRef(database, positional[0]);
    const positionalAddress = String(positional[1] || '').trim();
    if (positionalAddress && flags.from && positionalAddress !== String(flags.from).trim()) {
      throw new Error('db tree address and --from must match when both are provided');
    }
    let address = String(flags.from || positionalAddress || '').trim();
    // --node-id（兼容入口，优先于 address/--from）：按节点稳定 UUID 解析成当前 address 再展开。
    if (flags.nodeId !== undefined) address = await resolveNodeAddress(database, docId, address, flags.nodeId);
    if (flags.at) {
      return { kind: 'db_tree', text: await treeHistorySnapshot(database, docId, address, flags) };
    }
    const payload: Record<string, unknown> = address
      ? { action: 'content.getSubtree', docId, address, levels: flags.depth, detail: 'summary', limit: 0 }
      : { action: 'content.getIndex', docId, depth: flags.depth, detail: 'summary', limit: 0 };
    if (flags.uuid) payload.uuid = true;
    const result = await database.run({ operation: 'read', payload }, 'read');
    const roots: ShellNode[] = result.tree ? [result.tree] : treeFromFlatNodes(result.nodes || []);
    const lines = roots.flatMap((root) => formatIndexNode(root, 0, { uuid: Boolean(flags.uuid) }));
    // 默认 index（不带 address）只展开有限层；文档更深时提示当前/最大层与下钻方式，避免误以为文档只有这么浅。
    if (!address && result.docDepth && result.indexDepth && result.docDepth > result.indexDepth) {
      lines.push(`— 已展开 ${result.indexDepth} / 共 ${result.docDepth} 层；加大 depth 或指定 address 下钻看更深`);
    }
    return { kind: 'db_tree', text: lines.join('\n') };
  }

  if (command === 'read') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (!positional[0]) throw new Error('db read requires <doc_id>');
    const docId = await resolveDocRef(database, positional[0]);
    const address = await resolveNodeAddress(database, docId, positional[1], flags.nodeId);
    if (!address) throw new Error('db read requires <address> 或 --node-id <uuid>');
    if (flags.at) {
      return {
        kind: 'db_read_at',
        text: await readHistorySnapshot(database, docId, address, flags)
      };
    }
    let targetNode: ShellNode | null = null;
    const readTargetNode = async () => {
      if (!targetNode) targetNode = await requireDbReadTargetNode(database, docId, address);
      return targetNode;
    };
    // read 只回正文，range 决定范围（node 只本节点 / subtree 整棵子树(默认) / siblings 同父前中后三条）、不带节点头。
    // 元信息/出处/引用/事实用 inspect、原文窗口用 article——read 不再兼这些镜头（一套实现、无兼容别名）。
    const range = ['node', 'subtree', 'siblings'].includes(String(flags.range)) ? String(flags.range) : 'subtree';
    const textLimit = Number(flags.limit) || READ_SUBTREE_TEXT_LIMIT;
    if (range === 'siblings') {
      await readTargetNode();
      return {
        kind: 'db_read_neighbors',
        text: await readNeighborNodes(database, docId, address, { limit: textLimit })
      };
    }
    if (range === 'node') {
      const node = await readTargetNode();
      const nodeResult = await database.run({ operation: 'read', payload: { action: 'content.getNode', docId, address, detail: 'full' } }, 'read');
      return { kind: 'db_read', text: String(nodeResult?.node?.text ?? node.text ?? '') };
    }
    await readTargetNode();
    const result = await database.run({ operation: 'read', payload: { action: 'content.getSubtree', docId, address, format: 'text', textLimit, limit: 0 } }, 'read');
    return { kind: 'db_read', text: typeof result.text === 'string' ? result.text : '' };
  }

  if (command === 'inspect') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (!positional[0]) throw new Error('db inspect requires <doc_id>');
    const docId = await resolveDocRef(database, positional[0]);
    const address = await resolveNodeAddress(database, docId, positional[1], flags.nodeId);
    if (!address) throw new Error('db inspect requires <address> 或 --node-id <uuid>');
    const sections = [];
    const rawSections = typeof flags.sections === 'string' ? flags.sections : '';
    for (const name of rawSections.split(',').map((part) => part.trim()).filter(Boolean)) {
      if (['meta', 'source', 'links', 'note'].includes(name)) sections.push(name);
    }
    return { kind: 'db_inspect', text: await dbInspect(database, docId, address, { sections, limit: flags.limit, uuid: flags.uuid }) };
  }

  if (command === 'article') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (!positional[0]) throw new Error('db article requires <doc_id>');
    const docId = await resolveDocRef(database, positional[0]);
    const payload: Record<string, unknown> = { action: 'content.getArticle', docId };
    const address = String(positional[1] || '').trim();
    if (address) {
      const node = await requireDbReadTargetNode(database, docId, address);
      payload.nodeId = node.id;
    }
    if (flags.nodeId !== undefined) payload.nodeId = flags.nodeId;
    if (flags.start !== undefined) payload.startOffset = Number(flags.start);
    if (flags.before !== undefined) payload.before = Number(flags.before);
    if (flags.limit !== undefined) payload.limit = Number(flags.limit);
    if (flags.spansLimit !== undefined) payload.spansLimit = Number(flags.spansLimit);
    if (flags.spans) payload.include = ['spans'];
    const result = await database.run({ operation: 'read', payload }, 'read');
    return { kind: 'db_article', text: flags.json ? JSON.stringify(result, null, 2) : formatArticleWindow(result) };
  }

  if (command === 'log') {
    const { flags, positional } = parseFlags(args.slice(1));
    if (!positional[0]) throw new Error('db log requires doc_id');
    const docId = await resolveDocRef(database, positional[0]);
    let address = positional[1] ? String(positional[1]) : null;
    // --node-id（兼容入口）：按节点稳定 UUID 解析成当前 address，走节点级 log。
    if (flags.nodeId !== undefined) address = await resolveNodeAddress(database, docId, address || '', flags.nodeId);
    if (address) {
      // 节点级 log（git log <path>）：某地址的节点（--node）或整棵子树（默认）在哪些 commit 被改。
      const scope = flags.node ? 'node' : 'subtree';
      const result = await database.run({
        operation: 'read',
        payload: { action: 'history.nodeLog', docId, address, scope }
      }, 'read');
      const rows = Array.isArray(result?.history) ? result.history : [];
      const limited = flags.limit ? rows.slice(0, Number(flags.limit)) : rows;
      const head = `# ${address} ${scope === 'node' ? '本节点' : '整棵子树'}：共 ${rows.length} 次改动`;
      return { kind: 'db_log', text: [head, limited.map(formatHistoryLine).join('\n')].filter(Boolean).join('\n') };
    }
    const result = await database.run({
      operation: 'read',
      payload: { action: 'doc.get', docId, includeNodes: false, includeEditBranch: false }
    }, 'read');
    const rows = Array.isArray(result?.history) ? result.history : [];
    const limitedRows = flags.limit ? rows.slice(0, Number(flags.limit)) : rows;
    return {
      kind: 'db_log',
      text: limitedRows.map(formatHistoryLine).join('\n')
    };
  }

  if (command === 'diff') {
    const { flags, positional } = parseFlags(args.slice(1));
    const detail = flags.detail === 'summary' ? 'summary' : 'full';
    // formatDiffText 收 DiffTextResult；IPC 返回是 unknown，cast 在边界。
    // --json 经 slimDiffView 收口（left/right 只留对账+内容字段、丢 branch 快照大字符串）——LLM 通道口径；
    // 前端要完整结构走 IPC 另路，不经此处。
    const renderDiff = (result: any) => (flags.json ? JSON.stringify(slimDiffView(result), null, 2) : formatDiffText(result, { detail }));
    // refA↔refB：给了 --from/--to 即走通用 diff.refs（ref ∈ head / commit / draft[:docId]）。
    if (flags.from !== undefined || flags.to !== undefined) {
      const docId: string | null = positional[0] ? await resolveDocRef(database, positional[0]) : null;
      const selectedRef = selectedDraftTarget(context);
      const draftRef = () => ({
        draft: true,
        docId: docId ?? selectedRef.docId ?? undefined
      });
      const headRef = { head: true, docId };
      const fromGiven = flags.from !== undefined;
      const toGiven = flags.to !== undefined;
      const payload: Record<string, unknown> = {
        action: 'diff.refs',
        from: fromGiven ? parseDiffRef(flags.from, { docId, draftRef }) : headRef,
        // 只给 --from（如某历史↔当前正文）时，对端默认落正文 head 而非草稿——否则未选草稿会误报”草稿未找到”。
        to: toGiven ? parseDiffRef(flags.to, { docId, draftRef }) : (fromGiven ? headRef : draftRef())
      };
      if (docId) payload.docId = docId;
      const result = await database.run({ operation: 'read', payload }, 'read');
      return { kind: 'db_diff', text: renderDiff(result) };
    }
    // 0/1 个位置参数：草稿↔正文；省略 docId 时使用 switch 当前文档。
    if (positional.length <= 1) {
      const target = branchTarget(flags, context, positional[0] || null);
      if (!target.docId) throw new Error('db diff 需要 <docId> 或先 switch <docId>');
      const payload: Record<string, unknown> = { action: 'editBranch.diffView', changedOnly: true };
      // --entity：把草稿的实体改动按动作流也列进 diff（一次实体绑定常涉上千节点，默认不列避免刷屏）。
      if (flags.entity) payload.includeEntities = true;
      applyBranchTarget(payload, target);
      const result = await database.run({ operation: 'read', payload }, 'read');
      return { kind: 'db_diff', text: renderDiff(result) };
    }
    // 两版历史（位置参：doc_id [from_history] to_history）
    if (!positional[0]) throw new Error('db diff requires docId');
    const docId = await resolveDocRef(database, positional[0]);
    const fromHistoryId = positional[1] && positional[2] ? positional[1] : '';
    const toHistoryId = positional[2] || positional[1] || '';
    if (!toHistoryId) throw new Error('db diff requires commit id');
    const payload: Record<string, unknown> = { action: 'history.diff', docId, toHistoryId };
    if (fromHistoryId && fromHistoryId !== toHistoryId) payload.fromHistoryId = fromHistoryId;
    const result = await database.run({ operation: 'read', payload }, 'read');
    return { kind: 'db_diff', text: renderDiff(result) };
  }

  if (command === 'sql') {
    const { flags, positional } = parseFlags(args.slice(1));
    const sql = positional.join(' ').trim();
    if (!sql) throw new Error('db sql requires a SELECT/WITH query');
    const payload: Record<string, unknown> = { action: 'debug.sql', sql };
    if (flags.params !== undefined) {
      try { payload.params = JSON.parse(String(flags.params)); }
      catch { throw new Error('db sql --params 需要合法 JSON（数组对应 ? 参数，对象对应 @name 参数）'); }
    }
    if (flags.limit) payload.limit = flags.limit;
    const result = await database.run({ operation: 'read', payload }, 'read');
    return { kind: 'db_sql', text: flags.json ? JSON.stringify(result, null, 2) : formatSqlResult(result) };
  }

  if (command === 'ask_agent') {
    const { flags, positional } = parseFlags(args.slice(1));
    const prompt = positional.join(' ').trim();
    if (!prompt) throw new Error('db ask_agent requires prompt text');
    const payload: Record<string, unknown> = { prompt };
    // docId 解析交给 askAgent 漏斗（runAgent 统一过 resolveDocRef、支持标题）：这里只取原值，
    // 不预先 normalize 掉标题。优先显式 --doc-id，否则用当前文档（已是规范化 id）。
    const rawDocId = (flags.docId != null && String(flags.docId).trim() !== '') ? flags.docId : currentDocIdFrom(context);
    if (rawDocId != null && String(rawDocId).trim() !== '') payload.docId = rawDocId;
    if (flags.sessionId) payload.sessionId = flags.sessionId;
    const result = await contextFunction(context, 'askAgent')(payload);
    const answer = result?.answer || result?.error || '';
    const session = result?.sessionId != null ? `\n\n[sessionId: ${result.sessionId}]` : '';
    return { kind: 'db_ask_agent', text: `${answer}${session}` };
  }

  if (command === 'edit') {
    const { flags, positional } = parseFlags(args.slice(1));
    const friendly = await runFriendlyEdit(database, flags, positional, context);
    if (friendly) return friendly;
    const action = String(positional[0] || '').trim();
    if (!action) throw new Error('db edit requires database_write action');
    const payload = parseJsonObjectArgument(positional.slice(1).join(' '), {});
    const target = branchTarget(flags, context);
    const writePayload: Record<string, unknown> = {
      ...payload,
      action
    };
    if (target.docId) writePayload.docId = target.docId;
    const result = await database.run({ operation: 'write', payload: writePayload }, 'write');
    return { kind: 'db_edit', text: flags.json ? JSON.stringify(result, null, 2) : formatWriteResult(result) };
  }

  if (command === 'import-json') {
    // 智能导入校验 + 入库（projectneed 4-3-3）。
    const { flags, positional } = parseFlags(args.slice(1));
    const jsonPath = String(positional[0] || '').trim();
    const sourcePath = String(positional[1] || '').trim();
    if (!jsonPath || !sourcePath) throw new Error('db import-json requires <json_file> <source_file>');
    const result = await runImportJson({
      database,
      jsonPath,
      sourcePath,
      dryRun: flags.dryRun === true,
      embed: flags.embed === true
    });
    return { kind: 'db_import_json', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'export') {
    // 已停用（未启用，待重新设计）：原实现把 markdown 返回命令行而非导出为文件，渲染有地址当标题/混入
    // node_note 等问题，幂等与 import/export 对称设计未定。
    throw new Error('db export 已停用（未启用，待重新设计）：原实现把 markdown 返回命令行而非导出为文件，且渲染有地址当标题/混入 node_note 等功能错误，幂等与 import/export 对称设计未定。');
  }

  if (command === 'restore') {
    const { flags, positional } = parseFlags(args.slice(1));
    // CLI 语法 → ref/refKind 参数；模糊解析（唯一命中/歧义报错）在 L4 的 history.restore 里做。
    const spec = historyRefSpec(flags, positional);
    const payload: Record<string, unknown> = { action: 'history.restore', ref: spec.value ?? '' };
    if (spec.kind) payload.refKind = spec.kind;
    if (spec.docId) payload.docId = spec.docId;
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_restore', text: formatWriteResult(result, { label: 'restore' }) };
  }

  if (command === 'revert') {
    // 反向提交：撤销某次已落改动、生成反向变更、保留其后历史（区别于 restore 的 reset 式回滚）。
    // 反向提交由 L4 history.revert 执行。
    const { flags, positional } = parseFlags(args.slice(1));
    const commitId = String(positional[0] || '').trim();
    if (!commitId) throw new Error('db revert requires <commit_id>');
    const payload: Record<string, unknown> = { action: 'history.revert', commitId };
    if (positional[1]) payload.docId = await resolveDocRef(database, positional[1]);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_revert', text: flags.json ? JSON.stringify(result, null, 2) : formatWriteResult(result, { label: 'revert' }) };
  }

  if (command === 'gc') {
    // 对象库垃圾回收（mark-sweep，lazy/手动）：回收不被任何 commit 引用的历史对象。
    const { flags } = parseFlags(args.slice(1));
    const result = await database.run({ operation: 'write', payload: { action: 'objects.gc' } }, 'write');
    return { kind: 'db_gc', text: flags.json ? JSON.stringify(result, null, 2) : formatGcResult(result) };
  }

  if (command === 'certify') {
    // 节点级背书：标受控的唯一合法入口。
    // --node 只标本节点（默认整子树）；--trust 不受控 用于撤销背书。
    const { flags, positional } = parseFlags(args.slice(1));
    if (!positional[0]) throw new Error('db certify requires <doc_id>');
    const docId = await resolveDocRef(database, positional[0]);
    const address = String(positional[1] || '').trim();
    if (!address && flags.nodeId === undefined) throw new Error('db certify requires <address> 或 --node-id <uuid>');
    const payload: Record<string, unknown> = { action: 'history.certify', docId };
    if (flags.nodeId !== undefined) payload.nodeId = flags.nodeId;
    else payload.address = address;
    if (flags.node) payload.scope = 'node';
    if (flags.trust) payload.trust = String(flags.trust);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_certify', text: flags.json ? JSON.stringify(result, null, 2) : formatWriteResult(result, { label: 'certify' }) };
  }

  if (command === 'import') {
    const { flags, positional } = parseFlags(args.slice(1));
    const relativePath = String(positional[0] || '').trim();
    if (!relativePath) throw new Error('db import requires library_relative_path');
    const payload: Record<string, unknown> = { action: 'import.libraryDocument', relativePath };
    if (flags.mode) payload.mode = String(flags.mode);
    if (flags.embed) payload.embed = true;
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_import', text: flags.json ? JSON.stringify(result, null, 2) : formatImportResult(result, { relativePath, embed: flags.embed === true }) };
  }

  if (command === 'vectors') {
    const { flags, positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db vectors requires doc_id');
    const result = await database.run({ operation: 'write', payload: { action: 'vector.ensureDoc', docId } }, 'write');
    return { kind: 'db_vectors', text: flags.json ? JSON.stringify(result, null, 2) : formatVectorsResult(result, { docId }) };
  }

  if (command === 'delete') {
    const { flags, positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db delete requires doc_id');
    // import.deleteDocument 在 L4 内自回退：无宿主注入（独立 database-service）时走纯库 doc.delete。
    const result = await database.run({
      operation: 'write',
      payload: { action: 'import.deleteDocument', docId }
    }, 'write');
    return { kind: 'db_delete', text: flags.json ? JSON.stringify(result, null, 2) : formatDeleteResult(result, { docId }) };
  }

  if (command === 'relink') {
    const { positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    const sourcePath = String(positional[1] || '').trim();
    if (!docId || !sourcePath) throw new Error('db relink requires <doc_id> <source_path>');
    const result = await database.run({
      operation: 'write',
      payload: { action: 'doc.relink', docId, sourcePath }
    }, 'write');
    return { kind: 'db_relink', text: formatWriteResult(result, { label: 'relink' }) };
  }

  if (command === 'draft') {
    const { flags, positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db draft requires <docId>');
    const result = await database.run({
      operation: 'write',
      payload: { action: 'editBranch.begin', docId, includeDoc: false }
    }, 'write');
    return { kind: 'db_draft', text: flags.json ? JSON.stringify(result, null, 2) : formatWriteResult(result, { label: 'draft' }) };
  }

  if (command === 'discard') {
    const { flags, positional } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context, positional[0] || null);
    if (!target.docId) throw new Error('db discard requires <docId> or switch <docId>');
    if (!flags.yes) {
      return {
        kind: 'db_discard',
        text: `discard 预览：将丢弃草稿 ${branchTargetLabel(target)}（正文不变）；确认后带 --yes 重发执行`
      };
    }
    const payload: Record<string, unknown> = { action: 'editBranch.discard', includeDoc: false };
    applyBranchTarget(payload, target);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_discard', text: flags.json ? JSON.stringify(result, null, 2) : formatWriteResult(result, { label: 'discard' }) };
  }

  if (command === 'undo' || command === 'redo') {
    const { flags, positional } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context, positional[0] || null);
    if (!target.docId) throw new Error(`db ${command} requires <docId> or switch <docId>`);
    const payload: Record<string, unknown> = {
      action: command === 'undo' ? 'editBranch.undo' : 'editBranch.redo',
      includeDoc: false
    };
    applyBranchTarget(payload, target);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: command === 'undo' ? 'db_undo' : 'db_redo', text: flags.json ? JSON.stringify(result, null, 2) : formatWriteResult(result, { label: command }) };
  }

  if (command === 'switch') {
    const { positional } = parseFlags(args.slice(1));
    const docId = normalizeShellDocId(positional[0], null);
    if (!docId) throw new Error('db switch requires <docId>');
    updateSelectedBranch(context, { docId });
    return { kind: 'db_switch', text: `当前默认文档：${docId}` };
  }

  if (command === 'commit') {
    const { flags, positional } = parseFlags(args.slice(1));
    const target = branchTarget(flags, context, positional[0] || null);
    if (!target.docId) throw new Error('db commit requires <docId> or switch <docId>');
    const payload: Record<string, unknown> = { action: 'editBranch.save', includeDoc: false };
    applyBranchTarget(payload, target);
    if (flags.summary && flags.summary !== true) payload.summary = String(flags.summary);
    else if (flags.tag && flags.tag !== true) payload.summary = String(flags.tag);
    const result = await database.run({ operation: 'write', payload }, 'write');
    return { kind: 'db_commit', text: flags.json ? JSON.stringify(slimWriteResult(result), null, 2) : formatWriteResult(result, { label: 'commit' }) };
  }

  if (command === 'shell') {
    const { flags, positional } = parseLooseFlags(args.slice(1), ['cwd', 'timeout-ms']);
    const shellCommand = positional.join(' ').trim();
    if (!shellCommand) throw new Error('db shell requires command');
    const result = await contextFunction(context, 'agentTool')({
      name: 'bash',
      mode: contextAgentMode(context),
      docId: currentDocIdFrom(context) || undefined,
      args: {
        command: shellCommand,
        ...(flags.cwd ? { cwd: String(flags.cwd) } : {}),
        ...(flags.timeoutMs ? { timeoutMs: flags.timeoutMs } : {})
      }
    });
    return { kind: 'db_shell', text: JSON.stringify(result, null, 2) };
  }

  if (command === 'web') {
    const { flags, positional } = parseLooseFlags(args.slice(1), ['limit', 'char-limit']);
    const first = String(positional[0] || '').trim();
    const mode = first === 'search' || first === 'open'
      ? first
      : (/^https?:\/\//i.test(first) ? 'open' : 'search');
    const rest = positional.slice(first === 'search' || first === 'open' ? 1 : 0);
    if (mode !== 'search' && mode !== 'open') throw new Error('db web requires search or open');
    const value = rest.join(' ').trim();
    if (!value) throw new Error(`db web ${mode} requires ${mode === 'open' ? 'url' : 'query'}`);
    const toolArgs: Record<string, unknown> = mode === 'open'
      ? { mode, url: value }
      : { mode, query: value };
    if (flags.limit) toolArgs.limit = flags.limit;
    if (flags.charLimit) toolArgs.charLimit = flags.charLimit;
    const result = await contextFunction(context, 'agentTool')({
      name: 'web_search',
      mode: contextAgentMode(context),
      docId: currentDocIdFrom(context) || undefined,
      args: toolArgs
    });
    if (mode === 'search' && Array.isArray(result?.results)) {
      const items = result.results.map((row: { title?: string; url?: string; snippet?: string }, i: number) => [
        `${i + 1}. ${row.title || '(无标题)'}`,
        row.url ? `   ${row.url}` : null,
        row.snippet ? `   ${String(row.snippet).replace(/\s+/g, ' ').trim()}` : null
      ].filter(Boolean).join('\n'));
      const header = `web 检索「${result.query ?? value}」${result.results.length} 条结果：`;
      return { kind: 'db_web', text: items.length ? [header, ...items].join('\n') : `web 检索「${value}」无结果。` };
    }
    return { kind: 'db_web', text: JSON.stringify(result, null, 2) };
  }

  throw new Error(`Unknown db command: ${command}`);
}
