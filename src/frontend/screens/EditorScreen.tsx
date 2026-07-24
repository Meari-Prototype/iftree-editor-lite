// 标准三列工作台：最左 ribbon 图标条、左侧文档/搜索栏、中间正文区、右侧可收起 LLM 区。
import { useCallback, useState } from 'react';
import {
  Database,
  Files,
  Search,
  Settings
} from 'lucide-react';

import { WindowTitlebar } from '../components/common.jsx';
import { AgentPanel } from '../components/AgentPanel.jsx';
import { RIBBON_WIDTH, normalizeDocId } from '../lib/doc-utils.js';
import { useAppState } from '../app-context.js';
import { useCommands } from '../commands/commands-context.js';
import { LeftSidebar, type LeftPanelView } from './LeftSidebar.jsx';
import { WorkspacePane } from './WorkspacePane.jsx';
import { DialogHost } from './DialogHost.jsx';
import { useUiLanguage } from '../../lang/ui.js';

export function EditorScreen() {
  const { messages } = useUiLanguage();
  const text = messages.shell;
  const { docState, layout, agentChat, entityTrace, misc } = useAppState();
  const { agent, treeView, document: documentCommands } = useCommands();
  const { docs } = docState;
  const {
    leftWidth, rightWidth, leftCollapsed, rightCollapsed,
    startSidebarResize, toggleLeft
  } = layout;
  // 左面板视图：ribbon 图标切换文件树 / 搜索；点击当前项折叠面板（仿 Obsidian）。
  const [leftView, setLeftView] = useState<LeftPanelView>('files');
  const hasTree = Boolean(docState.currentDoc?.tree && !docState.currentDoc?.virtual);
  const currentDocId = normalizeDocId(docState.currentDoc?.doc?.id);

  // agent 回答里的地址链接定位：目标文档就是消息所属文档（面板侧按会话 doc_id 判定）。
  // 跨文档必须走 openDoc 的编辑离场门禁；门禁拒绝或未实际打开目标文档时停止，不得错跳当前文档。
  const handleLocateAgentAddress = useCallback((docId: string | null, address: string) => {
    void (async () => {
      const openDocId = normalizeDocId(docState.currentDoc?.doc?.id);
      const targetDocId = normalizeDocId(docId);
      if (targetDocId && targetDocId !== openDocId) {
        const opened = await documentCommands.openDoc(targetDocId);
        if (normalizeDocId(opened?.doc?.id) !== targetDocId) return;
      }
      await treeView.jumpToCurrentDocAddress(address);
    })();
  }, [docState.currentDoc, documentCommands, treeView]);

  const selectRibbonView = (view: LeftPanelView) => {
    if (leftCollapsed) {
      setLeftView(view);
      toggleLeft();
      return;
    }
    if (view === leftView) {
      toggleLeft();
      return;
    }
    setLeftView(view);
  };

  const ribbonViewTitle = (view: LeftPanelView, label: string) => {
    if (leftCollapsed) return text.expandPanel(label);
    return leftView === view ? text.collapsePanel(label) : label;
  };

  return (
    <>
      <WindowTitlebar onClose={misc.handleCloseWindow} />
      <main className="app-shell">
        <nav className="workspace-ribbon" aria-label={text.sidebarPanels}>
          <button
            type="button"
            className={leftView === 'files' && !leftCollapsed ? 'active' : ''}
            title={ribbonViewTitle('files', text.fileList)}
            aria-label={ribbonViewTitle('files', text.fileList)}
            onClick={() => selectRibbonView('files')}
          >
            <Files size={18} />
          </button>
          <button
            type="button"
            className={leftView === 'search' && !leftCollapsed ? 'active' : ''}
            title={ribbonViewTitle('search', text.search)}
            aria-label={ribbonViewTitle('search', text.search)}
            onClick={() => selectRibbonView('search')}
          >
            <Search size={18} />
          </button>
          <button
            type="button"
            title={text.entityMaintenance}
            aria-label={text.entityMaintenance}
            disabled={!hasTree}
            onClick={entityTrace.openEntityMaintenance}
          >
            <Database size={18} />
          </button>
          <button
            type="button"
            style={{ marginTop: 'auto' }}
            title={messages.common.settings}
            aria-label={messages.common.settings}
            onClick={misc.openSettings}
          >
            <Settings size={18} />
          </button>
        </nav>

        {!leftCollapsed && (
          <button
            type="button"
            className="sidebar-resize-handle sidebar-resize-left"
            style={{ left: RIBBON_WIDTH + leftWidth - 4 }}
            title={text.resizeLeftSidebar}
            aria-label={text.resizeLeftSidebar}
            onPointerDown={(event) => startSidebarResize('left', event.nativeEvent, { clickToToggle: false })}
          />
        )}

        <LeftSidebar view={leftView} />

        <WorkspacePane />

        <aside className={`sidebar sidebar-right agent-sidebar ${rightCollapsed ? 'collapsed' : ''}`} style={{ width: rightWidth }}>
          <AgentPanel
            agentSettings={agentChat.settings}
            messages={agentChat.messages}
            diffs={agentChat.diffs}
            docs={docs}
            sessions={agentChat.sessions}
            activeSessionId={agentChat.activeSessionId}
            busy={agentChat.busy}
            contextUsage={agentChat.contextUsage}
            currentDocId={currentDocId}
            onLocateAddress={handleLocateAgentAddress}
            onRun={agent.runAgentRequest}
            onCancel={agent.cancelAgentRequest}
            onApply={agent.applyAgentDiff}
            onReject={agent.rejectAgentDiff}
            onApplyAll={agent.applyAllAgentDiffs}
            onRejectAll={agent.rejectAllAgentDiffs}
            onLoadSession={agentChat.loadSession}
            onDeleteSession={agentChat.deleteSession}
            onNewSession={agentChat.newSession}
            onTraceDiff={agent.traceAgentDiff}
          />
        </aside>

        {!rightCollapsed && (
          <button
            type="button"
            className="sidebar-resize-handle sidebar-resize-right"
            style={{ right: rightWidth - 4 }}
            title={text.resizeAgentSidebar}
            aria-label={text.resizeAgentSidebar}
            onPointerDown={(event) => startSidebarResize('right', event.nativeEvent, { clickToToggle: false })}
          />
        )}

        <DialogHost />
      </main>
    </>
  );
}
