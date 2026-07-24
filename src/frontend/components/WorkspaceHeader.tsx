import {
  BookOpen,
  ChevronsDownUp,
  ChevronsUpDown,
  ListTree,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Redo2,
  Undo2
} from 'lucide-react';
import { type MouseEvent, type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';

import { DepthCollapseOneIcon, DepthExpandOneIcon, IconButton } from './common.jsx';
import { SummaryConfirmDialog, type SummaryConfirmRequest } from './SummaryConfirmDialog.jsx';
import type { SummaryStrategy } from '../lib/summary-utils.js';
import { toggleTheme } from '../lib/theme.js';
import { useFloatingMenu } from '../hooks/useFloatingMenu.js';
import { useUiLanguage } from '../../lang/ui.js';

const VIEW_MENU_WIDTH = 190;
const VIEW_MENU_HEIGHT = 430;
const MENU_OFFSET = 6;

type MenuId = 'view';

interface MenuSpec {
  className: string;
  width: number;
  height: number;
}

const MENU_SPECS: Record<MenuId, MenuSpec> = {
  view: { className: 'view-options-menu', width: VIEW_MENU_WIDTH, height: VIEW_MENU_HEIGHT }
};

export type WorkspaceTab = 'tree' | 'rich';

// 编辑分支按钮的可选项（diff button menu 来源）。
export interface DiffBranchOption {
  id?: string | number;
  label?: string;
  activeEntryCount?: number;
  disabled?: boolean;
}

// setVisibleDepth 第二参，源自 useTreeViewState 的语义动作日志。
interface VisibleDepthOptions {
  clearAll?: boolean;
  action?: 'collapseAll' | 'expandOne' | 'expandAll' | 'setDepth';
}

// children 可以是 ReactNode 也可以是 render-prop（接收 view 显示开关）。
interface WorkspaceHeaderViewState {
  viewShowNotes: boolean;
}

export interface WorkspaceHeaderProps<SummaryRequest extends SummaryConfirmRequest = SummaryConfirmRequest> {
  title?: string;
  activeTab: WorkspaceTab;
  setActiveTab: (tab: WorkspaceTab) => void;
  undoEdit?: () => void;
  redoEdit?: () => void;
  undoDisabled?: boolean;
  redoDisabled?: boolean;
  treeEditMode?: boolean;
  toggleTreeEditMode?: () => void;
  hasTree: boolean;
  /** 是否已打开任意文档（含虚拟文档）：决定深度工具组是否渲染 */
  hasDoc?: boolean;
  /** 右侧智能体栏折叠状态与切换（header 最右的显隐按钮） */
  rightSidebarCollapsed?: boolean;
  onToggleRightSidebar?: () => void;
  busy?: boolean;
  recomputeCurrentTreeView?: () => void;
  setVisibleDepth: (depth: number | string, options?: VisibleDepthOptions) => void;
  collapseVisibleDepthOne?: () => void;
  visibleDepthLimit: number;
  visibleDepthOptions: number[];
  actualMaxDepth: number;
  summaryNotesVisible?: boolean;
  onToggleSummaryNotes?: () => void;
  onGenerateSummary?: (mode: string) => Promise<SummaryRequest | null | undefined>;
  onRunSummaryGeneration?: (request: SummaryRequest, strategy: SummaryStrategy) => void;
  diffBranches?: DiffBranchOption[];
  onOpenDiff?: (branch: DiffBranchOption) => void;
  children?: ReactNode | ((viewState: WorkspaceHeaderViewState) => ReactNode);
}

export function WorkspaceHeader<SummaryRequest extends SummaryConfirmRequest>({
  title,
  activeTab,
  setActiveTab,
  undoEdit,
  redoEdit,
  undoDisabled,
  redoDisabled,
  treeEditMode,
  toggleTreeEditMode,
  hasTree,
  hasDoc,
  rightSidebarCollapsed = true,
  onToggleRightSidebar,
  busy,
  recomputeCurrentTreeView,
  setVisibleDepth,
  collapseVisibleDepthOne,
  visibleDepthLimit,
  visibleDepthOptions,
  actualMaxDepth,
  summaryNotesVisible = true,
  onToggleSummaryNotes,
  onGenerateSummary,
  onRunSummaryGeneration,
  diffBranches = [],
  onOpenDiff,
  children
}: WorkspaceHeaderProps<SummaryRequest>) {
  const { messages } = useUiLanguage();
  const text = messages.workspace.header;
  const [summaryConfirm, setSummaryConfirm] = useState<SummaryRequest | null>(null);

  const normalizedDiffBranches: DiffBranchOption[] = Array.isArray(diffBranches) ? diffBranches : [];
  const enabledDiffBranches = normalizedDiffBranches.filter((branch) => (
    !branch?.disabled && Number(branch?.activeEntryCount) > 0
  ));
  const diffButtonDisabled = !hasTree || enabledDiffBranches.length === 0;

  const menu = useFloatingMenu({
    specs: (id: string) => MENU_SPECS[id as MenuId] || null,
    offset: MENU_OFFSET
  });

  function chooseSummaryMode(mode: string) {
    menu.close();
    onGenerateSummary?.(mode)?.then((request) => {
      if (request) setSummaryConfirm(request);
    });
  }

  function renderViewMenu() {
    if (menu.openId !== 'view' || !menu.position) return null;
    return createPortal(
      <div
        className="view-options-menu"
        style={{
          left: `${menu.position.left}px`,
          top: `${menu.position.top}px`,
          width: `${menu.position.width}px`
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" disabled={!hasTree} onClick={() => { menu.close(); toggleTreeEditMode?.(); }}>
          {treeEditMode ? text.finalizeAndExit : text.enterEditMode}
        </button>
        <button type="button" disabled={diffButtonDisabled} onClick={() => {
          const branch = enabledDiffBranches[0];
          if (!branch) return;
          menu.close();
          onOpenDiff?.(branch);
        }}>{text.viewDraftDiff}</button>
        {activeTab === 'tree' ? (
          <button type="button" disabled={!hasTree || busy} onClick={() => { menu.close(); recomputeCurrentTreeView?.(); }}>
            {text.rebuildTree}
          </button>
        ) : null}
        <div className="context-sep" />
        <button type="button" disabled={!hasTree || busy} onClick={() => chooseSummaryMode('selected')}>{text.summarySelected}</button>
        <button type="button" disabled={!hasTree || busy} onClick={() => chooseSummaryMode('subtree')}>{text.summarySubtree}</button>
        <button type="button" disabled={!hasTree || busy} onClick={() => chooseSummaryMode('depth')}>{text.summaryDepth}</button>
        <button type="button" disabled={!hasTree || busy} onClick={() => chooseSummaryMode('article')}>{text.summaryArticle}</button>
        <div className="context-sep" />
        <button
          type="button"
          className={summaryNotesVisible ? 'active' : ''}
          onClick={() => onToggleSummaryNotes?.()}
        >
          {text.summaryNotes}
        </button>
        <div className="context-sep" />
        <button type="button" onClick={() => { toggleTheme(); }}>
          {text.switchTheme}
        </button>
      </div>,
      document.body
    );
  }

  function toggleViewMenu(event: MouseEvent<HTMLButtonElement>) {
    menu.toggle('view', event);
  }

  const renderedChildren = typeof children === 'function'
    ? children({
      viewShowNotes: summaryNotesVisible
    })
    : children;
  // 未打开文档时不渲染深度工具组（占位隐藏），保持 header 干净；
  // 虚拟文档（库导航等）有树可看，也显示深度组。
  const showSecondaryTools = hasDoc ?? hasTree;

  return (
    <>
      <header className="workspace-header">
        <div className="workspace-title">
          <h2>{title}</h2>
        </div>
        <div className="workspace-tools">
          <div className="workspace-primary-tools">
            {activeTab === 'tree' && (
              <div className="history-controls" aria-label={text.editHistory}>
                <IconButton title={text.undo} onClick={undoEdit} disabled={undoDisabled}><Undo2 size={16} /></IconButton>
                <IconButton title={text.redo} onClick={redoEdit} disabled={redoDisabled}><Redo2 size={16} /></IconButton>
              </div>
            )}
            <IconButton
              title={activeTab === 'tree' ? text.switchToRich : text.switchToTree}
              onClick={() => setActiveTab(activeTab === 'tree' ? 'rich' : 'tree')}
            >
              {activeTab === 'tree' ? <BookOpen size={16} /> : <Pencil size={16} />}
            </IconButton>
          </div>
          <div
            className={`workspace-secondary-tools ${showSecondaryTools ? '' : 'is-placeholder'}`}
            aria-hidden={showSecondaryTools ? undefined : true}
          >
            {showSecondaryTools && (
              <div className="depth-controls">
                <button className="depth-icon-button" title={text.collapseAll} aria-label={text.collapseAll} onClick={() => setVisibleDepth(1, { clearAll: true, action: 'collapseAll' })}><ChevronsDownUp size={16} /></button>
                <button className="depth-icon-button depth-step-button" title={text.collapseOne} aria-label={text.collapseOne} disabled={visibleDepthLimit <= 1} onClick={collapseVisibleDepthOne}><DepthCollapseOneIcon size={16} /></button>
                <label title={text.depth} aria-label={text.depth}>
                  <span><ListTree size={15} /></span>
                  <select
                    title={text.depth}
                    aria-label={text.depth}
                    value={visibleDepthLimit}
                    onChange={(event) => setVisibleDepth(event.target.value, { action: 'setDepth' })}
                  >
                    {visibleDepthOptions.map((depth) => (
                      <option key={depth} value={depth}>{depth}</option>
                    ))}
                  </select>
                </label>
                <button className="depth-icon-button depth-step-button" title={text.expandOne} aria-label={text.expandOne} onClick={() => setVisibleDepth(visibleDepthLimit + 1, { clearAll: true, action: 'expandOne' })}><DepthExpandOneIcon size={16} /></button>
                <button className="depth-icon-button" title={text.expandAll} aria-label={text.expandAll} onClick={() => setVisibleDepth(actualMaxDepth, { clearAll: true, action: 'expandAll' })}><ChevronsUpDown size={16} /></button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="depth-icon-button"
            title={text.more}
            aria-label={text.more}
            onClick={toggleViewMenu}
          >
            <MoreHorizontal size={16} />
          </button>
          {renderViewMenu()}
          <IconButton
            title={rightSidebarCollapsed ? text.showAgent : text.hideAgent}
            onClick={onToggleRightSidebar}
          >
            {rightSidebarCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
          </IconButton>
        </div>
      </header>
      {renderedChildren}
      {summaryConfirm && (
        <SummaryConfirmDialog
          request={summaryConfirm}
          onCancel={() => setSummaryConfirm(null)}
          onConfirm={(strategy) => {
            const request = summaryConfirm;
            setSummaryConfirm(null);
            onRunSummaryGeneration?.(request, strategy);
          }}
        />
      )}
    </>
  );
}
