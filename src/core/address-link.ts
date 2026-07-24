// 节点地址内联链接（agent 回答 → 文档节点跳转）的共享纯函数。
// 渲染层专用：从文本里抽出根地址 1 或形如 1-2-1 的多段地址候选，是否真实存在交给 resolve 过滤。

// 单段地址只有根节点 1；边界排除小数、负数及更长数字中的局部命中。
export const ADDRESS_CANDIDATE_PATTERN = /(?<![\d-])(?<!\d\.)(?:1|\d+(?:-\d+)+)(?![\d-])(?!\.\d)/g;

// 段数上限：真实文档地址很少超过 12 段，超长的连数字串基本是别的数据。
export const ADDRESS_MAX_SEGMENTS = 12;

// 严格形态校验（整串）：resolve / 入库前的最后一道过滤。
export function isAddressCandidate(text: unknown): boolean {
  const value = String(text || '').trim();
  if (!/^\d+(?:-\d+)*$/.test(value)) return false;
  const segments = value.split('-');
  return segments.length <= ADDRESS_MAX_SEGMENTS && (segments.length > 1 || value === '1');
}

// 从一段文本提取去重后的地址候选（保持出现顺序）。limit 防失控（一条消息最多解析这么多个）。
export function extractAddressCandidates(text: unknown, limit = 40): string[] {
  const source = String(text || '');
  if (!source) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(ADDRESS_CANDIDATE_PATTERN)) {
    const candidate = match[0];
    if (!isAddressCandidate(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
    if (result.length >= limit) break;
  }
  return result;
}
