// LLM 会话协议适配（agent-runtime 拆分，§6-7）：工具调用增量拼装、OpenAI↔Anthropic
// 消息与工具定义互转、usage 归一。纯转换，不发请求（HTTP 在 chat-client）。
import { sanitize, clipText } from './agent-shared.js';
import type { Json, AnyRecord } from './agent-shared.js';
import { inferContextLimitFromModel } from './model-context-table.js';
import { agentContentText } from '../../agent/agent-message.js';
import type { AgentContentBlock } from '../../agent/agent-message.js';

export function parseToolArgs(raw: unknown): AnyRecord {
  try {
    return raw ? JSON.parse(String(raw)) : {};
  } catch {
    return {};
  }
}

export function jsonPreview(value: unknown, limit = 900): string {
  try {
    return clipText(JSON.stringify(sanitize(value), null, 2), limit);
  } catch {
    return clipText(String(value || ''), limit);
  }
}

export interface ToolResult {
  stdout?: unknown;
  stderr?: unknown;
  format?: string;
  text?: string;
  ok?: boolean;
  recoverable?: boolean;
  rejected?: boolean;
  reason?: string;
  error?: unknown;
  exitCode?: number;
  returned?: unknown;
  rowCount?: unknown;
  rows?: unknown[];
  nodes?: unknown[];
  docs?: unknown[];
  total?: unknown;
  truncated?: unknown;
  changedDocIds?: unknown[];
  [extra: string]: unknown;
}

export function toolDisplayPreview(name: string, result: ToolResult = {}, limit = 5000): string | null {
  if (name === 'bash') {
    const stdout = result.stdout == null ? '' : String(result.stdout);
    const stderr = result.stderr == null ? '' : String(result.stderr);
    return clipText([stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '').trimEnd(), limit);
  }
  if (result?.format === 'ascii_tree' && typeof result.text === 'string') {
    return clipText(result.text.trimEnd(), limit);
  }
  return null;
}

export interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export function appendAgentToolCallDelta(toolCalls: ToolCall[], delta: AnyRecord & { index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } } = {}): void {
  const index = Number.isFinite(Number(delta.index)) ? Number(delta.index) : 0;
  const current: ToolCall = toolCalls[index] || { id: '', type: 'function', function: { name: '', arguments: '' } };
  if (delta.id) current.id = String(delta.id);
  if (delta.type) current.type = String(delta.type);
  if (!current.function) current.function = { name: '', arguments: '' };
  if (delta.function?.name) current.function.name = `${current.function.name || ''}${String(delta.function.name)}`;
  if (delta.function?.arguments) current.function.arguments = `${current.function.arguments || ''}${String(delta.function.arguments)}`;
  toolCalls[index] = current;
}

export interface AgentMessage {
  role: string;
  content?: string;
  reasoning_content?: string;
  anthropic_thinking?: AnthropicThinkingBlock[];
  tool_calls?: ToolCall[];
  usage?: NormalizedAgentUsage | null;
  [extra: string]: unknown;
}

export function appendReasoningContent(message: AgentMessage, value: unknown): void {
  if (!value) return;
  message.reasoning_content = `${message.reasoning_content || ''}${String(value)}`;
}

export function agentAssistantMessageForHistory(message: AgentMessage, toolCalls: ToolCall[]): AnyRecord {
  return {
    role: 'assistant',
    content: message.content || '',
    reasoning_content: message.reasoning_content || undefined,
    anthropic_thinking: message.anthropic_thinking?.length ? message.anthropic_thinking : undefined,
    tool_calls: toolCalls
  };
}

export interface AnthropicTextBlock { type: 'text'; text: string }
export interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}
export interface AnthropicThinkingBlock { type: 'thinking'; thinking: string; signature: string }
export interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: AnyRecord }
// tool_result 的 content 可为文本或 blocks（Anthropic 视觉协议允许 tool_result 携带 image block）。
export interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string | Array<AnthropicTextBlock | AnthropicImageBlock> }
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicThinkingBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

export function anthropicTextBlock(text: unknown): AnthropicTextBlock {
  return { type: 'text', text: String(text || '') };
}

export function parseToolInput(value: unknown): AnyRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as AnyRecord;
  try {
    return value ? JSON.parse(String(value)) : {};
  } catch {
    return {};
  }
}

export function mergeAnthropicMessage(messages: AnthropicMessage[], message: AnthropicMessage): void {
  if (!message?.role || !Array.isArray(message.content) || message.content.length === 0) return;
  const last = messages[messages.length - 1];
  if (last?.role === message.role) {
    last.content.push(...message.content);
    return;
  }
  messages.push(message);
}

export interface OpenAiMessage {
  role?: string;
  content?: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  [extra: string]: unknown;
}

export function anthropicMessages(openaiMessages: OpenAiMessage[] = []): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  for (const item of openaiMessages) {
    const role = item?.role;
    const content = agentContentText(item?.content);
    if (role === 'system') {
      if (content) system.push(content);
      continue;
    }
    if (role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      for (const block of Array.isArray(item.anthropic_thinking) ? item.anthropic_thinking : []) {
        const thinking = String(block?.thinking || '');
        if (!thinking) continue;
        blocks.push({
          type: 'thinking',
          thinking,
          signature: String(block?.signature || '')
        });
      }
      if (!blocks.some((block) => block.type === 'thinking') && item.reasoning_content) {
        blocks.push({
          type: 'thinking',
          thinking: String(item.reasoning_content),
          signature: ''
        });
      }
      if (content) blocks.push(anthropicTextBlock(content));
      for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
        const name = call?.function?.name || '';
        if (!name) continue;
        blocks.push({
          type: 'tool_use',
          id: call.id || `tool-${blocks.length}`,
          name,
          input: parseToolInput(call.function?.arguments)
        });
      }
      mergeAnthropicMessage(messages, { role: 'assistant', content: blocks });
      continue;
    }
    if (role === 'tool') {
      // 工具结果支持携带图片（db screenshot 等视觉工具回执）：content 为数组时转成
      // tool_result 的 content blocks（text + image），否则沿用纯文本字符串。
      let toolContent: AnthropicToolResultBlock['content'] = content;
      if (Array.isArray(item?.content)) {
        const blocks: Array<AnthropicTextBlock | AnthropicImageBlock> = [];
        for (const raw of item.content as AgentContentBlock[]) {
          if (raw?.type === 'text' && raw.text) {
            blocks.push(anthropicTextBlock(raw.text));
          } else if (raw?.type === 'image' && raw.image?.mediaType && raw.image?.data) {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: raw.image.mediaType,
                data: raw.image.data
              }
            });
          }
        }
        toolContent = blocks;
      }
      mergeAnthropicMessage(messages, {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: item.tool_call_id || '',
          content: toolContent
        }]
      });
      continue;
    }
    const blocks: AnthropicContentBlock[] = [];
    if (Array.isArray(item?.content)) {
      for (const raw of item.content as AgentContentBlock[]) {
        if (raw?.type === 'text' && raw.text) {
          blocks.push(anthropicTextBlock(raw.text));
        } else if (raw?.type === 'image' && raw.image?.mediaType && raw.image?.data) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: raw.image.mediaType,
              data: raw.image.data
            }
          });
        }
      }
    } else if (content) {
      blocks.push(anthropicTextBlock(content));
    }
    mergeAnthropicMessage(messages, { role: 'user', content: blocks });
  }
  return { system: system.join('\n\n'), messages };
}

export function openAiMessagesForRequest(messages: OpenAiMessage[] = []): OpenAiMessage[] {
  return messages.map((item) => {
    if (!Array.isArray(item?.content)) return item;
    const content = (item.content as AgentContentBlock[])
      .map((block): AnyRecord | null => {
        if (block?.type === 'text') return { type: 'text', text: String(block.text || '') };
        if (block?.type === 'image' && block.image?.mediaType && block.image?.data) {
          return {
            type: 'image_url',
            image_url: {
              url: `data:${block.image.mediaType};base64,${block.image.data}`
            }
          };
        }
        return null;
      })
      .filter((block): block is AnyRecord => Boolean(block));
    return { ...item, content };
  });
}

export interface OpenAiToolDef {
  type?: string;
  function?: { name?: string; description?: string; parameters?: Json };
}

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Json;
}

export function anthropicTools(openaiTools: OpenAiToolDef[] = []): AnthropicToolDef[] {
  return openaiTools
    .map((tool): AnthropicToolDef | null => {
      const fn = tool?.function || {};
      if (!fn.name) return null;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} }
      };
    })
    .filter((tool): tool is AnthropicToolDef => Boolean(tool));
}

export interface ApiConfig {
  apiKey?: string;
  baseUrl?: string;
  fullUrl?: boolean;
  model?: string;
  providerName?: string;
  contextLimit?: number;
  contextWindowTokens?: number;
  contextWindow?: number;
  maxContextTokens?: number;
  modelCard?: { contextLimit?: number; contextWindowTokens?: number };
  metadata?: { contextLimit?: number };
  reasoningEfforts?: string[];
  reasoningEffortMap?: Record<string, string>;
  protocol?: string;
  outputConfig?: AnyRecord;
  anthropicVersion?: string;
  [extra: string]: unknown;
}

export function agentMessageFromAnthropic(json: AnyRecord = {}, api: ApiConfig = {}): AgentMessage {
  const contentBlocks = Array.isArray(json.content) ? json.content as Array<AnyRecord> : [];
  const text = contentBlocks
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || ''))
    .join('');
  const thinkingBlocks: AnthropicThinkingBlock[] = contentBlocks
    .filter((block) => block?.type === 'thinking')
    .map((block): AnthropicThinkingBlock => ({
      type: 'thinking',
      thinking: String(block.thinking || block.text || ''),
      signature: String(block.signature || '')
    }))
    .filter((block) => block.thinking);
  const reasoning = thinkingBlocks.map((block) => block.thinking).join('');
  const toolCalls = contentBlocks
    .filter((block) => block?.type === 'tool_use' && block.name)
    .map((block): ToolCall => ({
      id: String(block.id || ''),
      type: 'function',
      function: {
        name: String(block.name),
        arguments: JSON.stringify(block.input || {})
      }
    }));
  return {
    role: 'assistant',
    content: text,
    reasoning_content: reasoning || undefined,
    anthropic_thinking: thinkingBlocks.length ? thinkingBlocks : undefined,
    tool_calls: toolCalls,
    usage: normalizeAgentUsage(json.usage, api)
  };
}

export function positiveTokenLimit(...values: unknown[]): number {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.round(number);
  }
  return 0;
}

export interface RawUsage {
  prompt_cache_hit_tokens?: unknown;
  prompt_cache_miss_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  input_token_details?: { cache_read?: unknown };
  prompt_tokens_details?: { cached_tokens?: unknown };
  prompt_tokens?: unknown;
  input_tokens?: unknown;
  usage?: { prompt_tokens?: unknown };
  completion_tokens?: unknown;
  output_tokens?: unknown;
  completion_tokens_details?: { reasoning_tokens?: unknown };
  output_token_details?: { reasoning_tokens?: unknown };
  total_tokens?: unknown;
  contextLimit?: unknown;
  context_limit?: unknown;
  context_window?: unknown;
  model_context_limit?: unknown;
  [extra: string]: unknown;
}

export function configuredContextLimit(api: ApiConfig = {}, rawUsage: RawUsage = {}): number {
  return positiveTokenLimit(
    api.contextLimit,
    api.contextWindowTokens,
    api.contextWindow,
    api.maxContextTokens,
    api.modelCard?.contextLimit,
    api.modelCard?.contextWindowTokens,
    api.metadata?.contextLimit,
    rawUsage?.contextLimit,
    rawUsage?.context_limit,
    rawUsage?.context_window,
    rawUsage?.model_context_limit
  );
}

export function usageNumber(...values: unknown[]): number {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
}

export function optionalUsageNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

export interface NormalizedAgentUsage {
  model: string;
  providerName: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  contextLimit: number;
  contextLimitInferred?: boolean;
  ratio: number;
  raw: unknown;
}

export function normalizeAgentUsage(rawUsage: RawUsage | unknown, api: ApiConfig = {}): NormalizedAgentUsage {
  const usage: RawUsage = (rawUsage && typeof rawUsage === 'object' ? rawUsage : {}) as RawUsage;
  const cacheCreationTokens = usageNumber(usage?.cache_creation_input_tokens);
  const cachedTokens = usageNumber(
    usage?.prompt_cache_hit_tokens,
    usage?.cache_read_input_tokens,
    usage?.input_token_details?.cache_read,
    usage?.prompt_tokens_details?.cached_tokens
  );
  const cacheMissTokens = optionalUsageNumber(usage?.prompt_cache_miss_tokens);
  const directPromptTokens = optionalUsageNumber(
    usage?.prompt_tokens,
    usage?.usage?.prompt_tokens
  );
  const anthropicInputTokens = optionalUsageNumber(usage?.input_tokens);
  const promptTokens = directPromptTokens ?? (
    anthropicInputTokens !== null
      ? anthropicInputTokens + cacheCreationTokens + cachedTokens
      : (cacheMissTokens !== null || cachedTokens > 0 ? cachedTokens + usageNumber(cacheMissTokens) : 0)
  );
  const resolvedCacheMissTokens = cacheMissTokens ?? Math.max(0, promptTokens - cachedTokens);
  const completionTokens = usageNumber(usage?.completion_tokens, usage?.output_tokens);
  const reasoningTokens = usageNumber(
    usage?.completion_tokens_details?.reasoning_tokens,
    usage?.output_token_details?.reasoning_tokens
  );
  const totalTokens = usageNumber(usage?.total_tokens, promptTokens + completionTokens);
  // 上下文窗口：显式配置（config / usage 回传）优先；都没有时按模型名查内置对照表兜底，
  // 并标记 contextLimitInferred，界面据实提示「按模型自动识别、可在设置中覆盖」。
  const explicitContextLimit = configuredContextLimit(api, usage);
  const inferredContextLimit = explicitContextLimit > 0 ? 0 : inferContextLimitFromModel(api.model);
  const contextLimit = explicitContextLimit > 0 ? explicitContextLimit : inferredContextLimit;
  return {
    model: api.model || '',
    providerName: api.providerName || '',
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheMissTokens: resolvedCacheMissTokens,
    reasoningTokens,
    contextLimit,
    contextLimitInferred: explicitContextLimit <= 0 && inferredContextLimit > 0,
    ratio: contextLimit > 0 ? Math.min(1, promptTokens / contextLimit) : 0,
    raw: rawUsage
  };
}
