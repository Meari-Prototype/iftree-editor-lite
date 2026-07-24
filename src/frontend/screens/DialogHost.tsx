// 对话框簇（frontend-refactor.md §6 阶段 3）：编辑草稿 diff
// 选择框 / 三个 ChoiceDialog / 全局进度遮罩，从 AppBody JSX 原样迁入。

import { ChoiceDialog } from '../components/common.jsx';
import { EditBranchDiffDialog } from '../components/EditBranchDiffDialog.jsx';
import { ProgressOverlay } from '../components/ProgressOverlay.jsx';
import { useAppUIContext } from '../hooks/useAppUI.js';
import { useAppState } from '../app-context.js';
import { useUiLanguage } from '../../lang/ui.js';

export function DialogHost() {
  const { messages } = useUiLanguage();
  const text = messages.dialogs;
  const { progress, operationLock, lockedProgress } = useAppUIContext();
  const { dialogs, summary } = useAppState();
  const {
    editExitDialog, startupEditBranchDialog, agentApprovalEditDialog,
    editBranchDiffDialog, closeEditBranchDiff
  } = dialogs;

  return (
    <>
      {editBranchDiffDialog.open && (
        <EditBranchDiffDialog
          view={editBranchDiffDialog.view}
          loading={editBranchDiffDialog.loading}
          error={editBranchDiffDialog.error}
          onClose={closeEditBranchDiff}
        />
      )}

      <ChoiceDialog
        open={editExitDialog.open}
        title={text.exitEditTitle}
        message={text.exitEditMessage}
        backdropValue="cancel"
        onChoose={editExitDialog.resolve}
        actions={[
          { value: 'cancel', label: messages.common.cancel },
          { value: 'discard', label: messages.common.discard },
          { value: 'save', label: messages.common.save }
        ]}
      />

      <ChoiceDialog
        open={startupEditBranchDialog.open}
        title={text.restoreEditTitle}
        message={text.restoreEditMessage(String(startupEditBranchDialog.payload?.base_title || startupEditBranchDialog.payload?.shadow_title || text.currentDocument))}
        backdropValue="stash"
        onChoose={startupEditBranchDialog.resolve}
        actions={[
          { value: 'discard', label: messages.common.discard },
          { value: 'stash', label: messages.common.stash },
          { value: 'restore', label: messages.common.restore, autoFocus: true }
        ]}
      />

      <ChoiceDialog
        open={agentApprovalEditDialog.open}
        title={text.acceptLlmTitle}
        message={text.acceptLlmMessage}
        backdropValue="cancel"
        onChoose={agentApprovalEditDialog.resolve}
        actions={[
          { value: 'cancel', label: messages.common.cancel },
          { value: 'enter', label: text.enterEditMode, autoFocus: true }
        ]}
      />

      <ProgressOverlay
        progress={progress as Parameters<typeof ProgressOverlay>[0]['progress']}
        lockedProgress={lockedProgress as Parameters<typeof ProgressOverlay>[0]['lockedProgress']}
        locked={Boolean(operationLock)}
        onCancel={summary.cancelSummaryGeneration}
      />
    </>
  );
}
