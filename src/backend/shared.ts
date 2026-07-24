type JsonObject = Record<string, unknown>;

export function parseJsonObject(value: unknown, fallback: JsonObject = {}): JsonObject {
  try {
    const parsed = value ? JSON.parse(value as string) : fallback;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

interface AddressedNode {
  id?: unknown;
  address?: unknown;
}

export function compareNodeAddress(a: AddressedNode | null | undefined, b: AddressedNode | null | undefined): number {
  const aParts = String(a?.address || '').split('-').filter(Boolean).map(Number);
  const bParts = String(b?.address || '').split('-').filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

// 节点补丁字段校验：底座 updateNode 与编辑分支 stage/nodePatchForEditBranch 共用，故下沉到这里。
// human_tag 已退场（改 node_type）、trust_level 只走 human certify（18-3），补丁里夹这些字段一律报错。
export function hasOwnValue(source: unknown, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(source || {}, key));
}

export function assertNoHumanTagField(source: unknown, context = 'node patch'): void {
  if (hasOwnValue(source, 'human_tag', 'humanTag')) {
    throw new Error(`${context} no longer supports human_tag; set node_type instead`);
  }
}

export function assertNoEditTrustField(source: unknown, context = 'node patch'): void {
  if (hasOwnValue(source, 'trust_level', 'trustLevel', 'trust')) {
    throw new Error(`${context} no longer supports trust_level; use human certify to set trust_level`);
  }
}

// 节点间引用的 refKind 卫生校验：按 15-5-2-1 它是必填的自由分类词（不设枚举、不提供默认值），
// 但自由不等于不设防——挡长文本误传和控制字符。
// 草稿 stage（edit-branch）与落库重放（store.addNodeRefToNode）共用，故下沉到这里。
export function assertValidNodeRefKind(kind: string, context = 'ref.addNodeToNode'): void {
  if (/[\r\n\t]/.test(kind)) {
    throw new Error(`${context}: refKind 不能含换行/制表符——它是简短分类词（如 相关/参见/依赖），说明文字请放 note`);
  }
  if (kind.length > 32) {
    throw new Error(`${context}: refKind 过长（${kind.length} > 32 字符）——它是简短分类词（如 相关/参见/依赖），说明文字请放 note`);
  }
}
