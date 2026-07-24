// 模型名 → 上下文窗口大小对照表（token）。
//
// 为什么需要这张表：OpenAI 兼容协议的响应里只有 usage.prompt_tokens，没有任何字段给出
// 上下文窗口总量；各家 GET /models 也只返回模型名列表。协议层面拿不到，只能按模型名识别。
// 数值全部来自各厂商官方文档/模型页（2026-07-19 核实，来源见每条注释），官方只给十进制
// 表述（如 "1M"）时按十进制取值，不采用第三方精确值。
// 设置页手填的 contextLimit 永远优先于本表；本表只是免手填的兜底。
//
// 关于「多档窗口共存」的核实结论（2026-07-19）：当前主流模型已单档化——窗口由 model ID
// 唯一决定，请求层无需也无法选择窗口档（没有厂商提供窗口选择的请求参数）。历史上三类
// 分档机制：① Anthropic 4.6 代的 context-1m beta 请求头，已于 2026-03-13 GA 取消；
// ② GPT-5.6 -sol/-terra/-luna、Kimi -code/-highspeed 等 model ID 后缀，属能力/价格档，
// 窗口相同；③ OpenAI >272K、xAI >200K 的高价档，属计费档，窗口不变。若未来厂商重新
// 引入请求头选档，需在 API 配置上加 per-entry extraHeaders，届时再扩。

interface ModelContextRule {
  match: RegExp;
  contextLimit: number;
  source: string;
}

// 顺序即优先级：具体型号在前，系列通配在后。
const MODEL_CONTEXT_RULES: ModelContextRule[] = [
  // DeepSeek 官方定价页：v4-pro / v4-flash 同为 1M 上下文，单档（max output 384K）。
  // https://api-docs.deepseek.com/quick_start/pricing
  { match: /^deepseek-v4-pro/i, contextLimit: 1000000, source: 'api-docs.deepseek.com' },
  { match: /^deepseek-v4-flash/i, contextLimit: 1000000, source: 'api-docs.deepseek.com' },
  // 其余 deepseek-* 别名（chat/reasoner 分别为 v4-flash 的非思考/思考模式）同窗口。
  { match: /^deepseek-/i, contextLimit: 1000000, source: 'api-docs.deepseek.com' },

  // OpenAI 官方模型页：gpt-5.6（-sol/-terra/-luna 为能力/价格变体，同窗口 1.05M；别名 gpt-5.6 → sol）。
  // https://developers.openai.com/api/docs/models/gpt-5.6-sol
  { match: /^gpt-5\.6/i, contextLimit: 1050000, source: 'developers.openai.com' },
  // OpenAI 官方模型页：gpt-5.5（含 gpt-5.5-pro）窗口 1.05M。https://platform.openai.com/docs/models
  { match: /^gpt-5\.5/i, contextLimit: 1050000, source: 'platform.openai.com' },
  // OpenAI 模型页：gpt-5.2（含快照 gpt-5.2-2025-12-11）上下文 400K。
  { match: /^gpt-5\.2/i, contextLimit: 400000, source: 'platform.openai.com' },

  // Anthropic 官方总表：Opus 4.6/4.7/4.8 均 1M（4.6 的 1M 曾需 context-1m beta 头，2026-03-13 起 GA）。
  // https://platform.claude.com/docs/en/about-claude/models/overview
  { match: /^claude-opus-4-[678]/i, contextLimit: 1000000, source: 'platform.claude.com' },
  // Anthropic 模型总览：Opus 4.1 上下文 200K。
  { match: /^claude-opus-4-1/i, contextLimit: 200000, source: 'platform.claude.com' },
  // Anthropic 官方总表：Sonnet 4.6 起 1M GA（早期 200K+beta 头已结束）。
  { match: /^claude-sonnet-4-6/i, contextLimit: 1000000, source: 'platform.claude.com' },
  // Anthropic 官方总表：Sonnet 5 单档 1M。
  { match: /^claude-sonnet-5/i, contextLimit: 1000000, source: 'platform.claude.com' },
  // Sonnet 4/4.5 时代默认 200K（1M beta 已于 2026-04-30 结束，sonnet-4 已退役；条目保留供存量配置）。
  { match: /^claude-sonnet-4/i, contextLimit: 200000, source: 'platform.claude.com' },
  // Anthropic 官方总表：Haiku 4.5（含 -20251001 快照别名）单档 200K。
  { match: /^claude-haiku-4-5/i, contextLimit: 200000, source: 'platform.claude.com' },
  // Anthropic 官方总表：Fable 5（Mythos-class 新线，Opus 之上）单档 1M；孪生受限版 Mythos 5 同窗口。
  { match: /^claude-fable-5/i, contextLimit: 1000000, source: 'platform.claude.com' },
  { match: /^claude-mythos-5/i, contextLimit: 1000000, source: 'platform.claude.com' },

  // MiniMax 官方文档：M3（2026-06 发布，无 highspeed 变体）单档 1M；≤512K 输入分标准/长上下文
  // 计费档（计费档，窗口不变）。注意：上线初期 API 输入上限曾与标称 1M 存在时间差。
  // https://platform.minimax.io/docs/api-reference/text-openai-api
  { match: /^minimax-m3/i, contextLimit: 1000000, source: 'platform.minimax.io' },
  // MiniMax 官方模型表：M2.7（含官方 -highspeed 变体，同窗口）204800。
  { match: /^minimax-m2\.7/i, contextLimit: 204800, source: 'platform.minimax.io' },
  // 其余 M2.x 别名兜底。
  { match: /^minimax-m2/i, contextLimit: 204800, source: 'platform.minimax.io' },

  // 智谱官方模型页：GLM-5.2 单档 1M（High/Max 为思考强度档，非窗口档）。https://docs.z.ai/guides/llm/glm-5.2
  { match: /^glm-5\.2/i, contextLimit: 1000000, source: 'docs.z.ai' },
  // 智谱官方模型页：GLM-5 上下文 200K。https://docs.bigmodel.cn/cn/guide/models/text/glm-5
  { match: /^glm-5/i, contextLimit: 200000, source: 'docs.bigmodel.cn' },

  // Moonshot 官方 API 文档：Kimi K3 单档 1M（K3 Max / Swarm Max 为推理/多智能体形态，同窗口）。
  // https://platform.moonshot.ai/docs/api/chat
  { match: /^kimi-k3/i, contextLimit: 1048576, source: 'platform.moonshot.ai' },
  // 通用版 K2.7 不存在；官方目前仅有编程模型 kimi-k2.7-code（+ -highspeed 高速变体，同窗口 256K）。
  { match: /^kimi-k2\.7/i, contextLimit: 256000, source: 'platform.moonshot.ai' },
  // Moonshot 官方模型列表：Kimi K2.6 上下文 256K，单档。
  { match: /^kimi-k2\.6/i, contextLimit: 256000, source: 'platform.moonshot.ai' },

  // 千问 AI 平台官方模型表：Qwen3.8 Max Preview、Qwen3.7 Plus、Qwen3.6 Flash 均为 1M。
  // https://platform.qianwenai.com/docs/developer-guides/getting-started/text-generation-models
  { match: /^qwen3\.8-max-preview/i, contextLimit: 1000000, source: 'platform.qianwenai.com' },
  { match: /^qwen3\.7-plus/i, contextLimit: 1000000, source: 'platform.qianwenai.com' },
  { match: /^qwen3\.6-flash/i, contextLimit: 1000000, source: 'platform.qianwenai.com' },

  // Google Vertex AI 模型页（2026-07-18 更新）：Gemini 3.1 Pro（官方 ID 带 -preview 后缀，
  // 第三方平台常用 gemini-3.1-pro，前缀匹配两者）单档 1M。
  // https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-pro
  { match: /^gemini-3\.1-pro/i, contextLimit: 1048576, source: 'cloud.google.com' },
  // Gemini 3.5 Flash（已 GA，ID 无后缀）单档 1M。
  // https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-5-flash
  { match: /^gemini-3\.5-flash/i, contextLimit: 1048576, source: 'cloud.google.com' },
  // Google Vertex AI 模型页：Gemini 3 Flash（preview）上下文 1,048,576，单档。
  // https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-flash
  { match: /^gemini-3-flash/i, contextLimit: 1048576, source: 'cloud.google.com' },

  // xAI 官方模型页：Grok 4.5 单档 500K（比 4.3 缩小，非笔误）。https://docs.x.ai/docs/models
  { match: /^grok-4\.5/i, contextLimit: 500000, source: 'docs.x.ai' },
  // xAI 官方定价/模型页：Grok 4.3 单档 1M（>200K 为高价计费档，窗口不变）。
  { match: /^grok-4\.3/i, contextLimit: 1000000, source: 'docs.x.ai' },
  // xAI 官方模型页：Grok 4.20 系列（含 multi-agent / -reasoning / -latest 别名）1M。
  // https://docs.x.ai/docs/models/grok-4.20-reasoning
  { match: /^grok-4\.20-multi-agent/i, contextLimit: 1000000, source: 'docs.x.ai' },
  { match: /^grok-4\.20/i, contextLimit: 1000000, source: 'docs.x.ai' }
];

// 按模型名推断上下文窗口；不认识返回 0（调用方保持「未配置」语义，提示用户手填）。
export function inferContextLimitFromModel(model: unknown): number {
  const name = String(model || '').trim();
  if (!name) return 0;
  const rule = MODEL_CONTEXT_RULES.find((item) => item.match.test(name));
  return rule ? rule.contextLimit : 0;
}
