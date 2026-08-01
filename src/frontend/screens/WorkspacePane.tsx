// 编辑器中栏（frontend-refactor.md §6 阶段 3）：WorkspaceHeader + 五视图（tree/ide/rich/
// entity/search）+ 空态。useEntityTrace 与 C2D 命令分发随视图迁入（deps 全部来自
// context / commands，无外部消费者）。undo/redo 可用性经 editorStore selector 订阅。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildParagraphLabelMap,
  docDisplayTitle,
  RIBBON_WIDTH
} from '../lib/doc-utils.js';
import {
  clampPdfZoom,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  PDF_ZOOM_PRESETS,
  PDF_ZOOM_STEP,
  readStoredPdfZoomState,
  writeStoredPdfZoomState
} from '../lib/pdf-zoom.js';
import type { PdfVisiblePageInfo, PdfZoomMode, PdfZoomState } from '../lib/pdf-zoom.js';
import { useDisplayScale } from '../lib/display-scale.js';
import { debugPerfBegin, debugPerfEnd } from '../lib/debug-log.js';
import { ViewAlignedEmptyState } from '../components/common.jsx';
import { C2DMapView } from '../components/c2d/C2DMapView';
import type { C2DMapHandle } from '../components/c2d/C2DMapView';
import { RichTextView } from '../components/RichTextView.jsx';
import { WorkspaceHeader } from '../components/WorkspaceHeader.jsx';
import { nodeRepository } from '../data/repositories.js';
import { useAppUIContext } from '../hooks/useAppUI.js';
import { useAppState } from '../app-context.js';
import { useCommands } from '../commands/commands-context.js';
import { useStoreSelector } from '../stores/use-store.js';
import { useUiLanguage } from '../../lang/ui.js';

export function WorkspacePane() {
  const { messages } = useUiLanguage();
  const text = messages.workspace;
  const { busy, notice, activeTab, setNotice } = useAppUIContext();
  const { docState, treeView, selection, layout, editorStore, summary, startup, dialogs, misc } = useAppState();
  const { editor, document: documentCommands } = useCommands();
  const { currentDoc, selectedLibraryEntry } = docState;
  const {
    depthLimit,
    actualMaxDepth, depthOptions,
    setVisibleDepth, collapseVisibleDepthOne, syncC2dVisibleDepth
  } = treeView;
  // 深度控件 → session 持久化（useTreeViewState）+ C2D 地图命令（ref 直达，替代旧 seq 脉冲）。
  const c2dMapRef = useRef<C2DMapHandle | null>(null);
  const applyVisibleDepth = useCallback(async (value: number | string, options: { clearAll?: boolean; action?: string } = {}) => {
    const nextDepth = await setVisibleDepth(value, options);
    c2dMapRef.current?.applyDepthControl(options.action || 'setDepth', nextDepth);
  }, [setVisibleDepth]);
  const applyCollapseVisibleDepthOne = useCallback(async () => {
    const nextDepth = await collapseVisibleDepthOne();
    c2dMapRef.current?.applyDepthControl('collapseOne', nextDepth);
  }, [collapseVisibleDepthOne]);
  const { selectedNodeId, setSelectedNodeId, setMultiSelectedNodeIds, locateRequest } = selection;
  const { leftWidth, rightWidth, leftCollapsed, rightCollapsed, toggleRight } = layout;
  const undoDepth = useStoreSelector(editorStore, (state) => state.undoStack.length);
  const redoDepth = useStoreSelector(editorStore, (state) => state.redoStack.length);

  const paragraphLabelByNodeId = useMemo(() => {
    // debug 模式下测段落 label 聚合耗时
    const perfToken = debugPerfBegin('buildParagraphLabelMap');
    const map = buildParagraphLabelMap(currentDoc?.tree);
    debugPerfEnd('buildParagraphLabelMap', perfToken, { nodes: map?.size ?? 0 });
    return map;
  }, [currentDoc?.tree]);

  const diffBranchOptions = useMemo(() => {
    const branch = editor.activeEditBranch(currentDoc);
    if (!branch) return [];
    const activeEntryCount = editor.editBranchUndoEntries(branch).length;
    return [{
      id: branch.id,
      label: text.currentDraft,
      activeEntryCount,
      disabled: activeEntryCount <= 0,
      branch
    }];
  }, [currentDoc?.editBranch, text.currentDraft]);

  const runC2DNodeCommand = useCallback((command: {
    type?: string;
    target?: { kind?: string; nodeId?: unknown; [k: string]: unknown };
    parentNodeId?: unknown;
    afterNodeId?: unknown;
    nodeId?: unknown;
    direction?: unknown;
    patch?: Record<string, unknown>;
    [k: string]: unknown;
  } = {}) => {
    const docId = currentDoc?.doc?.id;
    if (!docId) return null;
    const target = command?.target || {};
    return editor.dispatchWrite(() => {
      switch (command?.type) {
        case 'updateBlock':
          return nodeRepository.updateNode({
            docId,
            nodeId: target.nodeId,
            patch: command.patch || {}
          });
        default:
          setNotice(text.actionUnavailable);
          return null;
      }
    });
  }, [currentDoc?.doc?.id, editor, setNotice, text.actionUnavailable]);

  const visibleNodeCount = Number(currentDoc?.doc?.node_count) > 0
    ? Number(currentDoc!.doc!.node_count)
    : Number(currentDoc?.nodes?.length || 0);
  const workspaceTitle = currentDoc ? docDisplayTitle(currentDoc.doc) : (selectedLibraryEntry?.name || text.unopenedDocument);
  const workspaceSubtitle = currentDoc
    ? messages.common.nodeCount(visibleNodeCount)
    : selectedLibraryEntry
      ? text.sourceNotImported
      : text.selectLibraryFile;

  // ── PDF 阅读面状态栏：缩放控件持状态（受控下发 RichTextView），页码由视图上报 ──
  const [pdfZoomState, setPdfZoomState] = useState<PdfZoomState>(readStoredPdfZoomState);
  const [pdfZoomMenuOpen, setPdfZoomMenuOpen] = useState(false);
  const [pdfPageInfo, setPdfPageInfo] = useState<PdfVisiblePageInfo | null>(null);
  // 记住上次的缩放模式与档位（全局一档，不按文档分）。
  useEffect(() => {
    writeStoredPdfZoomState(pdfZoomState);
  }, [pdfZoomState]);
  // 用户主动选档位/拖滑杆/±/Ctrl+滚轮：固定百分比，模式切回 custom。
  const applyPdfZoom = useCallback((next: number) => {
    setPdfZoomState({ mode: 'custom', value: clampPdfZoom(next) });
  }, []);
  // 选适合宽度/适合页面：只切模式，实际百分比由视图解析后经 handlePdfResolvedZoom 回显。
  const applyPdfZoomMode = useCallback((mode: PdfZoomMode) => {
    setPdfZoomState((prev) => ({ ...prev, mode }));
  }, []);
  const handlePdfResolvedZoom = useCallback((zoom: number) => {
    setPdfZoomState((prev) => (Math.abs(prev.value - zoom) < 0.0005 ? prev : { ...prev, value: zoom }));
  }, []);
  const handlePdfVisiblePageChange = useCallback((info: PdfVisiblePageInfo | null) => {
    setPdfPageInfo(info);
  }, []);
  const isPdfSourceDoc = currentDoc?.sourceDocument?.source_type === 'pdf';
  const pdfZoom = pdfZoomState.value;
  // 出图密度诊断（PDF 发虚排查期保留）：DPR × 界面缩放 × 显示器缩放一目了然。
  const displayScale = useDisplayScale();

  return (
    <section
      className="workspace"
      style={{
        left: RIBBON_WIDTH + (leftCollapsed ? 0 : leftWidth),
        right: rightCollapsed ? 0 : rightWidth
      }}
    >
      <WorkspaceHeader
        title={workspaceTitle}
        activeTab={activeTab}
        setActiveTab={misc.changeActiveTab}
        undoEdit={editor.undoEdit}
        redoEdit={editor.redoEdit}
        undoDisabled={undoDepth === 0 || busy}
        redoDisabled={redoDepth === 0 || busy}
        treeEditMode={misc.treeEditMode}
        toggleTreeEditMode={editor.toggleTreeEditMode}
        hasTree={Boolean(currentDoc?.tree && !currentDoc?.virtual)}
        hasDoc={Boolean(currentDoc?.tree)}
        onCloseDocument={() => { void documentCommands.closeDoc(); }}
        busy={busy}
        recomputeCurrentTreeView={() => applyVisibleDepth(depthLimit, { clearAll: false })}
        setVisibleDepth={applyVisibleDepth}
        collapseVisibleDepthOne={applyCollapseVisibleDepthOne}
        visibleDepthLimit={depthLimit}
        visibleDepthOptions={depthOptions}
        actualMaxDepth={actualMaxDepth}
        summaryNotesVisible={summary.summaryNotesVisible}
        onToggleSummaryNotes={summary.toggleSummaryNotesVisible}
        onGenerateSummary={summary.generateSummary}
        onRunSummaryGeneration={(request, strategy) => { void summary.runSummaryGeneration(request, strategy); }}
        diffBranches={diffBranchOptions}
        onOpenDiff={dialogs.openEditBranchDiff}
        rightSidebarCollapsed={rightCollapsed}
        onToggleRightSidebar={toggleRight}
      >
        {({ viewShowNotes }) => (
          <>

      {notice && (
        <div className="notice" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}

      <div className="tree-surface" aria-busy={busy}>
        {currentDoc?.tree ? (
          <>
            <div style={{ display: activeTab === 'tree' ? 'contents' : 'none' }}>
              <C2DMapView
                ref={c2dMapRef}
                docId={currentDoc.doc?.id}
                rootNode={currentDoc.tree}
                expanded={treeView.c2dExpanded}
                onExpandedChange={treeView.setC2dExpanded}
                selectedNodeId={selectedNodeId}
                setSelectedNodeId={setSelectedNodeId}
                setMultiSelectedIds={setMultiSelectedNodeIds}
                onRenderReady={(info) => startup.handleMindMapRenderReady(info)}
                onNotice={setNotice}
                locateRequest={locateRequest}
                showNotes={viewShowNotes}
                paragraphLabelByNodeId={paragraphLabelByNodeId}
                maxVisibleDepth={actualMaxDepth}
                onVisibleDepthChange={syncC2dVisibleDepth}
                treeEditMode={misc.treeEditMode}
                onNodeCommand={runC2DNodeCommand}
              />
            </div>
            <div style={{ display: activeTab === 'rich' ? 'contents' : 'none' }}>
              <RichTextView
                currentDoc={currentDoc}
                docId={currentDoc.doc?.id == null ? null : String(currentDoc.doc.id)}
                selectedNodeId={selectedNodeId}
                setSelectedNodeId={setSelectedNodeId}
                depthLimit={depthLimit}
                showNotes={viewShowNotes}
                locateRequest={locateRequest}
                pdfScale={pdfZoom}
                pdfZoomMode={pdfZoomState.mode}
                onPdfScaleChange={applyPdfZoom}
                onPdfResolvedScaleChange={handlePdfResolvedZoom}
                onPdfVisiblePageChange={handlePdfVisiblePageChange}
              />
            </div>
          </>
        ) : (
          <ViewAlignedEmptyState
            activeTab={activeTab}
            selectedLibraryEntry={selectedLibraryEntry}
            onImport={documentCommands.importFiles}
          />
        )}
      </div>
          </>
        )}
      </WorkspaceHeader>
      <footer className="workspace-statusbar" aria-label={text.documentStatus}>
        {misc.treeEditMode && <span className="statusbar-item statusbar-edit">{text.editMode}</span>}
        {activeTab === 'rich' ? (
          // 富文本视图不配树统计（深度/节点数是给树视图的）；PDF 源给页码 + 缩放控件。
          isPdfSourceDoc ? (
            <>
              {pdfPageInfo ? (
                <span className="statusbar-item">{text.pageStatus(pdfPageInfo.page, pdfPageInfo.total)}</span>
              ) : null}
              <span className="statusbar-item statusbar-zoom">
                <button
                  type="button"
                  className="statusbar-zoom-btn"
                  onClick={() => applyPdfZoom(pdfZoom - PDF_ZOOM_STEP)}
                  disabled={pdfZoom <= PDF_ZOOM_MIN}
                  aria-label={text.zoomOut}
                  title={text.zoomOut}
                >−</button>
                <input
                  className="statusbar-zoom-slider"
                  type="range"
                  min={PDF_ZOOM_MIN}
                  max={PDF_ZOOM_MAX}
                  step={0.05}
                  value={pdfZoom}
                  onChange={(event) => applyPdfZoom(Number(event.target.value))}
                  aria-label={text.zoomRatio}
                />
                <button
                  type="button"
                  className="statusbar-zoom-btn"
                  onClick={() => applyPdfZoom(pdfZoom + PDF_ZOOM_STEP)}
                  disabled={pdfZoom >= PDF_ZOOM_MAX}
                  aria-label={text.zoomIn}
                  title={text.zoomIn}
                >+</button>
              </span>
              <span className="statusbar-zoom-anchor">
                <button
                  type="button"
                  className="statusbar-item statusbar-zoom-reset"
                  onClick={() => setPdfZoomMenuOpen((open) => !open)}
                  aria-expanded={pdfZoomMenuOpen}
                  aria-haspopup="menu"
                  title={text.zoomOptions}
                >{Math.round(pdfZoom * 100)}% ▾</button>
                {pdfZoomMenuOpen ? (
                  <>
                    <div className="statusbar-zoom-menu-backdrop" onClick={() => setPdfZoomMenuOpen(false)} />
                    <div className="statusbar-zoom-menu" role="menu" aria-label={text.zoomOptions}>
                      {PDF_ZOOM_PRESETS.map((preset) => {
                        const active = pdfZoomState.mode === 'custom' && Math.abs(pdfZoom - preset) < 0.005;
                        return (
                          <button
                            key={preset}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            onClick={() => {
                              applyPdfZoom(preset);
                              setPdfZoomMenuOpen(false);
                            }}
                          >
                            <span className="statusbar-zoom-menu-check">{active ? '✓' : ''}</span>
                            {Math.round(preset * 100)}%
                          </button>
                        );
                      })}
                      <div className="statusbar-zoom-menu-sep" />
                      {([
                        { mode: 'fit-width' as PdfZoomMode, label: text.fitWidth },
                        { mode: 'fit-page' as PdfZoomMode, label: text.fitPage }
                      ]).map(({ mode, label }) => {
                        const active = pdfZoomState.mode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            onClick={() => {
                              applyPdfZoomMode(mode);
                              setPdfZoomMenuOpen(false);
                            }}
                          >
                            <span className="statusbar-zoom-menu-check">{active ? '✓' : ''}</span>
                            {label}
                          </button>
                        );
                      })}
                      <div className="statusbar-zoom-menu-sep" />
                      <div className="statusbar-zoom-menu-diag">
                        {text.renderDensity(
                          displayScale.outputScale.toFixed(2),
                          displayScale.dpr.toFixed(2),
                          displayScale.zoomFactor.toFixed(2),
                          displayScale.scaleFactor > 0 ? displayScale.scaleFactor.toFixed(2) : ''
                        )}
                      </div>
                    </div>
                  </>
                ) : null}
              </span>
            </>
          ) : null
        ) : (
          <>
            {currentDoc?.tree && !currentDoc?.virtual && (
              <span className="statusbar-item">{text.depthStatus(depthLimit, actualMaxDepth)}</span>
            )}
            <span className="statusbar-item">{workspaceSubtitle}</span>
          </>
        )}
      </footer>
    </section>
  );
}
