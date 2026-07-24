// C2DContextMenu.tsx
// C2D 节点右键菜单（需求 9-5 只读交互：非编辑模式下动作降级为「请先进入编辑模式」提示）。
// 从 MindMapView 内联 IIFE 原样组件化：动作经 actions 对象注入，菜单自身无业务逻辑。

import { createPortal } from 'react-dom';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { NODE_TYPES } from '../../../core/tree.js';
import { nodeTypeLabel } from '../../lib/doc-utils.js';
import type { EditField } from './C2DNodeCard';
import type { C2DBlock, C2DTreeIndex } from './c2d-types';
import { useUiLanguage } from '../../../lang/ui.js';

export interface CtxMenuState {
  x: number;
  y: number;
  block: C2DBlock;
  subtreePreviewVisible: boolean;
}

export interface C2DContextMenuActions {
  startInlineEdit(block: C2DBlock, field: EditField, options?: { subtreePreviewVisible?: boolean }): void;
  updateNode(block: C2DBlock, patch: Record<string, unknown>): void;
}

export interface C2DContextMenuProps {
  ctxMenu: CtxMenuState;
  index: C2DTreeIndex;
  canEdit: boolean;
  actions: C2DContextMenuActions;
  onNotice?: ((message: string) => void) | null;
  onClose(): void;
}

export function C2DContextMenu({
  ctxMenu, canEdit, actions, onNotice = null, onClose
}: C2DContextMenuProps) {
  const { messages } = useUiLanguage();
  const block = ctxMenu.block;
  const menuAction = (handler: () => void) => (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    handler();
  };
  const editModePromptAction = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onNotice?.(messages.notices.enterEditModeFirst);
    onClose();
  };
  const editButtonProps = (disabled: boolean, handler: () => void) => (
    canEdit
      ? { disabled, onClick: disabled ? undefined : menuAction(handler) }
      : { 'aria-disabled': 'true' as const, onClick: editModePromptAction }
  );
  const clampMenu = (el: HTMLDivElement | null) => {
    if (!el) return;
    const margin = 8;
    const r = el.getBoundingClientRect();
    const x = Math.max(margin, Math.min(ctxMenu.x, window.innerWidth - r.width - margin));
    const y = Math.max(margin, Math.min(ctxMenu.y, window.innerHeight - r.height - margin));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };
  return createPortal(
    <div ref={clampMenu} className="context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={e => e.stopPropagation()}>
      <button {...editButtonProps(false, () => actions.startInlineEdit(block, 'note'))}>{messages.c2d.editSummaryNote}</button>
      <div className="context-sep" />
      <div className="context-submenu">
          <div className={`context-sub-trigger${canEdit ? '' : ' disabled'}`} onClick={canEdit ? undefined : editModePromptAction}>{messages.c2d.changeType}</div>
          <div className="context-sub-items">
            {NODE_TYPES.map((t: string) => (
              <button
                key={t}
                {...editButtonProps(block?.nodeType === t, () => actions.updateNode(block, { node_type: t }))}
              >
                {nodeTypeLabel(t)}
              </button>
            ))}
          </div>
      </div>
    </div>,
    document.body
  );
}
