// C2D 编辑命令只保留节点备注和类型更新。

import { useCallback } from 'react';
import { lookupBlock } from './c2d-blocks.js';
import type { C2DBlock, C2DTreeIndex } from './c2d-types';
import { useUiLanguage } from '../../../lang/ui.js';

export interface C2DNodeCommandsOptions {
  index: C2DTreeIndex;
  canEdit: boolean;
  onNodeCommand?: ((command: Record<string, unknown>) => unknown) | null;
  onNotice?: ((message: string) => void) | null;
}

export function useC2DNodeCommands({
  index, canEdit, onNodeCommand = null, onNotice = null
}: C2DNodeCommandsOptions) {
  const { messages } = useUiLanguage();
  const runNodeCommand = useCallback((command: Record<string, unknown>) => {
    if (!canEdit) return null;
    if (typeof onNodeCommand !== 'function') {
      onNotice?.(messages.workspace.actionUnavailable);
      return null;
    }
    return onNodeCommand(command);
  }, [canEdit, messages.workspace.actionUnavailable, onNodeCommand, onNotice]);

  const blockById = useCallback((blockId: string | null | undefined): C2DBlock | null => {
    return lookupBlock(index, blockId);
  }, [index]);

  async function updateNode(block: C2DBlock, patch: Record<string, unknown>) {
    return runNodeCommand({
      type: 'updateBlock',
      target: { kind: 'node', nodeId: block.id },
      patch
    });
  }

  return { runNodeCommand, blockById, updateNode };
}
