import { getUiMessages, readResolvedUiLocale } from '../../lang/ui.js';
import type { AgentImageAttachment } from '../../agent/agent-message.js';

const AGENT_REASONING_VALUES = new Set(['auto', 'low', 'medium', 'high', 'xhigh']);

export function agentReasoningOptions() {
  const text = getUiMessages().agent;
  return [
    { value: 'auto', label: text.auto },
    { value: 'low', label: text.low },
    { value: 'medium', label: text.medium },
    { value: 'high', label: text.high },
    { value: 'xhigh', label: text.xhigh }
  ] as const;
}

export function normalizeAgentReasoningEfforts(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，\s/]+/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of source) {
    const raw = String(item || '').trim().toLowerCase();
    const effort = raw === 'max' ? 'xhigh' : raw;
    if (effort && effort !== 'auto' && AGENT_REASONING_VALUES.has(effort) && !seen.has(effort)) {
      seen.add(effort);
      result.push(effort);
    }
  }
  return result;
}

export function formatAgentElapsed(value: unknown): string {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return getUiMessages().agent.elapsedSeconds(seconds);
  return getUiMessages().agent.elapsedMinutes(Math.floor(seconds / 60), seconds % 60);
}

export interface AgentToolEvent {
  id?: string;
  name?: string;
  status?: string;
  argsPreview?: string;
  resultPreview?: string;
  displayPreview?: string;
  images?: AgentImageAttachment[];
  error?: string;
  [extra: string]: unknown;
}

export interface AgentUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheMissTokens?: number;
  reasoningTokens?: number;
  contextLimit?: number;
  ratio?: number;
  [extra: string]: unknown;
}

export interface AgentMessageLike {
  id?: string;
  requestId?: string;
  sessionId?: number;
  role?: string;
  mode?: string;
  content?: string;
  attachments?: AgentImageAttachment[];
  answer?: string;
  status?: string;
  diffCount?: number;
  usage?: AgentUsage | null;
  toolEvents?: AgentToolEvent[];
  segments?: AgentSegment[];
  error?: boolean;
  imageRequestRejected?: boolean;
  visionFallback?: boolean;
  streaming?: boolean;
  createdAt?: number | string;
  [extra: string]: unknown;
}

export interface AgentSession {
  id: number;
  prompt?: string;
  mode?: string;
  created_at?: string;
  updated_at?: string;
  pending_diff_count?: number;
  result?: {
    messages?: AgentMessageLike[];
    answer?: string;
    error?: string;
    pendingDiffCount?: number;
    usage?: AgentUsage | null;
    toolEvents?: AgentToolEvent[];
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}

export interface AgentRequestMessage {
  role: 'user' | 'assistant';
  mode?: string;
  content: unknown;
  attachments?: AgentImageAttachment[];
  toolEvents?: Array<{ name?: string; status?: string; argsPreview?: string }>;
}

export function agentHistoryForRequest(messages: AgentMessageLike[] = []): AgentRequestMessage[] {
  return messages
    .map((message): AgentRequestMessage => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      mode: message.mode,
      // assistant 历史回传用纯文本 answer（= 模型真实最终输出）：逐轮稳定、能命中 prompt 前缀缓存；
      // 不用 segments（那是给界面的展示投影、含全过程，拼进历史会破坏缓存、也篡改对话历史）。
      content: message.role === 'assistant' ? message.answer : message.content,
      attachments: message.role === 'user' && Array.isArray(message.attachments)
        ? message.attachments
        : undefined,
      // 结构压缩的原料：历史压缩按 toolEvents 提取触达过的 doc/address/path 指针。
      // 只传压缩所需的最小子集，resultPreview 体积大且指针从 args 已可提取。
      toolEvents: message.role === 'assistant' && Array.isArray(message.toolEvents)
        ? message.toolEvents.map((event) => ({
            name: event?.name,
            status: event?.status,
            argsPreview: event?.argsPreview
          }))
        : undefined
    }))
    .filter((message) => String(message.content || '').trim() || (message.attachments?.length || 0) > 0);
}

export function agentSessionTitle(session: AgentSession | null | undefined): string {
  return clipText(session?.prompt || getUiMessages().agent.sessionTitle(String(session?.id || '')), 26);
}

export function agentSessionTime(session: AgentSession | null | undefined): string {
  const value = session?.updated_at || session?.created_at;
  const date = parseAgentSessionDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(readResolvedUiLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function parseAgentSessionDate(value: unknown): Date | null {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
    return new Date(`${text.replace(' ', 'T')}Z`);
  }
  return new Date(text);
}

export function agentMessagesFromSession(session: AgentSession | null | undefined): AgentMessageLike[] {
  if (!session) return [];
  const result = session.result || {};
  if (Array.isArray(result.messages) && result.messages.length > 0) {
    return result.messages.map((message, index): AgentMessageLike => {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      return {
        id: `session-${session.id}-${index}`,
        sessionId: session.id,
        role,
        mode: message.mode || session.mode,
        content: role === 'user' ? message.content || '' : undefined,
        attachments: role === 'user' && Array.isArray(message.attachments) ? message.attachments : undefined,
        answer: role === 'assistant' ? message.content || message.answer || '' : undefined,
        status: message.status || (role === 'assistant' ? getUiMessages().agent.saved : undefined),
        diffCount: Number(message.diffCount || 0),
        usage: message.usage || null,
        toolEvents: Array.isArray(message.toolEvents) ? message.toolEvents : [],
        segments: Array.isArray(message.segments) ? message.segments : [],
        error: Boolean(message.error),
        imageRequestRejected: Boolean(message.imageRequestRejected),
        visionFallback: message.kind === 'vision-fallback' || Boolean(message.visionFallback),
        streaming: false,
        createdAt: Date.parse(String(message.createdAt || '')) || Date.parse(session.updated_at || '') || Date.now()
      };
    });
  }
  const createdAt = Date.parse(session.created_at || '') || Date.now();
  const updatedAt = Date.parse(session.updated_at || '') || createdAt;
  return [
    {
      id: `session-${session.id}-user`,
      sessionId: session.id,
      role: 'user',
      mode: session.mode,
      content: session.prompt || '',
      createdAt
    },
    {
      id: `session-${session.id}-assistant`,
      sessionId: session.id,
      role: 'assistant',
      mode: session.mode,
      answer: result.answer || result.error || getUiMessages().agent.savedNoAnswer,
      status: result.error ? getUiMessages().notices.failed : getUiMessages().agent.saved,
      diffCount: Number(result.pendingDiffCount || session.pending_diff_count || 0),
      usage: result.usage || null,
      toolEvents: Array.isArray(result.toolEvents) ? result.toolEvents : [],
      error: Boolean(result.error),
      streaming: false,
      createdAt: updatedAt
    }
  ];
}

export interface AgentModelOption {
  key: string;
  providerId: string;
  apiId: string;
  model: string;
  protocol: string;
  reasoningEfforts: string[];
  label: string;
  title: string;
}

export interface ProviderApiConfig {
  id?: string;
  name?: string;
  model?: string;
  apiKey?: string;
  enabled?: boolean;
  protocol?: string;
  reasoningEfforts?: unknown;
  reasoning_efforts?: unknown;
  [extra: string]: unknown;
}

export interface ProviderConfig {
  id?: string;
  name?: string;
  apis?: ProviderApiConfig[];
}

export interface AgentSettingsLike {
  providers?: ProviderConfig[];
  activeProviderId?: string;
  activeApiId?: string;
  [extra: string]: unknown;
}

export function buildAgentModelOptions(settings: AgentSettingsLike = {}): AgentModelOption[] {
  const config = settings || {};
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const options: AgentModelOption[] = [];
  for (const provider of providers) {
    const apis = Array.isArray(provider.apis) ? provider.apis : [];
    for (const apiItem of apis) {
      if (apiItem.enabled === false) continue;
      if (!String(apiItem.apiKey || '').trim()) continue;
      const model = String(apiItem.model || '').trim();
      options.push({
        key: `${provider.id}:${apiItem.id}`,
        providerId: String(provider.id || ''),
        apiId: String(apiItem.id || ''),
        model,
        protocol: apiItem.protocol || 'openai-compatible',
        reasoningEfforts: normalizeAgentReasoningEfforts(apiItem.reasoningEfforts || apiItem.reasoning_efforts),
        label: model || apiItem.name || provider.name || getUiMessages().agent.defaultModel,
        title: `${provider.name || 'API'} / ${apiItem.name || model || getUiMessages().agent.model}`
      });
    }
  }
  return options;
}

export function defaultAgentModelKey(settings: AgentSettingsLike = {}, options: AgentModelOption[] = []): string {
  const config = settings || {};
  const key = `${config.activeProviderId || ''}:${config.activeApiId || ''}`;
  return options.some((option) => option.key === key) ? key : options[0]?.key || 'default';
}

export function compactAgentModelLabel(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return getUiMessages().agent.model;
  const lower = text.toLowerCase();
  const version = lower.match(/(?:^|[-_])(?:gpt-)?(\d+(?:\.\d+)?)(?:[-_]|$)/);
  if (version?.[1]) return version[1].slice(0, 4);
  const vName = lower.match(/(?:^|[-_])v(\d+)/);
  if (vName?.[1]) return `v${vName[1]}`.slice(0, 4);
  if (lower.includes('sonnet')) return 'Sn';
  if (lower.includes('opus')) return 'Op';
  if (lower.includes('flash')) return 'Fl';
  const cleaned = text.replace(/^(deepseek|claude|gemini|gpt|openai|glm|kimi|grok)[-_ ]*/i, '');
  return (cleaned || text).slice(0, 2);
}

export function agentReasoningLabel(value: unknown): string {
  return agentReasoningOptions().find((option) => option.value === value)?.label || getUiMessages().agent.auto;
}

export function agentReasoningShortLabel(value: unknown): string {
  if (value === 'xhigh') return getUiMessages().agent.xhighShort;
  if (value === 'auto') return getUiMessages().agent.autoShort;
  return agentReasoningLabel(value).slice(0, 1);
}

export function agentModeLabel(value: unknown): string {
  if (value === 'full') return getUiMessages().agent.full;
  return value === 'edit' ? getUiMessages().agent.edit : getUiMessages().agent.qa;
}

export function formatTokenCount(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0';
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}m`;
  if (number >= 1000) return `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k`;
  return String(Math.round(number));
}

export interface ContextUsageView {
  label: string;
  title: string;
  ratio: number;
  level: 'empty' | 'ok' | 'warn' | 'danger';
}

export function agentContextUsageView(usage: AgentUsage | null | undefined): ContextUsageView {
  if (!usage?.promptTokens) return { label: 'ctx --', title: getUiMessages().agent.waitingForUsage, ratio: 0, level: 'empty' };
  const prompt = formatTokenCount(usage.promptTokens);
  const contextLimit = Number(usage.contextLimit);
  const cached = usage.cachedTokens ? getUiMessages().agent.cachedTokens(formatTokenCount(usage.cachedTokens)) : '';
  const cacheMiss = usage.cacheMissTokens ? getUiMessages().agent.cacheMissTokens(formatTokenCount(usage.cacheMissTokens)) : '';
  const reasoning = usage.reasoningTokens ? getUiMessages().agent.reasoningTokens(formatTokenCount(usage.reasoningTokens)) : '';
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
    return {
      label: `ctx · ${prompt}/?`,
      title: getUiMessages().agent.contextWithoutLimit(usage.promptTokens, `${cached}${cacheMiss}${reasoning}`),
      ratio: 0,
      level: 'empty'
    };
  }
  const ratio = Math.max(0, Math.min(1, Number(usage.ratio) || 0));
  const percent = Math.round(ratio * 100);
  const limit = formatTokenCount(usage.contextLimit);
  const inferred = usage.contextLimitInferred === true ? getUiMessages().agent.inferredContext : '';
  return {
    label: `${percent}% · ${prompt}/${limit}`,
    title: getUiMessages().agent.contextWithLimit(usage.promptTokens, Number(usage.contextLimit), `${inferred}${cached}${cacheMiss}${reasoning}`),
    ratio,
    level: ratio > 0.8 ? 'danger' : ratio > 0.55 ? 'warn' : 'ok'
  };
}

// events / tool 接 unknown：上游 useAgentChat 的 message.toolEvents / event.tool 仍未收紧（前端债 #1+#2），边界 narrow 后再走 AgentToolEvent。
export function upsertAgentToolEvent(events: unknown = [], tool: unknown = {}): AgentToolEvent[] {
  const list: AgentToolEvent[] = Array.isArray(events) ? events as AgentToolEvent[] : [];
  const raw: AgentToolEvent = tool && typeof tool === 'object' ? tool as AgentToolEvent : {};
  const id = String(raw.id || `${raw.name || 'tool'}-${list.length}`);
  const next: AgentToolEvent = { ...raw, id };
  const index = list.findIndex((event) => event.id === id);
  if (index < 0) return [...list, next];
  return list.map((event, eventIndex) => (eventIndex === index ? { ...event, ...next } : event));
}

export type AgentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; toolId: string };

// 有序段（交错渲染）：delta 落到末尾 text 段（无则新建）；tool 事件按 toolId 占位、保持时间线顺序。
// tool 段只记 toolId，工具数据始终在 toolEvents 单一来源，渲染时按 id 回查。
export function appendTextToSegments(segments: AgentSegment[] | unknown, text: unknown): AgentSegment[] {
  if (!text) return Array.isArray(segments) ? segments as AgentSegment[] : [];
  const list = Array.isArray(segments) ? (segments as AgentSegment[]).slice() : [];
  const last = list[list.length - 1];
  if (last && last.kind === 'text') {
    list[list.length - 1] = { ...last, text: `${last.text}${text}` };
  } else {
    list.push({ kind: 'text', text: String(text) });
  }
  return list;
}

export function appendToolToSegments(segments: AgentSegment[] | unknown, toolId: unknown): AgentSegment[] {
  const id = String(toolId || '');
  const list = Array.isArray(segments) ? segments as AgentSegment[] : [];
  if (!id || list.some((segment) => segment.kind === 'tool' && segment.toolId === id)) return list;
  return [...list, { kind: 'tool', toolId: id }];
}

export function appendReasoningToSegments(segments: AgentSegment[] | unknown, text: unknown): AgentSegment[] {
  if (!text) return Array.isArray(segments) ? segments as AgentSegment[] : [];
  const list = Array.isArray(segments) ? (segments as AgentSegment[]).slice() : [];
  const last = list[list.length - 1];
  if (last && last.kind === 'reasoning') {
    list[list.length - 1] = { ...last, text: `${last.text}${text}` };
  } else {
    list.push({ kind: 'reasoning', text: String(text) });
  }
  return list;
}

export function agentToolStatusText(status: unknown): string {
  if (status === 'done') return getUiMessages().agent.completed;
  if (status === 'error') return getUiMessages().notices.failed;
  return getUiMessages().agent.running;
}

export function agentStatusText(status: unknown): string {
  const raw = String(status || '').trim();
  if (!raw) return '';
  const text = getUiMessages();
  if (raw === '完成' || raw === 'Done' || raw === 'Completed') return text.agent.completed;
  if (raw === '正在回复...' || raw === 'Replying...') return text.agent.replying;
  if (raw === '正在处理...' || raw === 'Processing...') return text.agent.processing;
  if (raw === '正在连接...' || raw === 'Connecting...') return text.notices.agentConnecting;
  if (raw === '正在取消...' || raw === 'Canceling...') return text.notices.canceling;
  return raw;
}

// 工具行单行摘要：取参数预览压成一行，剥掉最外层 JSON 花括号，类似 cc 的 Tool(args) 形态。
export function agentToolArgsSummary(tool: AgentToolEvent | null | undefined, limit: number = 60): string {
  let text = String(tool?.argsPreview || '').replace(/\s+/g, ' ').trim();
  if (text.startsWith('{') && text.endsWith('}')) text = text.slice(1, -1).trim();
  return clipText(text, limit);
}

export function agentToolNameText(name: unknown): string {
  const text = getUiMessages().agent;
  if (name === 'default_context') return text.defaultContext;
  if (name === 'search_manifest') return text.searchManifest;
  if (name === 'fetch_content') return text.readContent;
  if (name === 'propose_changes') return text.proposeChanges;
  if (name === 'propose_node_patch') return text.proposeNodePatch;
  if (name === 'propose_ref_delete') return text.proposeRefDelete;
  if (name === 'propose_source_bind_path') return text.proposeSourceBind;
  if (name === 'workspace_file') return text.workspaceFile;
  if (name === 'admin_override') return text.adminOverride;
  if (name === 'database_write') return text.databaseWrite;
  if (name === 'web_search') return text.webSearch;
  return String(name || '') || text.toolCall;
}

// --- db 契约显示：bash {"command":"db ..."} → 语义化名称 + 简短参数摘要 ---
// 动词与后端 db-shell.ts 对齐；任何一步解析失败都回退裸文本，绝不影响渲染。

// 带值的 --flag（显示摘要时需要吞掉下一个词）；未列出的视为布尔开关。
const DB_VALUE_FLAGS = new Set([
  'range', 'folder', 'exclude-folder', 'scope', 'from', 'to', 'node-id', 'limit', 'min-score',
  'sections', 'summary', 'tag', 'doc-id', 'session-id', 'params', 'mode', 'cwd', 'timeout-ms',
  'char-limit', 'detail', 'match-mode', 'trust', 'since', 'until', 'labels', 'at', 'start',
  'before', 'spans-limit', 'depth'
]);

interface AgentShellArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

// 与后端 splitCommandLine 同语义：按空白切分、单双引号成对去壳。
export function splitAgentShellWords(text: unknown): string[] {
  const source = String(text || '');
  const words: string[] = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
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
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function parseAgentShellFlags(args: string[]): AgentShellArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = args[index + 1];
    if (DB_VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }
  return { positional, flags };
}

// 从 bash 工具的 argsPreview（jsonPreview 截断过也可能）里尽量取出完整 command。
export function agentBashCommandText(tool: AgentToolEvent | null | undefined): string {
  const preview = String(tool?.argsPreview || '').trim();
  if (!preview) return '';
  try {
    const parsed = JSON.parse(preview) as { command?: unknown };
    return String(parsed?.command || '').trim();
  } catch {
    // 预览被截断时 JSON 不闭合：正则捞出 "command":"... 的可见部分。
    const match = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(preview);
    if (!match) return '';
    try {
      return String(JSON.parse(`"${match[1]}"`));
    } catch {
      return match[1];
    }
  }
}

export interface AgentToolDisplay {
  name: string;
  args: string;
}

// bash 工具调用的语义化显示：db 动词 → 中文动作名 + 关键参数；非 db 命令 → 运行命令。
export function agentBashToolDisplay(tool: AgentToolEvent | null | undefined, limit: number = 42): AgentToolDisplay | null {
  const text = getUiMessages().agent;
  const command = agentBashCommandText(tool);
  if (!command) return null;
  const argv = splitAgentShellWords(command);
  if (argv[0] !== 'db') return { name: text.runCommand, args: clipText(command, limit) };
  const verb = argv[1] || 'help';
  const { positional, flags } = parseAgentShellFlags(argv.slice(2));
  const terms = positional.join(' ').trim();
  const flagText = (key: string): string => (flags[key] === true ? '' : String(flags[key] || ''));
  switch (verb) {
    case 'help':
    case '--help':
    case '-h':
      return { name: text.dbHelp, args: '' };
    case 'find': {
      const name = flags.semantic
        ? text.semanticSearch
        : flags.entity
          ? (flags.expand ? text.entityExpandedSearch : text.entitySearch)
          : text.keywordSearch;
      const scope = flags['all-docs'] ? `${text.wholeLibrary} · ` : flags.folder ? `${text.folder(flagText('folder'))} · ` : '';
      return { name, args: clipText(`${scope}${terms}`, limit) };
    }
    case 'keyword':
      return { name: text.keywordSearch, args: clipText(terms, limit) };
    case 'query':
      return { name: text.semanticSearch, args: clipText(terms, limit) };
    case 'index':
      return { name: text.directoryIndex, args: flags.folder ? text.folder(flagText('folder')) : flags.summary ? text.withSummary : '' };
    case 'tree':
      return { name: text.documentStructure, args: clipText(terms, limit) };
    case 'read': {
      const range = flagText('range');
      const name = range === 'node' ? text.readNode : range === 'siblings' ? text.readSiblings : text.readContent;
      return { name, args: clipText(terms, limit) };
    }
    case 'inspect':
      return { name: text.nodeDetails, args: clipText(terms, limit) };
    case 'article':
      return { name: text.readSource, args: clipText(terms, limit) };
    case 'log':
      return { name: text.changeHistory, args: clipText(terms, limit) };
    case 'diff':
      return { name: text.compareDiff, args: clipText(terms, limit) };
    case 'sql':
      return { name: text.sqlQuery, args: clipText(terms, limit) };
    case 'screenshot':
      return { name: text.viewImage, args: '' };
    case 'ask_agent':
      return { name: text.askSubagent, args: clipText(terms, limit) };
    case 'edit':
      return { name: text.editData, args: clipText(terms, limit) };
    case 'import':
      return { name: text.importDocument, args: clipText(terms, limit) };
    case 'import-json':
      return { name: text.smartImport, args: clipText(terms, limit) };
    case 'export':
      return { name: text.exportDocument, args: clipText(terms, limit) };
    case 'restore':
      return { name: text.restoreHistory, args: clipText(terms, limit) };
    case 'revert':
      return { name: text.revertCommit, args: clipText(terms, limit) };
    case 'gc':
      return { name: text.collectObjects, args: '' };
    case 'certify':
      return { name: text.certifyNode, args: clipText(terms, limit) };
    case 'vectors':
      return { name: text.rebuildVectors, args: clipText(terms, limit) };
    case 'delete':
      return { name: text.deleteDocument, args: clipText(terms, limit) };
    case 'relink':
      return { name: text.relinkSource, args: clipText(terms, limit) };
    case 'draft':
      return { name: text.createDraft, args: clipText(terms, limit) };
    case 'discard':
      return { name: text.discardDraft, args: '' };
    case 'undo':
      return { name: text.undo, args: '' };
    case 'redo':
      return { name: text.redo, args: '' };
    case 'switch':
      return { name: text.switchDocument, args: clipText(terms, limit) };
    case 'commit':
      return { name: text.commitDraft, args: clipText(flagText('summary') || flagText('tag'), limit) };
    case 'shell':
      return { name: text.runCommand, args: clipText(terms, limit) };
    case 'web': {
      let name = text.webSearch;
      let rest = positional;
      if (rest[0] === 'search') rest = rest.slice(1);
      else if (rest[0] === 'open') {
        name = text.openWebpage;
        rest = rest.slice(1);
      } else if (/^https?:\/\//i.test(rest[0] || '')) name = text.openWebpage;
      return { name, args: clipText(rest.join(' ').trim(), limit) };
    }
    default:
      return { name: `db ${verb}`, args: clipText(terms, limit) };
  }
}

export function clipText(value: unknown, limit: number = 180): string {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// agentDiffs 复用文档唯一草稿列表（一草稿 = 一组提议）。
// 下面把分支的 diff.entries 解析成卡片摘要；明细对照走统一 diff 视图。
export interface AgentBranch {
  id: number;
  base_doc_id: string;
  base_title?: string;
  diff?: string | { entries?: AgentBranchEntry[] };
  [extra: string]: unknown;
}

export interface AgentBranchEntry {
  kind?: string;
  createdAt?: string;
  status?: string;
  address?: string;
  parent_ref?: string;
  target_ref?: string;
  node_ref?: string;
  [extra: string]: unknown;
}

export interface AgentBranchEntrySummary {
  key: string;
  label: string;
  address: string;
}

export function agentBranchEntries(branch: AgentBranch | null | undefined): AgentBranchEntrySummary[] {
  let diff: { entries?: AgentBranchEntry[] } = {};
  try {
    diff = typeof branch?.diff === 'string' ? JSON.parse(branch.diff || '{}') : (branch?.diff || {});
  } catch {
    diff = {};
  }
  const entries = Array.isArray(diff.entries) ? diff.entries : [];
  return entries
    .filter((entry): entry is AgentBranchEntry => Boolean(entry) && entry.status !== 'undone')
    .map((entry, index) => ({
      key: entry.createdAt || `${branch?.id ?? 'b'}:${index}`,
      label: ({
        'node.update': getUiMessages().agent.updateNode,
        'ref.addNodeToNode': getUiMessages().agent.addReference,
        'ref.delete': getUiMessages().agent.deleteReference
      } as Record<string, string>)[String(entry.kind || '')] || entry.kind || getUiMessages().agent.change,
      address: entry.address || entry.parent_ref || entry.target_ref || entry.node_ref || ''
    }));
}

export function agentBranchDocLabel(branch: AgentBranch | null | undefined, docs: Array<{ id?: unknown; title?: string }> = []): string {
  if (branch?.base_title) return branch.base_title;
  const match = Array.isArray(docs)
    ? docs.find((doc) => String(doc?.id) === String(branch?.base_doc_id))
    : null;
  return match?.title || String(branch?.base_doc_id || getUiMessages().agent.unknownDocument);
}
