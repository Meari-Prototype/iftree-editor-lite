// useC2DInlineEdit.ts
// C2D 卡片行内编辑状态机：只编辑摘要备注。
// 从 MindMapView 组件体原样外提；关菜单动作经 closeContextMenu 回调注入（保持原时序）。

import { useLayoutEffect, useRef, useState } from 'react';
import type { EditField, InlineEditState } from './C2DNodeCard';
import type { C2DBlock } from './c2d-types';

export interface C2DInlineEditOptions {
  canEdit: boolean;
  blockById(blockId: string | null | undefined): C2DBlock | null;
  updateNode(block: C2DBlock, patch: Record<string, unknown>): Promise<unknown>;
  onNotice?: ((message: string) => void) | null;
  closeContextMenu(): void;
}

export function useC2DInlineEdit({
  canEdit, blockById, updateNode, onNotice = null, closeContextMenu
}: C2DInlineEditOptions) {
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const inlineInputRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    if (!inlineEdit) return;
    const input = inlineInputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [inlineEdit?.nodeId, inlineEdit?.field]);

  function startInlineEdit(block: C2DBlock, field: EditField) {
    if (!canEdit) return;
    const draft = block.note || '';
    setInlineEdit({ nodeId: block.id, field, draft });
    closeContextMenu();
  }

  function cancelInlineEdit() {
    setInlineEdit(null);
  }

  async function saveInlineEdit(exit = true) {
    if (!inlineEdit) return;
    const block = blockById(inlineEdit.nodeId);
    if (!block) {
      setInlineEdit(null);
      return;
    }
    await updateNode(block, { node_note: inlineEdit.draft });
    if (exit) setInlineEdit(null);
  }

  function setInlineDraft(draft: string) {
    setInlineEdit((current) => current ? { ...current, draft } : current);
  }

  return {
    inlineEdit,
    inlineInputRef,
    startInlineEdit,
    cancelInlineEdit,
    saveInlineEdit,
    setInlineDraft
  };
}
