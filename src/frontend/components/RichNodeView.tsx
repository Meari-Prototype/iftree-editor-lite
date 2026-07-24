import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { plainNodeNote } from '../../core/node-notes.js';
import { flattenTree } from '../../core/tree.js';
import { depthOf, docDisplayTitle } from '../lib/doc-utils.js';
import { buildVirtualRange } from '../lib/ui-utils.js';
import { useScrollViewport } from '../hooks/useScrollViewport.js';
import type { LocateRequest } from '../hooks/useNodeSelection.js';
import { RichMarkdown } from './RichMarkdown';
import { useUiLanguage } from '../../lang/ui.js';

// 富视图按节点树渲染（无版面格式 md / txt / docx）：每个节点一块,正文走统一富文本渲染,
// 节点 id 挂 DOM、点击选中 / 高亮——句子↔节点联动天然成立,不再靠原文 span 反查。
// 坐标型(rawMarkdown + span)只留给 PDF（PdfRichTextView）。深度过滤与原坐标版同义:
// 显示深度 ≤ depthLimit 的节点,且 depthLimit 处的节点完整展开其子树。
const NODE_OVERSCAN = 1200;

type RichTreeNode = Record<string, unknown> & {
  id?: unknown;
  address?: unknown;
  children?: RichTreeNode[];
  text?: string;
  node_note?: string;
};
type RichNodeDoc = { tree?: RichTreeNode | null; doc?: { meta?: unknown } | null };

// 结构化导入在文档 meta 中持久化标题地址；渲染层只认这份明确名单，不从 source_position
// 猜测角色（标题与句子都可能使用整数来源位置）。旧文档没有名单时只保留根题名样式。
function structuredHeadingAddresses(doc: RichNodeDoc | null | undefined): ReadonlySet<string> | null {
  let meta = (doc?.doc as { meta?: unknown } | null | undefined)?.meta;
  // doc.get 走 plainRow，meta 仍是 JSON 字符串；listDocs 走 normalizeDocRow 已解析成对象——两种都接。
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { return null; }
  }
  if (!meta || typeof meta !== 'object' || (meta as Record<string, unknown>).structured !== true) return null;
  const addresses = (meta as Record<string, unknown>).headingAddresses;
  return new Set(Array.isArray(addresses) ? addresses.map(String).filter(Boolean) : []);
}

function headingLevelOf(node: RichTreeNode, headingAddresses: ReadonlySet<string> | null): number | null {
  if (!headingAddresses) return null;
  if (!String(node.text || '').trim()) return null;
  const address = String(node.address || '1');
  const depth = depthOf(address);
  // 根节点（深度 1）= 文档题名，对标 Obsidian 的 inline title，按一级标题样式渲染。
  if (depth === 1) return 1;
  if (!headingAddresses.has(address)) return null;
  return Math.min(6, Math.max(1, depth - 1));
}

function visibleNodesForDepth(tree: RichTreeNode, depthLimit: unknown) {
  const flat = flattenTree(tree as unknown) as RichTreeNode[];
  const targetDepth = Math.max(1, Number(depthLimit) || 1);
  const targetNodes = flat.filter((node) => depthOf(String(node.address || '1')) === targetDepth);
  if (targetNodes.length === 0) return flat;
  const allowed = new Set<string>();
  for (const node of flat) {
    if (depthOf(String(node.address || '1')) <= targetDepth) allowed.add(String(node.id));
  }
  for (const node of targetNodes) collectSubtreeIds(node, allowed);
  return flat.filter((node) => allowed.has(String(node.id)));
}

function collectSubtreeIds(node: RichTreeNode, out: Set<string>) {
  out.add(String(node.id));
  for (const child of node.children || []) collectSubtreeIds(child, out);
}

// 虚拟滚动的高度预估（仅未渲染过的块用;渲染后 ResizeObserver 量回真实高度覆盖）。
function estimateNodeHeight(node: RichTreeNode) {
  const textLength = String(node.text || '').length;
  const noteHeight = node.node_note ? 26 : 0;
  const bodyHeight = Math.max(28, Math.ceil(textLength / 56) * 28);
  return bodyHeight + noteHeight + 18;
}

export function RichNodeView({
  currentDoc,
  docId,
  selectedNodeId,
  setSelectedNodeId,
  depthLimit,
  showNotes = false,
  locateRequest = null
}: {
  currentDoc?: RichNodeDoc | null;
  docId?: unknown;
  selectedNodeId?: string | null;
  setSelectedNodeId?: (nodeId: string | null) => void;
  depthLimit?: number;
  showNotes?: boolean;
  locateRequest?: LocateRequest | null;
}) {
  const { messages } = useUiLanguage();
  const tree = currentDoc?.tree;
  const headingAddresses = structuredHeadingAddresses(currentDoc);
  const nodes = useMemo(() => (tree ? visibleNodesForDepth(tree, depthLimit) : []), [tree, depthLimit]);
  const { scrollRef, viewport, onScroll } = useScrollViewport();
  const readerRef = useRef<HTMLDivElement | null>(null);
  const measuredHeightsRef = useRef(new Map<string, number>());
  const [measureVersion, setMeasureVersion] = useState(0);

  useEffect(() => {
    measuredHeightsRef.current = new Map();
    setMeasureVersion((version) => version + 1);
  }, [nodes]);

  const nodeHeights = useMemo(() => {
    const measured = measuredHeightsRef.current;
    return nodes.map((node) => measured.get(String(node.id)) ?? estimateNodeHeight(node));
  }, [nodes, measureVersion]);

  const virtual = useMemo(
    () => buildVirtualRange(nodeHeights, Math.max(0, viewport.scrollTop - 96), viewport.height, NODE_OVERSCAN),
    [nodeHeights, viewport]
  );
  const visibleNodes = nodes.slice(virtual.start, virtual.end);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const children = reader.children;
      if (children.length !== visibleNodes.length + 2) return;
      let changed = false;
      for (let index = 0; index < visibleNodes.length; index += 1) {
        const height = (children[index + 2] as HTMLElement).offsetTop - (children[index + 1] as HTMLElement).offsetTop;
        if (height <= 0) continue;
        const key = String(visibleNodes[index]!.id);
        const previous = measuredHeightsRef.current.get(key);
        if (previous === undefined || Math.abs(previous - height) > 0.5) {
          measuredHeightsRef.current.set(key, height);
          changed = true;
        }
      }
      if (changed) setMeasureVersion((version) => version + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (let index = 1; index < reader.children.length - 1; index += 1) observer.observe(reader.children[index]!);
    return () => observer.disconnect();
  }, [nodes, virtual]);

  const lastLocateSeqRef = useRef(0);
  useEffect(() => {
    const seq = Number(locateRequest?.seq || 0);
    const targetId = locateRequest?.nodeId;
    if (!seq || seq === lastLocateSeqRef.current || targetId == null) return;
    lastLocateSeqRef.current = seq;
    const el = scrollRef.current;
    if (!el) return;
    const index = nodes.findIndex((node) => String(node.id) === String(targetId));
    if (index < 0) return;
    let offset = 0;
    for (let i = 0; i < index; i += 1) offset += nodeHeights[i] || 0;
    el.scrollTop = Math.max(0, offset - 96);
  }, [locateRequest?.seq, nodes, nodeHeights, scrollRef]);

  if (!tree) return <div className="empty-state">{messages.workspace.unopenedDocument}</div>;

  return (
    <div className="rich-surface source-rich-surface" ref={scrollRef as RefObject<HTMLDivElement | null>} onScroll={onScroll}>
      <article className="source-document rich-node-document">
        <header className="source-title">
          <h1>{docDisplayTitle(currentDoc?.doc as Parameters<typeof docDisplayTitle>[0]) || tree.text}</h1>
          <span>{messages.common.nodeCount(nodes.length)}</span>
        </header>
        <div className="rich-node-reader" ref={readerRef}>
          <div className="source-virtual-spacer" style={{ height: Number(virtual.top) || 0 }} />
          {visibleNodes.map((node) => (
            <RichNodeBlock
              key={String(node.id)}
              node={node}
              docId={docId}
              selected={String(node.id) === String(selectedNodeId)}
              onSelect={setSelectedNodeId}
              showNotes={showNotes}
              headingLevel={headingLevelOf(node, headingAddresses)}
            />
          ))}
          <div className="source-virtual-spacer" style={{ height: virtual.bottom }} />
        </div>
      </article>
    </div>
  );
}

function RichNodeBlock({ node, docId, selected, onSelect, showNotes, headingLevel = null }: {
  node: RichTreeNode;
  docId?: unknown;
  selected?: boolean;
  onSelect?: (nodeId: string | null) => void;
  showNotes?: boolean;
  headingLevel?: number | null;
}) {
  const { messages } = useUiLanguage();
  const note = showNotes ? plainNodeNote(node.node_note || '') : '';
  return (
    <section
      data-node-id={node.id}
      className={`rich-node ${selected ? 'selected' : ''} ${headingLevel ? `rich-node-heading rich-node-h${headingLevel}` : ''}`}
      onClick={() => onSelect?.(selected ? null : (node.id == null ? null : String(node.id)))}
    >
      <div className="rich-node-body">
        {node.text ? <RichMarkdown markdown={String(node.text)} docId={docId == null ? null : String(docId)} /> : null}
        {note ? (
          <div className="rich-node-note">
            <span className="rich-node-note-label">{messages.content.summaryNote}</span>
            {note}
          </div>
        ) : null}
      </div>
    </section>
  );
}
