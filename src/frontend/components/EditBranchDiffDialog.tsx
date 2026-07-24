import { X } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { diffTextSegments } from '../../core/text-diff.js';
import { nodeTypeLabel } from '../lib/doc-utils.js';
import { getUiMessages, useUiLanguage } from '../../lang/ui.js';

// IPC 边界形态（editBranch.diffView 返回，字段全 optional 兼容 nodeRowWithClientAliases）。
export interface DiffViewNode {
  id?: unknown;
  address?: string;
  text?: unknown;
  note?: string;
  nodeNote?: string;
  nodeType?: string;
  node_type?: string;
  trustLevel?: unknown;
  trust_level?: unknown;
  sortOrder?: unknown;
  sort_order?: unknown;
  sourcePosition?: unknown;
  source_position?: unknown;
  status?: string;
  [extra: string]: unknown;
}

export type DiffViewSide = 'left' | 'right';
export type DiffRowKind = 'node' | 'collapsed';
export type DiffRowStatus = 'added' | 'deleted' | 'modified' | 'unchanged' | 'collapsed' | string;

export interface DiffViewRow {
  key: string;
  kind: DiffRowKind;
  status: DiffRowStatus;
  address?: string;
  depth?: number;
  left?: DiffViewNode | null;
  right?: DiffViewNode | null;
  changedFields?: string[];
  hiddenRows?: DiffViewRow[];
  hiddenCount?: number;
  [extra: string]: unknown;
}

export interface DiffViewStats {
  added?: number;
  deleted?: number;
  modified?: number;
  moved?: number;
  unchanged?: number;
  collapsed?: number;
  unchangedCollapsed?: number;
  visibleRows?: number;
  totalRows?: number;
  hiddenRows?: number;
  activeEntryCount?: number;
  undoneEntryCount?: number;
  undoDepth?: number;
  redoDepth?: number;
  changedOnly?: boolean;
  [extra: string]: unknown;
}

export interface EditBranchDiffViewModel {
  kind?: string;
  branch?: { id?: unknown; [extra: string]: unknown } | null;
  baseDoc?: { id?: unknown; title?: string; [extra: string]: unknown } | null;
  projectedDoc?: { id?: unknown; baseDocId?: unknown; title?: string; [extra: string]: unknown } | null;
  stats?: DiffViewStats;
  rows?: DiffViewRow[];
  entries?: unknown[];
  [extra: string]: unknown;
}

// 卡片本体展示正文/备注；这些短值字段的差异在本体上不可见，
// footer 必须带上本侧值、左右各取各的，对照才看得出改了什么（信任: 未标注 ↔ 信任: 受控）。
// parent_id 不在列：移动差异由同址对齐与占位行呈现，uuid 本身没有可读性。
const VALUE_BADGE_FIELDS = new Set(['node_type', 'trust_level', 'sort_order', 'source_position', 'status']);

function fieldValueLabel(node: DiffViewNode | null | undefined, field: string): string {
  const text = getUiMessages().diff;
  if (field === 'node_type') return nodeTypeLabel(node?.nodeType || node?.node_type || 'TEXT');
  if (field === 'trust_level') {
    const value = String(node?.trustLevel ?? node?.trust_level ?? '').trim();
    if (!value) return text.unmarked;
    if (value === '受控' || value === 'controlled') return text.controlled;
    if (value === '不受控' || value === 'uncontrolled') return text.uncontrolled;
    return value;
  }
  if (field === 'sort_order') return String(node?.sortOrder ?? node?.sort_order ?? '');
  if (field === 'source_position') {
    const value = node?.sourcePosition ?? node?.source_position;
    return value === null || value === undefined || value === '' ? getUiMessages().common.none : String(value);
  }
  return '';
}

function statusLabel(status: DiffRowStatus | undefined): string {
  const text = getUiMessages().diff;
  if (status === 'added') return text.added;
  if (status === 'deleted') return text.deleted;
  if (status === 'modified') return text.modified;
  return text.unchanged;
}

function nodeText(node: DiffViewNode | null | undefined): string {
  return String(node?.text || '').trim();
}

function nodeNote(node: DiffViewNode | null | undefined): string {
  return String(node?.nodeNote || node?.note || '').trim();
}

function expandedRows(rows: DiffViewRow[] | null | undefined, expandedKeys: Set<string>): DiffViewRow[] {
  const result: DiffViewRow[] = [];
  for (const row of rows || []) {
    result.push(row);
    if (row.kind === 'collapsed' && expandedKeys.has(row.key)) {
      for (const hidden of row.hiddenRows || []) {
        result.push({ ...hidden, key: `${row.key}:${hidden.key}` });
      }
    }
  }
  return result;
}

interface InlineDiffTextProps {
  before: string;
  after: string;
  side: DiffViewSide;
}

// 片段级高亮（修改行专用）：同一节点旧/新文本做字符级 diff，
// 左卡片渲染 equal+del（删除片段红遮罩），右卡片渲染 equal+ins（新增片段绿遮罩）。
function InlineDiffText({ before, after, side }: InlineDiffTextProps) {
  const segments = useMemo(() => diffTextSegments(before, after), [before, after]);
  const skip = side === 'left' ? 'ins' : 'del';
  const visible = segments.filter((segment) => segment.type !== skip);
  return visible.map((segment, index) => (
    segment.type === 'equal'
      ? <span key={index}>{segment.text}</span>
      : <mark key={index} className={segment.type === 'del' ? 'diff-inline-del' : 'diff-inline-ins'}>{segment.text}</mark>
  ));
}

interface DiffNodeCardProps {
  node: DiffViewNode | null | undefined;
  side: DiffViewSide;
  row: DiffViewRow;
}

type FieldPicker = (node: DiffViewNode | null | undefined) => string;

function DiffNodeCard({ node, side, row }: DiffNodeCardProps) {
  const { messages } = useUiLanguage();
  const emptyText = side === 'left' ? messages.diff.rightAdded : messages.diff.leftDeleted;
  if (!node) {
    return (
      <div className={`diff-node-card empty ${side}`}>
        <span>{emptyText}</span>
      </div>
    );
  }
  const text = nodeText(node);
  const note = nodeNote(node);
  // 修改行且两侧都在：长文本字段按片段染色；新增/删除行保持整卡绿/红。
  const inline = row.status === 'modified' && row.left && row.right;
  const renderField = (pick: FieldPicker, fallback = '') => {
    const leftValue = pick(row.left);
    const rightValue = pick(row.right);
    const own = side === 'left' ? leftValue : rightValue;
    if (!inline || leftValue === rightValue) return own || fallback;
    return <InlineDiffText before={leftValue} after={rightValue} side={side} />;
  };
  return (
    <article className={`diff-node-card ${side} ${row.status}`}>
      <header>
        <code>{node.address || row.address}</code>
        <span>{nodeTypeLabel(node.nodeType || node.node_type || 'TEXT')}</span>
        <em>{statusLabel(row.status)}</em>
      </header>
      <p>{renderField(nodeText, text ? '' : messages.content.emptyNode)}</p>
      {note ? <p className="diff-node-note">{renderField(nodeNote)}</p> : null}
      {row.status === 'modified' && row.changedFields?.length ? (
        <footer>
          {row.changedFields.map((field) => (
            <span key={field}>
              {(messages.diff.fields as Record<string, string>)[field] || field}
              {VALUE_BADGE_FIELDS.has(field) ? `: ${fieldValueLabel(node, field)}` : ''}
            </span>
          ))}
        </footer>
      ) : null}
    </article>
  );
}

interface DiffRowProps {
  row: DiffViewRow;
  expanded: boolean;
  onToggle: (key: string) => void;
}

function DiffRow({ row, expanded, onToggle }: DiffRowProps) {
  const { messages } = useUiLanguage();
  if (row.kind === 'collapsed') {
    return (
      <div className="edit-branch-diff-row collapsed" style={{ '--diff-depth': row.depth || 1 } as CSSProperties}>
        <button type="button" onClick={() => onToggle(row.key)}>
          {expanded
            ? messages.diff.collapseUnchanged(row.hiddenCount || 0)
            : messages.diff.expandUnchanged(row.hiddenCount || 0)}
        </button>
      </div>
    );
  }
  return (
    <div
      className={`edit-branch-diff-row ${row.status || 'unchanged'}`}
      style={{ '--diff-depth': row.depth || 1 } as CSSProperties}
      data-address={row.address}
    >
      <DiffNodeCard node={row.left} side="left" row={row} />
      <DiffNodeCard node={row.right} side="right" row={row} />
    </div>
  );
}

export interface EditBranchDiffDialogProps {
  view: EditBranchDiffViewModel | null | undefined;
  loading?: boolean;
  error?: string;
  onClose?: () => void;
}

export function EditBranchDiffDialog({ view, loading = false, error = '', onClose }: EditBranchDiffDialogProps) {
  const { messages } = useUiLanguage();
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => expandedRows(view?.rows || [], expandedKeys), [view?.rows, expandedKeys]);

  useEffect(() => {
    setExpandedKeys(new Set());
  }, [view?.branch?.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function toggleCollapsed(key: string): void {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const stats = view?.stats || {};

  return (
    <div className="dialog-overlay edit-branch-diff-overlay" onMouseDown={() => onClose?.()}>
      <section
        className="dialog-box edit-branch-diff-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={messages.diff.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="edit-branch-diff-header">
          <div>
            <strong>{messages.diff.title}</strong>
            <span>{messages.diff.activeDiffs(stats.activeEntryCount || 0)}</span>
          </div>
          <button type="button" className="diff-dialog-close" aria-label={messages.common.close} onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        {loading ? (
          <div className="edit-branch-diff-state">{messages.diff.loading}</div>
        ) : error ? (
          <div className="edit-branch-diff-state error">{error}</div>
        ) : (
          <>
            <div className="edit-branch-diff-stats" aria-label={messages.diff.changeStatistics}>
              <span>{messages.diff.addedCount(stats.added || 0)}</span>
              <span>{messages.diff.deletedCount(stats.deleted || 0)}</span>
              <span>{messages.diff.modifiedCount(stats.modified || 0)}</span>
              <span>{messages.diff.collapsedCount(stats.unchangedCollapsed || 0)}</span>
            </div>
            <div className="edit-branch-diff-column-head">
              <div>
                <strong>{messages.diff.base}</strong>
                <span>{view?.baseDoc?.title || messages.diff.baseDocument}</span>
              </div>
              <div>
                <strong>{messages.diff.shadowProjection}</strong>
                <span>{view?.projectedDoc?.title || view?.baseDoc?.title || messages.diff.projectedDocument}</span>
              </div>
            </div>
            <div className="edit-branch-diff-scroll">
              {rows.length > 0 ? rows.map((row) => (
                <DiffRow
                  key={row.key}
                  row={row}
                  expanded={expandedKeys.has(row.key)}
                  onToggle={toggleCollapsed}
                />
              )) : (
                <div className="edit-branch-diff-state">{messages.diff.noNodeDifferences}</div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
