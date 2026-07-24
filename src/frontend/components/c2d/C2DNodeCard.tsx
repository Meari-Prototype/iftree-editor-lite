// C2DNodeCard.tsx
// C2D 列视图节点卡片（需求 9-1-x 节点渲染 / 9-1-6 统计按钮 / 9-1-7 类型头部栏）。
// memo 组件：经稳定身份的 CardApi 对象回调父组件（方法实现每次渲染刷新、对象身份永不变化），
// 其余 props 保持原始值/稳定引用以命中 memo。

import { memo } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { plainNodeNote } from '../../../core/node-notes.js';
import { nodeTypeLabel } from '../../lib/doc-utils.js';
import { RichMarkdown } from '../RichMarkdown';
import { subtreePreviewText, statsForNode, EXPAND_ICON, TEXT_CHAR_LIMIT } from './c2d-measure.js';
import { emptyNodePlaceholder } from './c2d-blocks.js';
import type { C2DBlock, C2DTreeIndex, StatsIndex } from './c2d-types';
import { useUiLanguage } from '../../../lang/ui.js';

// 9-1-7：类型固定颜色，程序实现不得临时改色值或随机分配颜色。
const NODE_TYPE_COLORS: Record<string, string> = {
  TEXT: 'transparent',
  IF: '#3b73a8',
  THEN: '#5f8f55',
  ELSE: '#b46f3c',
  ERROR: '#d13438'
};

export type EditField = 'note';

export interface InlineEditState {
  nodeId: string;
  field: EditField;
  draft: string;
}

// 卡片通过这个稳定的 api 对象回调父组件，自身才能 memo 化。
// 方法实现每次渲染刷新（impl ref），对象身份永不变化。
export interface CardApi {
  clickBlock(event: ReactMouseEvent, block: C2DBlock): void;
  openContextMenu(event: ReactMouseEvent, block: C2DBlock, subtreePreviewVisible: boolean): void;
  pointerDownBlock(event: ReactPointerEvent<HTMLElement>, block: C2DBlock): void;
  toggleExpand(block: C2DBlock): void;
  openStats(block: C2DBlock): void;
  setInlineDraft(draft: string): void;
  saveInline(exit: boolean): void;
  cancelInline(): void;
  registerCard(addr: string, el: HTMLElement | null): void;
  registerExpandBtn(addr: string, el: HTMLButtonElement | null): void;
  inlineInputRef: RefObject<HTMLTextAreaElement | null>;
}

function renderTypeBar(block: C2DBlock) {
  const type = String(block?.nodeType || 'TEXT').toUpperCase();
  if (type === 'TEXT') return null;
  const color = NODE_TYPE_COLORS[type];
  if (!color || color === 'transparent') return null;
  return (
    <div
      className="c2d-node-type-bar"
      style={{ '--c2d-node-type-color': color }}
      title={nodeTypeLabel(type)}
      aria-label={nodeTypeLabel(type)}
    />
  );
}

function InlineEditor({ edit, field, api }: { edit: InlineEditState | null; field: EditField; api: CardApi }) {
  const { messages } = useUiLanguage();
  if (!edit || edit.field !== field) return null;
  const label = messages.c2d.editSummaryNote;
  return (
    <form
      className={`c2d-inline-editor c2d-inline-editor-${field}`}
      onSubmit={(event) => {
        event.preventDefault();
        api.saveInline(true);
      }}
    >
      <span className="c2d-inline-label">{label}</span>
      <textarea
        ref={api.inlineInputRef}
        className="c2d-inline-input"
        value={edit.draft}
        rows={2}
        onChange={(event) => api.setInlineDraft(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            api.cancelInline();
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            api.saveInline(true);
          }
        }}
        autoFocus
      />
      <div className="c2d-inline-actions">
        <button type="button" onClick={() => api.saveInline(false)}>{messages.common.save}</button>
        <button type="submit">{messages.c2d.saveAndExit}</button>
        <button type="button" onClick={api.cancelInline}>{messages.common.cancel}</button>
      </div>
    </form>
  );
}

export interface C2DNodeCardProps {
  block: C2DBlock;
  index: C2DTreeIndex;
  statsIndex: StatsIndex;
  api: CardApi;
  selected: boolean;
  isExpanded: boolean;
  showNotes: boolean;
  isDragSource: boolean;
  isDragTarget: boolean;
  /** 仅当本卡片处于行内编辑时非 null，其它卡片保持 null 以命中 memo。 */
  inlineEdit: InlineEditState | null;
  paragraphLabelByNodeId: Map<string, string> | null | undefined;
  /** 文档 id：RichMarkdown 据此把节点正文里的本地路径图片解析成可加载 URL（缺则裂图）。 */
  docId: string | number | null;
}

export const C2DNodeCard = memo(function C2DNodeCard({
  block, index, statsIndex, api,
  selected, isExpanded, showNotes,
  isDragSource, isDragTarget, inlineEdit, paragraphLabelByNodeId, docId
}: C2DNodeCardProps) {
  const { messages } = useUiLanguage();
  const addr = block.address;
  const hasChildren = block.childCount > 0;
  const Icon = isExpanded ? ChevronLeft : ChevronRight;

  const noteText = plainNodeNote(block.note || '');
  const ownText = block.text || '';
  let subtreePreview = '';
  // 新节点模型中 block.text 只表示本节点正文，子孙正文仅由收起态预览独立遍历。
  if (hasChildren && !isExpanded) {
    subtreePreview = subtreePreviewText(index, block.id, TEXT_CHAR_LIMIT);
  }
  const stats = statsForNode(statsIndex, index, block);
  const subtreePreviewVisible = Boolean(subtreePreview);
  const emptyPlaceholder = emptyNodePlaceholder(block, paragraphLabelByNodeId);
  const noteEditor = <InlineEditor edit={inlineEdit} field="note" api={api} />;
  const editingField = inlineEdit?.field ?? null;

  return (
    <article
      data-node-id={block.id}
      data-node-address={addr}
      ref={(el) => api.registerCard(addr, el)}
      className={`c2d-node-card${selected ? ' selected' : ''}${isExpanded ? ' expanded' : ''}${isDragSource ? ' drag-source' : ''}${isDragTarget ? ' drag-target' : ''}`}
      onPointerDown={(event) => api.pointerDownBlock(event, block)}
      onClick={(event) => api.clickBlock(event, block)}
      onContextMenu={(event) => api.openContextMenu(event, block, subtreePreviewVisible)}
    >
      {renderTypeBar(block)}
      <button
        type="button"
        className="c2d-node-stats-button"
        title={messages.c2d.nodeStatistics}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          api.openStats(block);
        }}
      >
        {stats.subtree.words}
      </button>
      <div className="c2d-node-meta">{addr}</div>
      {ownText
        ? <div className="c2d-node-body"><RichMarkdown markdown={ownText} docId={docId == null ? null : String(docId)} /></div>
        : !subtreePreview && <div className="c2d-node-body muted">{emptyPlaceholder}</div>}
      {subtreePreview ? <div className="c2d-node-body c2d-subtree-preview">{subtreePreview}</div> : null}
      {editingField === 'note' ? noteEditor : (showNotes && noteText ? <div className="c2d-node-note">{noteText}</div> : null)}
      {hasChildren ? (
        <button
          type="button"
          ref={(el) => api.registerExpandBtn(addr, el)}
          className="c2d-expand-button c2d-child-expand-button"
          aria-label={isExpanded ? messages.common.collapse : messages.common.expand}
          title={isExpanded ? messages.common.collapse : messages.common.expand}
          onClick={(event) => { event.stopPropagation(); event.preventDefault(); api.toggleExpand(block); }}
        >
          <Icon aria-hidden="true" size={EXPAND_ICON} strokeWidth={2.2} />
        </button>
      ) : null}
    </article>
  );
});
