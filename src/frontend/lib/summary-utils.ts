import {
  normalizeApiProtocol,
  normalizeReasoningEffortMap,
  normalizeReasoningEfforts
} from '../../agent/llm-api-config.js';
import { getUiMessages } from '../../lang/ui.js';

export interface SummaryStrategy {
  id: string;
  name: string;
  skipBelowChars: number;
  minWords: number;
  maxWords: number;
  ratioPercent: number;
  [extra: string]: unknown;
}

export const DEFAULT_SUMMARY_STRATEGIES: SummaryStrategy[] = [
  { id: 'article-default', name: '全文默认', skipBelowChars: 100, minWords: 250, maxWords: 1200, ratioPercent: 10 },
  { id: 'node-default', name: '节点/子树默认', skipBelowChars: 100, minWords: 80, maxWords: 300, ratioPercent: 20 }
];

export const DEFAULT_SUMMARY_CONCURRENCY = 10;

export interface AgentToolSettings {
  searchResultLimit: number;
  searchBlockMaxChars: number;
  fetchContentMaxChars: number;
  webSearchResultLimit: number;
  webOpenCharLimit: number;
}

export const DEFAULT_AGENT_TOOL_SETTINGS: AgentToolSettings = {
  searchResultLimit: 20,
  searchBlockMaxChars: 20000,
  fetchContentMaxChars: 20000,
  webSearchResultLimit: 5,
  webOpenCharLimit: 12000
};

function hasOwn(value: unknown, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

export interface LlmApiPreset {
  name?: string;
  baseUrl?: string;
  model?: string;
  protocol?: string;
  reasoningEfforts?: string[];
  [extra: string]: unknown;
}

export interface LlmProviderPreset {
  id: string;
  name: string;
  note?: string;
  websiteUrl?: string;
  api?: LlmApiPreset;
  apis?: LlmApiPreset[];
}

export function llmProviderPresets(): LlmProviderPreset[] {
  const text = getUiMessages().settings.llm.preset;
  return [
  {
    id: 'openai',
    name: text.openaiOfficial,
    note: text.officialChatCompletions,
    websiteUrl: 'https://platform.openai.com/docs/api-reference/chat/create',
    api: {
      name: 'OpenAI GPT-5.2',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      protocol: 'openai-compatible',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
    }
  },
  {
    id: 'claude',
    name: text.claudeOfficial,
    note: 'Anthropic Messages API',
    websiteUrl: 'https://docs.anthropic.com/en/api/openai-sdk',
    apis: [
      {
        name: 'Claude Opus 4.1',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-opus-4-1-20250805',
        protocol: 'anthropic-compatible',
        reasoningEfforts: []
      },
      {
        name: 'Claude Sonnet 4',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-20250514',
        protocol: 'anthropic-compatible',
        reasoningEfforts: []
      }
    ]
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    note: text.minimaxCompatible,
    websiteUrl: 'https://platform.minimaxi.com/docs/api-reference/text-chat-openai',
    apis: [
      {
        name: text.minimaxChina,
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M2.7'
      },
      {
        name: 'MiniMax Global',
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M2.7'
      }
    ]
  },
  {
    id: 'glm',
    name: text.zhipuGlm,
    note: text.zhipuCompatible,
    websiteUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    api: {
      name: 'GLM-5',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5'
    }
  },
  {
    id: 'kimi',
    name: 'Kimi',
    note: text.kimiCompatible,
    websiteUrl: 'https://platform.kimi.ai/docs/api/overview',
    api: {
      name: 'Kimi K2.6',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'kimi-k2.6'
    }
  },
  {
    id: 'qwen',
    name: text.qwen,
    note: text.qwenCompatible,
    websiteUrl: 'https://platform.qianwenai.com/docs/token-plan/quickstart',
    apis: [
      {
        name: 'Qwen3.8 Max Preview',
        note: text.tokenPlanOnly,
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
        model: 'qwen3.8-max-preview',
        protocol: 'anthropic-compatible',
        maxOutputTokens: 65536,
        reasoningEfforts: ['low', 'medium', 'xhigh']
      },
      {
        name: 'Qwen3.7 Plus',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
        model: 'qwen3.7-plus',
        protocol: 'anthropic-compatible',
        maxOutputTokens: 65536
      },
      {
        name: 'Qwen3.6 Flash',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
        model: 'qwen3.6-flash',
        protocol: 'anthropic-compatible',
        maxOutputTokens: 65536
      }
    ]
  },
  {
    id: 'nvidia-developer',
    name: 'NVIDIA Developer',
    note: 'NVIDIA hosted NIM OpenAI-compatible endpoint',
    websiteUrl: 'https://build.nvidia.com/models',
    apis: [
      {
        name: 'Inkling',
        note: 'Thinking Machines via NVIDIA NIM',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'thinkingmachines/inkling',
        protocol: 'openai-compatible'
      },
      {
        name: 'MiniMax M3',
        note: 'MiniMaxAI via NVIDIA NIM',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'minimaxai/minimax-m3',
        protocol: 'openai-compatible',
        contextLimit: 1000000
      },
      {
        name: 'GLM-5.2',
        note: 'Z.ai via NVIDIA NIM',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'z-ai/glm-5.2',
        protocol: 'openai-compatible',
        contextLimit: 1000000
      }
    ]
  },
  {
    id: 'gemini',
    name: 'Gemini',
    note: 'Google Gemini OpenAI compatibility',
    websiteUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    api: {
      name: 'Gemini 3 Flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3-flash-preview'
    }
  },
  {
    id: 'grok',
    name: 'Grok / xAI',
    note: 'xAI OpenAI-compatible endpoint',
    websiteUrl: 'https://docs.x.ai/overview',
    api: {
      name: 'Grok 4.20 Reasoning',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.20-reasoning'
    }
  }
  ];
}

export function newSettingsId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function clampSummaryNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function optionalSummaryInteger(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return 0;
  return Math.round(Math.min(max, number));
}

export function optionalSummaryRatio(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return 0;
  return Math.round(clampSummaryNumber(number, 0.1, 90, fallback) * 10) / 10;
}

export function normalizeSummaryConcurrency(value: unknown, fallback: number = DEFAULT_SUMMARY_CONCURRENCY): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.round(number));
}

export interface SummaryStrategyRaw {
  id?: unknown;
  name?: unknown;
  skipBelowChars?: unknown;
  minWords?: unknown;
  maxWords?: unknown;
  ratioPercent?: unknown;
  [extra: string]: unknown;
}

export function normalizeSummaryStrategy(strategy: unknown = {}, index: number = 0): SummaryStrategy {
  const raw: SummaryStrategyRaw = strategy && typeof strategy === 'object' ? strategy as SummaryStrategyRaw : {};
  const fallback = DEFAULT_SUMMARY_STRATEGIES[index] || DEFAULT_SUMMARY_STRATEGIES[1];
  const skipBelowChars = optionalSummaryInteger(raw.skipBelowChars, fallback.skipBelowChars, 1000000);
  const minWords = optionalSummaryInteger(raw.minWords, fallback.minWords, 100000);
  let maxWords = optionalSummaryInteger(raw.maxWords, fallback.maxWords, 100000);
  if (maxWords > 0 && minWords > 0 && maxWords < minWords) maxWords = minWords;
  const ratioPercent = optionalSummaryRatio(raw.ratioPercent, fallback.ratioPercent);
  return {
    id: String(raw.id || fallback.id || newSettingsId('summary')),
    name: String(Object.prototype.hasOwnProperty.call(raw, 'name') ? raw.name : fallback.name).trim() || fallback.name,
    skipBelowChars,
    minWords,
    maxWords,
    ratioPercent
  };
}

export interface AgentToolSettingsRaw {
  searchResultLimit?: unknown;
  searchBlockMaxChars?: unknown;
  fetchContentMaxChars?: unknown;
  webSearchResultLimit?: unknown;
  webOpenCharLimit?: unknown;
  [extra: string]: unknown;
}

export function normalizeAgentToolSettings(settings: AgentToolSettingsRaw = {}): AgentToolSettings {
  const number = (key: keyof AgentToolSettings, min: number, max: number): number =>
    clampSummaryNumber(settings[key], min, max, DEFAULT_AGENT_TOOL_SETTINGS[key]);
  return {
    searchResultLimit: number('searchResultLimit', 1, 80),
    searchBlockMaxChars: number('searchBlockMaxChars', 200, 50000),
    fetchContentMaxChars: number('fetchContentMaxChars', 200, 100000),
    webSearchResultLimit: number('webSearchResultLimit', 1, 10),
    webOpenCharLimit: number('webOpenCharLimit', 1000, 50000)
  };
}

export interface SummaryStrategySettingsRaw {
  summaryStrategies?: unknown;
  activeArticleSummaryStrategyId?: unknown;
  activeNodeSummaryStrategyId?: unknown;
  summaryConcurrency?: unknown;
  [extra: string]: unknown;
}

export interface SummaryStrategySettings {
  summaryStrategies: SummaryStrategy[];
  activeArticleSummaryStrategyId: string;
  activeNodeSummaryStrategyId: string;
  summaryConcurrency: number;
  [extra: string]: unknown;
}

export function normalizeSummaryStrategySettings(settings: SummaryStrategySettingsRaw = {}): SummaryStrategySettings {
  const strategies = (Array.isArray(settings.summaryStrategies) ? settings.summaryStrategies as SummaryStrategyRaw[] : [])
    .map((strategy, index) => normalizeSummaryStrategy(strategy, index));
  const summaryStrategies = strategies.length
    ? strategies
    : DEFAULT_SUMMARY_STRATEGIES.map((strategy, index) => normalizeSummaryStrategy(strategy, index));
  const has = (id: unknown): boolean => summaryStrategies.some((strategy) => strategy.id === id);
  const activeArticleSummaryStrategyId = has(settings.activeArticleSummaryStrategyId)
    ? String(settings.activeArticleSummaryStrategyId)
    : (summaryStrategies.find((strategy) => strategy.id === 'article-default')?.id || summaryStrategies[0].id);
  const activeNodeSummaryStrategyId = has(settings.activeNodeSummaryStrategyId)
    ? String(settings.activeNodeSummaryStrategyId)
    : (summaryStrategies.find((strategy) => strategy.id === 'node-default')?.id || summaryStrategies[0].id);
  return {
    ...settings,
    summaryStrategies,
    activeArticleSummaryStrategyId,
    activeNodeSummaryStrategyId,
    summaryConcurrency: normalizeSummaryConcurrency(settings.summaryConcurrency)
  };
}

export function summaryStrategyForMode(settings: SummaryStrategySettingsRaw | null | undefined, mode: 'article' | 'node' | string): SummaryStrategy {
  const normalized = normalizeSummaryStrategySettings(settings || {});
  const id = mode === 'article'
    ? normalized.activeArticleSummaryStrategyId
    : normalized.activeNodeSummaryStrategyId;
  return normalized.summaryStrategies.find((strategy) => strategy.id === id) ||
    normalized.summaryStrategies[mode === 'article' ? 0 : 1] ||
    normalizeSummaryStrategy({}, mode === 'article' ? 0 : 1);
}

export function summaryStrategyLabel(strategy: SummaryStrategyRaw): string {
  const normalized = normalizeSummaryStrategy(strategy);
  const text = getUiMessages().summary;
  const skip = normalized.skipBelowChars > 0 ? text.strategySkipBelow(normalized.skipBelowChars) : text.strategyNoSkip;
  const min = normalized.minWords > 0 ? text.strategyMinimum(normalized.minWords) : text.strategyNoMinimum;
  const max = normalized.maxWords > 0 ? text.strategyMaximum(normalized.maxWords) : text.strategyNoMaximum;
  const ratio = normalized.ratioPercent > 0 ? `${normalized.ratioPercent}%` : text.strategyFreeRatio;
  return `${skip} / ${min} / ${max} / ${ratio}`;
}

export function summaryStrategyDisplayName(strategy: Pick<SummaryStrategy, 'id' | 'name'>): string {
  const text = getUiMessages().summary;
  if (strategy.id === 'article-default') return text.articleDefaultName;
  if (strategy.id === 'node-default') return text.nodeDefaultName;
  return strategy.name;
}

export interface SummaryItem {
  text?: unknown;
  skip?: 'generated' | 'short' | null;
  [extra: string]: unknown;
}

export interface ProcessedSummaryItem extends SummaryItem {
  text: string;
  skip: 'generated' | 'short' | null;
}

// 泛型保留调用方在 SummaryItem 之上扩展的额外字段（如 useSummaryRun 的 target）。
export function applySummarySkipStrategy<T extends SummaryItem>(items: T[] = [], strategy: unknown, index: number = 0): Array<T & ProcessedSummaryItem> {
  const normalized = normalizeSummaryStrategy(strategy, index);
  return items.map((item) => {
    const text = String(item?.text || '').trim();
    if (item?.skip === 'generated') return { ...item, text, skip: 'generated' as const };
    if (normalized.skipBelowChars > 0 && text.length < normalized.skipBelowChars) {
      return { ...item, text, skip: 'short' as const };
    }
    return { ...item, text, skip: null };
  });
}

export function summarySkipBelowCount<T extends SummaryItem>(items: T[] = [], strategy: unknown, index: number = 0): number {
  return applySummarySkipStrategy(items, strategy, index).filter((item) => item.skip === 'short').length;
}

export function newSummaryStrategy<T>(existing: T[] = []): SummaryStrategy {
  return {
    ...normalizeSummaryStrategy(DEFAULT_SUMMARY_STRATEGIES[1], 1),
    id: newSettingsId('summary'),
    name: getUiMessages().summary.newStrategyName(existing.length + 1)
  };
}

export interface LlmApi {
  id: string;
  name: string;
  note: string;
  apiKey: string;
  baseUrl: string;
  fullUrl: boolean;
  model: string;
  protocol: string;
  contextLimit: number;
  maxOutputTokens: number;
  reasoningEfforts: string[];
  reasoningEffortMap: Record<string, string>;
  enabled: boolean;
  [extra: string]: unknown;
}

export interface LlmProvider {
  id: string;
  name: string;
  note: string;
  websiteUrl: string;
  apis: LlmApi[];
}

export function newLlmApi(): LlmApi {
  return {
    id: newSettingsId('api'),
    name: getUiMessages().settings.llm.newApi,
    note: '',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    fullUrl: false,
    model: 'deepseek-v4-pro',
    protocol: 'openai-compatible',
    contextLimit: 0,
    maxOutputTokens: 0,
    reasoningEfforts: [],
    reasoningEffortMap: {},
    enabled: true
  };
}

export interface LlmApiRaw {
  id?: unknown;
  name?: unknown;
  note?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  fullUrl?: unknown;
  model?: unknown;
  protocol?: unknown;
  contextLimit?: unknown;
  contextWindowTokens?: unknown;
  contextWindow?: unknown;
  maxContextTokens?: unknown;
  maxOutputTokens?: unknown;
  maxTokens?: unknown;
  max_tokens?: unknown;
  reasoningEfforts?: unknown;
  reasoning_efforts?: unknown;
  reasoningEffortMap?: unknown;
  reasoning_effort_map?: unknown;
  enabled?: unknown;
  modelCard?: { contextLimit?: unknown };
  metadata?: { contextLimit?: unknown };
  [extra: string]: unknown;
}

export function newLlmApiFromPreset(api: LlmApiRaw = {}): LlmApi {
  return {
    ...newLlmApi(),
    ...api,
    id: newSettingsId('api'),
    name: String(api.name || getUiMessages().settings.llm.newApi),
    note: String(api.note || ''),
    apiKey: '',
    baseUrl: String(api.baseUrl || 'https://api.deepseek.com'),
    fullUrl: api.fullUrl === true,
    model: String(api.model || 'deepseek-v4-pro'),
    protocol: String(api.protocol || 'openai-compatible'),
    contextLimit: Number(api.contextLimit) || 0,
    maxOutputTokens: Number(api.maxOutputTokens) || 0,
    reasoningEfforts: Array.isArray(api.reasoningEfforts) ? api.reasoningEfforts as string[] : [],
    reasoningEffortMap: (api.reasoningEffortMap && typeof api.reasoningEffortMap === 'object' ? api.reasoningEffortMap : {}) as Record<string, string>,
    enabled: api.enabled !== false
  };
}

export interface LlmProviderRaw {
  id?: unknown;
  name?: unknown;
  note?: unknown;
  websiteUrl?: unknown;
  apis?: LlmApiRaw[];
  api?: LlmApiRaw;
  [extra: string]: unknown;
}

export function newLlmProvider(preset: LlmProviderRaw | null = null, existingProviders: LlmProvider[] = []): LlmProvider {
  if (preset) {
    const apis = Array.isArray(preset.apis) && preset.apis.length > 0
      ? preset.apis.map((api) => newLlmApiFromPreset(api))
      : [newLlmApiFromPreset(preset.api || {})];
    const usedIds = new Set(existingProviders.map((provider) => provider.id));
    return {
      id: preset.id && !usedIds.has(String(preset.id)) ? String(preset.id) : newSettingsId('provider'),
      name: String(preset.name || getUiMessages().settings.llm.newProvider),
      note: String(preset.note || ''),
      websiteUrl: String(preset.websiteUrl || ''),
      apis
    };
  }
  const api = newLlmApi();
  return {
    id: newSettingsId('provider'),
    name: getUiMessages().settings.llm.newProvider,
    note: '',
    websiteUrl: '',
    apis: [api]
  };
}

export function normalizeLlmApiForEditor(api: LlmApiRaw = {}, index: number = 0): LlmApi {
  const contextLimit = Number(api.contextLimit ?? api.contextWindowTokens ?? api.contextWindow ?? api.maxContextTokens ?? api.modelCard?.contextLimit ?? api.metadata?.contextLimit);
  const maxOutputTokens = Number(api.maxOutputTokens ?? api.maxTokens ?? api.max_tokens);
  const hasReasoningEfforts = hasOwn(api, 'reasoningEfforts') || hasOwn(api, 'reasoning_efforts');
  const hasReasoningMap = hasOwn(api, 'reasoningEffortMap') || hasOwn(api, 'reasoning_effort_map');
  return {
    ...newLlmApi(),
    ...api,
    id: String(api.id || `api-${index + 1}`),
    name: String(api.name || `API ${index + 1}`),
    note: String(api.note || ''),
    apiKey: String(api.apiKey || ''),
    baseUrl: String(api.baseUrl || 'https://api.deepseek.com'),
    fullUrl: api.fullUrl === true,
    model: String(api.model || 'deepseek-v4-pro'),
    protocol: normalizeApiProtocol(api.protocol),
    contextLimit: Number.isFinite(contextLimit) && contextLimit > 0 ? Math.round(contextLimit) : 0,
    maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.round(maxOutputTokens) : 0,
    reasoningEfforts: hasReasoningEfforts ? normalizeReasoningEfforts(api.reasoningEfforts ?? api.reasoning_efforts) : [],
    reasoningEffortMap: hasReasoningMap ? normalizeReasoningEffortMap(api.reasoningEffortMap ?? api.reasoning_effort_map) : {},
    enabled: api.enabled !== false
  };
}

export function defaultLlmProviderForEditor(): LlmProvider {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    note: getUiMessages().settings.llm.defaultProvider,
    websiteUrl: 'https://api.deepseek.com',
    apis: [normalizeLlmApiForEditor({
      id: 'deepseek-default',
      name: getUiMessages().settings.llm.defaultApi,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro'
    }, 0)]
  };
}

export interface LlmSettingsRaw {
  providers?: LlmProviderRaw[];
  activeProviderId?: unknown;
  activeApiId?: unknown;
  configPath?: string;
  envPath?: string;
  [extra: string]: unknown;
}

export interface LlmSettings {
  providers: LlmProvider[];
  activeProviderId: string;
  activeApiId: string;
  configPath: string;
  envPath: string;
  [extra: string]: unknown;
}

export function normalizeLlmSettingsForEditor(settings: LlmSettingsRaw = {}): LlmSettings {
  const rawProviders = Array.isArray(settings.providers) ? settings.providers : [];
  const providers: LlmProvider[] = rawProviders.length
    ? rawProviders.map((provider, index) => {
      const apis = Array.isArray(provider.apis) && provider.apis.length > 0
        ? provider.apis.map((api, apiIndex) => normalizeLlmApiForEditor(api, apiIndex))
        : [normalizeLlmApiForEditor({}, 0)];
      return {
        id: String(provider.id || `provider-${index + 1}`),
        name: String(provider.name || getUiMessages().settings.llm.providerNumber(index + 1)),
        note: String(provider.note || ''),
        websiteUrl: String(provider.websiteUrl || ''),
        apis
      };
    })
    : [defaultLlmProviderForEditor()];
  const activeProvider = providers.find((provider) => provider.id === settings.activeProviderId) || providers[0];
  const activeApi = activeProvider.apis.find((api) => api.id === settings.activeApiId) || activeProvider.apis[0];
  return {
    ...settings,
    providers,
    activeProviderId: activeProvider.id,
    activeApiId: activeApi?.id || '',
    configPath: settings.configPath || 'iftree.config.json',
    envPath: settings.envPath || '.env'
  };
}

export function providerMatchesPreset(provider: LlmProvider | null | undefined, preset: LlmProviderPreset): boolean {
  return provider?.id === preset.id ||
    provider?.name === preset.name ||
    Boolean(provider?.websiteUrl && provider.websiteUrl === preset.websiteUrl);
}
