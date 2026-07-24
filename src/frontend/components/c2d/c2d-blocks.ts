// c2d-blocks.ts
// C2D 块级数据工具：索引查询、拖拽目标校验、占位文案。
// 无 React、无 DOM——从 MindMapView 组件模块级原样外提。

import type { C2DBlock, C2DTreeIndex } from './c2d-types.js';
import { getUiMessages } from '../../../lang/ui.js';

export function isRootNode(node: C2DBlock | null | undefined) {
  return !node?.parentId || String(node?.address || '') === '1';
}

// id 全链路是字符串（uuidv7 / `tmp-…`，见 c2d-types），byId 键即原值。
export function lookupBlock(index: C2DTreeIndex, id: string | null | undefined): C2DBlock | null {
  return (id && index.byId.get(id)) || null;
}

export function isValidDragTarget(source: C2DBlock | null, target: C2DBlock | null): target is C2DBlock {
  if (!source || !target) return false;
  if (source.id === target.id) return false;
  const sourceAddress = String(source.address || '');
  const targetAddress = String(target.address || '');
  if (sourceAddress && targetAddress.startsWith(`${sourceAddress}-`)) return false;
  return true;
}

export function sourcePositionText(value: unknown) {
  const position = Number(value);
  if (!Number.isFinite(position)) return '';
  return String(position);
}

export function emptyNodePlaceholder(block: C2DBlock, paragraphLabelByNodeId: Map<string, string> | null | undefined) {
  const position = sourcePositionText(block.sourcePosition);
  const text = getUiMessages().content;
  if (!position) return text.emptyNode;
  const paragraphLabel = paragraphLabelByNodeId?.get(block.id);
  return paragraphLabel ? text.paragraphSentence(paragraphLabel, position) : text.sentencePosition(position);
}
