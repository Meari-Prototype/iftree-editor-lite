import { useMemo } from 'react';
import { plainNodeNote } from '../../core/node-notes.js';
import { flattenTree } from '../../core/tree.js';

import { PdfRichTextView } from './PdfRichTextView.jsx';
import { RichNodeView } from './RichNodeView';
import type { LocateRequest } from '../hooks/useNodeSelection.js';
import type { PdfVisiblePageInfo, PdfZoomMode } from '../lib/pdf-zoom.js';
import { renderInlineMarkdownText } from './SourceBlocks.jsx';
import type { TreeNode } from '../../core/node-model.js';
import type { ProjectedDoc } from '../hooks/useDocumentState.js';
import { useUiLanguage } from '../../lang/ui.js';
export const SOURCE_VIRTUAL_OVERSCAN = 1200;
export const SOURCE_WINDOW_CHAR_LIMIT = 50000;
export const SOURCE_WINDOW_AUTO_LOAD_GAP = 240;

export type RichTreeNode = TreeNode;
type RichCurrentDoc = ProjectedDoc;

// 源文档块的渲染视图（解析输出在前端的最小读取面）。
interface SourceBlockView {
  type?: string;
  start?: number;
  end?: number;
  text?: string;
  rows?: readonly object[];
  items?: readonly object[];
  lines?: readonly string[];
}

export function estimateSourceBlockHeight(block: SourceBlockView, rawMarkdown?: string | null) {
  const textLength = Math.max(1, Number(block?.end || 0) - Number(block?.start || 0));
  if (block?.type === 'heading') return 56;
  if (block?.type === 'code') {
    const lines = String(block.text || '').split('\n').length;
    return Math.max(52, lines * 20 + 34);
  }
  if (block?.type === 'table') {
    const rows = Array.isArray(block.rows) ? block.rows.length : 1;
    return Math.max(72, rows * 38 + 22);
  }
  if (block?.type === 'image') return 280;
  if (block?.type === 'list') {
    const items = Array.isArray(block.items) ? block.items.length : 1;
    return Math.max(44, items * 30 + Math.ceil(textLength / 90) * 10);
  }
  if (block?.type === 'blockquote') {
    const lines = Array.isArray(block.lines) ? block.lines.length : 1;
    return Math.max(52, lines * 32 + Math.ceil(textLength / 95) * 18);
  }
  const raw = rawMarkdown ? String(rawMarkdown).slice(block?.start || 0, block?.end || 0) : '';
  const lineCount = Math.max(1, raw.split('\n').length);
  return Math.max(38, lineCount * 28 + Math.ceil(textLength / 90) * 22);
}

export function nodeMapFromTree(tree: RichTreeNode | null | undefined) {
  return new Map(flattenTree(tree).map((node) => [node.id, node]));
}

export function RichTextView({
  currentDoc,
  docId,
  selectedNodeId,
  setSelectedNodeId = () => {},
  depthLimit = 1,
  showNotes,
  locateRequest = null,
  pdfScale,
  pdfZoomMode,
  onPdfScaleChange,
  onPdfResolvedScaleChange,
  onPdfVisiblePageChange
}: {
  currentDoc?: RichCurrentDoc | null;
  docId?: string | null;
  selectedNodeId?: string | null;
  setSelectedNodeId?: (nodeId: string | null) => void;
  depthLimit?: number;
  showNotes?: boolean;
  locateRequest?: LocateRequest | null;
  /** PDF 源专用：受控缩放 + 缩放模式 + 可见页上报（状态栏页码/缩放控件），非 PDF 源忽略。 */
  pdfScale?: number;
  pdfZoomMode?: PdfZoomMode;
  onPdfScaleChange?: (scale: number) => void;
  onPdfResolvedScaleChange?: (scale: number) => void;
  onPdfVisiblePageChange?: (info: PdfVisiblePageInfo | null) => void;
}) {
  const { messages } = useUiLanguage();
  const tree = currentDoc?.tree;
  const sourceDocument = currentDoc?.sourceDocument;
  const nodeById = useMemo(() => nodeMapFromTree(tree), [tree]);
  const isPdfSource = sourceDocument?.source_type === 'pdf';

  if (!tree) return <div className="empty-state">{messages.workspace.unopenedDocument}</div>;

  // 有版面坐标的源（PDF）保留坐标型渲染（span 映射回版面位置）。
  if (isPdfSource) {
    return (
      <PdfRichTextView
        currentDoc={currentDoc}
        docId={String(docId ?? '')}
        selectedNodeId={selectedNodeId}
        setSelectedNodeId={setSelectedNodeId}
        nodeById={nodeById}
        scale={pdfScale}
        zoomMode={pdfZoomMode}
        onScaleChange={onPdfScaleChange}
        onResolvedScaleChange={onPdfResolvedScaleChange}
        onVisiblePageChange={onPdfVisiblePageChange}
      />
    );
  }

  // 无版面格式（md / txt / docx）按节点树渲染统一富文本，不再走原文 + span 坐标层。
  return (
    <RichNodeView
      currentDoc={currentDoc}
      docId={docId}
      selectedNodeId={selectedNodeId}
      setSelectedNodeId={setSelectedNodeId}
      depthLimit={depthLimit}
      showNotes={showNotes}
      locateRequest={locateRequest}
    />
  );
}


export function SourceDocumentLead({ node, showNotes }: { node?: Pick<TreeNode, 'note'> | null; showNotes?: boolean }) {
  const { messages } = useUiLanguage();
  const note = plainNodeNote(node?.note || '');
  if (!showNotes || !note) return null;
  return (
    <section className="source-block source-document-lead">
      <span className="source-gutter-cell" aria-hidden="true" />
      <span className="source-gutter-cell source-gutter-sentence" aria-hidden="true" />
      <div className="source-block-body">
        <span className="source-node-extra-note">
          <span className="source-node-extra-label">{messages.content.articleSummaryNote}</span>
          {renderInlineMarkdownText(note, 'source-root-note')}
        </span>
      </div>
    </section>
  );
}
