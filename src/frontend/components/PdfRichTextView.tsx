import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collectNodeAndDescendantIds } from '../../core/tree.js';
import type { TreeNode } from '../../core/node-model.js';

import { base64ToUint8Array, sourceRangeForSpans, sourceRangesForSpans, sourceSpanAbsoluteStart, sourceSpanKey } from './SourceBlocks.jsx';
import { readSourcePdfData, readSourcePdfHighlights, readSourcePdfSpanRects } from '../data/source-repository.js';
import { depthOf } from '../lib/doc-utils.js';
import { useDisplayScale } from '../lib/display-scale.js';
import { clampPdfZoom, PDF_ZOOM_WHEEL_STEP, readStoredPdfZoomState } from '../lib/pdf-zoom.js';
import type { PdfVisiblePageInfo, PdfZoomMode } from '../lib/pdf-zoom.js';
import { useUiLanguage } from '../../lang/ui.js';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PDF_SCROLL_TOP_PADDING = 72;
const PDF_PAGE_EDGE_PADDING = 22;

// SourceBlocks 那刀已定 SourceSpanLike 接口；这里复述 PdfRichTextView 实际访问的字段集（含 id），
// 用本地接口避免和 SourceBlocks 的 export 联动（同样的 IPC 边界形态，字段全 optional）。
interface PdfSourceSpan {
  id?: string | number;
  sentence_index?: number;
  start_offset?: number;
  end_offset?: number;
  absolute_start_offset?: number;
  absolute_end_offset?: number;
  node_id?: string | null;
  node_address?: string | null;
}

// 后端 IPC 返回的 PDF span 命中矩形（spanHitRects/highlight rects）：
interface PdfRect {
  page_number: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  start_offset?: number;
  end_offset?: number;
  span_id?: string;
  node_id?: string;
  sentence_index?: number;
}

interface PdfPageInfo {
  page_number: number;
  width?: number;
  height?: number;
}

interface PdfRange { start: number; end: number }

// 选区/悬停状态：由 PDF 命中点击 / 外部 selectedNodeId 同步两种来源构造。
type PdfSelectionKind = 'node' | 'span';
type PdfSelectionOrigin = 'pdf' | 'external';
interface PdfSelection {
  key: string;
  kind: PdfSelectionKind;
  nodeId: string | null;
  range: PdfRange;
  ranges: PdfRange[];
  origin: PdfSelectionOrigin;
}

type NodeIdMap = Map<string, TreeNode>;

function rangeForSpan(span: PdfSourceSpan | null | undefined): PdfRange | null {
  return sourceRangeForSpans(span ? [span] : []);
}

function rangeKey(range: PdfRange | null | undefined): string {
  return range ? `${range.start}:${range.end}` : '';
}

function rangesKey(ranges: PdfRange[] | null | undefined): string {
  return (ranges || []).map(rangeKey).join(',');
}

function rectSortKey(left: PdfRect, right: PdfRect): number {
  return Number(left.page_number) - Number(right.page_number) ||
    Number(left.y0) - Number(right.y0) ||
    Number(left.x0) - Number(right.x0);
}

function pdfRectStyle(rect: PdfRect, scale: number): React.CSSProperties {
  return {
    left: `${Number(rect.x0) * scale}px`,
    top: `${Number(rect.y0) * scale}px`,
    width: `${Math.max(1, Number(rect.x1) - Number(rect.x0)) * scale}px`,
    height: `${Math.max(1, Number(rect.y1) - Number(rect.y0)) * scale}px`
  };
}

function groupRectsByPage(rects: PdfRect[] | null | undefined): Map<number, PdfRect[]> {
  const map = new Map<number, PdfRect[]>();
  for (const rect of rects || []) {
    const page = Number(rect.page_number);
    if (!map.has(page)) map.set(page, []);
    map.get(page)!.push(rect);
  }
  return map;
}

function rectOverlapsRange(rect: PdfRect, range: PdfRange | null | undefined): boolean {
  if (!range) return false;
  const start = Number(rect.start_offset);
  const end = Number(rect.end_offset);
  return Number.isFinite(start) && Number.isFinite(end) && start < range.end && end > range.start;
}

function firstRectForRanges(rects: PdfRect[] | null | undefined, ranges: PdfRange[] | null | undefined): PdfRect | null {
  if (!ranges?.length) return null;
  return (rects || [])
    .filter((rect) => ranges.some((range) => rectOverlapsRange(rect, range)))
    .sort(rectSortKey)[0] || null;
}

function sourceSpansForNodeSelection(nodeId: string | number | null | undefined, nodeById: NodeIdMap, sourceSpans: PdfSourceSpan[] | null | undefined): PdfSourceSpan[] {
  if (nodeId === null || nodeId === undefined) return [];
  const ids = new Set<string>();
  const node = nodeById.get(String(nodeId));
  if (node) collectNodeAndDescendantIds(node, ids);
  ids.add(String(nodeId));
  return (sourceSpans || [])
    .filter((span) => ids.has(String(span.node_id)))
    .sort((left, right) => sourceSpanAbsoluteStart(left) - sourceSpanAbsoluteStart(right));
}

function nodeSelection(nodeId: string | null | undefined, nodeById: NodeIdMap, sourceSpans: PdfSourceSpan[] | null | undefined, origin: PdfSelectionOrigin): PdfSelection | null {
  if (nodeId === null || nodeId === undefined) return null;
  const spans = sourceSpansForNodeSelection(nodeId, nodeById, sourceSpans);
  const range = sourceRangeForSpans(spans);
  const ranges = sourceRangesForSpans(spans);
  if (!range || ranges.length === 0) return null;
  return { key: `node:${nodeId}`, kind: 'node', nodeId, range, ranges, origin };
}

function spanSelection(span: PdfSourceSpan | null | undefined, origin: PdfSelectionOrigin): PdfSelection | null {
  const range = rangeForSpan(span);
  const ranges = sourceRangesForSpans(span ? [span] : []);
  if (!range || ranges.length === 0) return null;
  const key = sourceSpanKey(span) || `${span?.node_id ?? ''}:${span?.sentence_index ?? ''}:${rangeKey(range)}`;
  return { key: `span:${key}`, kind: 'span', nodeId: span?.node_id ?? null, range, ranges, origin };
}

// currentDoc 投影里跟 PDF 渲染相关的子集；shell-layer 形态（IPC 边界），不强绑 useDocumentState 的完整投影。
interface PdfCurrentDoc {
  tree?: TreeNode | null;
  sourceWindow?: { sourceSpans?: PdfSourceSpan[] } | null;
  sourceSpans?: PdfSourceSpan[];
  sourcePdfPages?: PdfPageInfo[];
}

export interface PdfRichTextViewProps {
  currentDoc: PdfCurrentDoc | null | undefined;
  docId: string;
  selectedNodeId: string | null | undefined;
  setSelectedNodeId: (id: string | null) => void;
  nodeById: NodeIdMap;
  /** 受控缩放：状态栏缩放控件（WorkspacePane）持有状态时传入；缺省走内部非受控。 */
  scale?: number;
  /** 缩放模式：custom=固定百分比；fit-width/fit-page=随容器尺寸解析，窗口变化自动重算。 */
  zoomMode?: PdfZoomMode;
  /** 用户主动改缩放（Ctrl+滚轮等）时上报新档位，父级应同时把模式切回 custom。 */
  onScaleChange?: (scale: number) => void;
  /** 实际生效缩放（含 fit 解析结果）变化时上报，仅用于百分比显示/持久化，不应改模式。 */
  onResolvedScaleChange?: (scale: number) => void;
  /** 可见页变化上报，驱动状态栏页码指示；PDF 未就绪/卸载时报 null。 */
  onVisiblePageChange?: (info: PdfVisiblePageInfo | null) => void;
}

export function PdfRichTextView({
  currentDoc,
  docId,
  selectedNodeId,
  setSelectedNodeId,
  nodeById,
  scale: scaleProp,
  zoomMode: zoomModeProp,
  onScaleChange,
  onResolvedScaleChange,
  onVisiblePageChange
}: PdfRichTextViewProps) {
  const { messages } = useUiLanguage();
  const sourceSpans: PdfSourceSpan[] = currentDoc?.sourceWindow?.sourceSpans || currentDoc?.sourceSpans || [];
  const sourcePdfPages: PdfPageInfo[] = currentDoc?.sourcePdfPages || [];
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfError, setPdfError] = useState<string>('');
  const [selectionRects, setSelectionRects] = useState<PdfRect[]>([]);
  const [hoverRects, setHoverRects] = useState<PdfRect[]>([]);
  const [spanHitRects, setSpanHitRects] = useState<PdfRect[]>([]);
  const [hoverRanges, setHoverRanges] = useState<PdfRange[] | null>(null);
  const [selection, setSelection] = useState<PdfSelection | null>(null);
  const pageStackRef = useRef<HTMLElement | null>(null);
  const pdfScrollKeyRef = useRef<string>('');
  const [innerScale, setInnerScale] = useState<number>(() => readStoredPdfZoomState().value);
  const zoomMode: PdfZoomMode = zoomModeProp ?? 'custom';
  const [fitScale, setFitScale] = useState<number | null>(null);
  const baseScale = clampPdfZoom(Number(scaleProp ?? innerScale));
  const scale = zoomMode === 'custom' ? baseScale : clampPdfZoom(Number(fitScale ?? baseScale));
  // 出图密度单例：整篇文档共享一次 useDisplayScale（DPR 监听 + zoomFactor 轮询），
  // 经 props 传给各 PdfPageView。若在每页组件里各自调，N 页就是 N 个 interval +
  // focus 监听 + matchMedia 监听（大 PDF 资源放大）。
  const { outputScale } = useDisplayScale();
  // wheel 监听只挂一次，经 ref 读最新缩放值，避免闭包吃旧值。
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const applyScale = useCallback((next: number) => {
    const clamped = clampPdfZoom(next);
    if (onScaleChange) onScaleChange(clamped);
    else setInnerScale(clamped);
  }, [onScaleChange]);

  // fit 模式：按容器尺寸解析缩放并持续跟随（ResizeObserver）；滑条区域留边与 .pdf-page-stack padding 对齐。
  useEffect(() => {
    if (zoomMode === 'custom' || !pdfDoc) return () => {};
    const container = pageStackRef.current;
    if (!container) return () => {};
    const compute = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return; // 标签页隐藏中
      const first = sourcePdfPages[0];
      const pageWidth = Number(first?.width || 595);
      const pageHeight = Number(first?.height || 842);
      const availWidth = container.clientWidth - 56;  // padding 28×2
      const availHeight = container.clientHeight - 40;
      if (availWidth <= 0 || availHeight <= 0) return;
      const fitted = zoomMode === 'fit-width'
        ? availWidth / pageWidth
        : Math.min(availWidth / pageWidth, availHeight / pageHeight);
      const clamped = clampPdfZoom(fitted);
      setFitScale((prev) => (prev !== null && Math.abs(prev - clamped) < 0.005 ? prev : clamped));
    };
    compute();
    const resizeObserver = new ResizeObserver(compute);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [zoomMode, pdfDoc, sourcePdfPages]);

  // 实际生效缩放（含 fit 解析结果）上报给状态栏百分比；custom 模式下与父级值相同，父级按值去重不会回环。
  useEffect(() => {
    onResolvedScaleChange?.(scale);
  }, [scale, onResolvedScaleChange]);

  // Ctrl + 滚轮缩放，手感对齐桌面 PDF 查看器；wheel 默认是 passive 监听，
  // React onWheel 里 preventDefault 不可靠，必须原生挂 non-passive。
  useEffect(() => {
    const container = pageStackRef.current;
    if (!container) return () => {};
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      applyScale(scaleRef.current + (event.deltaY < 0 ? PDF_ZOOM_WHEEL_STEP : -PDF_ZOOM_WHEEL_STEP));
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [applyScale]);

  // 可见页上报：取滚动位置 + 视口 1/3 线所在的页为「当前页」。
  // ResizeObserver 管两件事：页壳高度随缩放变、标签页 display 切换后容器从 0 恢复尺寸。
  useEffect(() => {
    const container = pageStackRef.current;
    if (!container || !pdfDoc) {
      onVisiblePageChange?.(null);
      return () => {};
    }
    let raf = 0;
    const report = () => {
      raf = 0;
      if (container.clientHeight === 0) return; // 所在标签页隐藏中，报了也是脏数据
      const shells = container.querySelectorAll<HTMLElement>('.pdf-page-shell');
      if (shells.length === 0) return;
      const marker = container.scrollTop + Math.min(container.clientHeight / 3, 240);
      let current = 1;
      shells.forEach((shell) => {
        if (shell.offsetTop <= marker) current = Number(shell.dataset.pageNumber) || current;
      });
      onVisiblePageChange?.({ page: current, total: shells.length });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(report);
    };
    report();
    container.addEventListener('scroll', schedule, { passive: true });
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(container);
    return () => {
      container.removeEventListener('scroll', schedule);
      resizeObserver.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pdfDoc, sourcePdfPages.length, scale, onVisiblePageChange]);

  const spanByKey = useMemo<Map<string, PdfSourceSpan>>(() => {
    const map = new Map<string, PdfSourceSpan>();
    for (const span of sourceSpans || []) {
      const key = sourceSpanKey(span);
      if (key) map.set(String(key), span);
      if (span?.id) map.set(String(span.id), span);
    }
    return map;
  }, [sourceSpans]);
  const hitRectsByPage = useMemo<Map<number, PdfRect[]>>(() => {
    const map = new Map<number, PdfRect[]>();
    for (const rect of spanHitRects || []) {
      const page = Number(rect.page_number);
      if (!map.has(page)) map.set(page, []);
      map.get(page)!.push(rect);
    }
    const rectDepth = (rect: PdfRect) => depthOf(String(nodeById.get(String(rect.node_id))?.address || '1'));
    for (const rects of map.values()) rects.sort((left, right) => rectDepth(left) - rectDepth(right));
    return map;
  }, [nodeById, spanHitRects]);

  useEffect(() => {
    let alive = true;
    setPdfDoc(null);
    setPdfError('');
    setSpanHitRects([]);
    setSelectionRects([]);
    setHoverRects([]);
    setHoverRanges(null);
    setSelection(null);
    pdfScrollKeyRef.current = '';
    readSourcePdfData(docId)
      .then(async (payload) => {
        if (!alive) return;
        const data = payload as { base64?: string } | null | undefined;
        if (!data?.base64) {
          setPdfError(messages.content.pdfUnavailable);
          return;
        }
        const pdf = await getDocument({
          data: base64ToUint8Array(data.base64)
        }).promise;
        if (alive) setPdfDoc(pdf);
      })
      .catch((error) => {
        if (alive) setPdfError(String((error as { message?: string } | null | undefined)?.message || error));
      });
    return () => { alive = false; };
  }, [docId, messages.content.pdfUnavailable]);

  useEffect(() => {
    let alive = true;
    readSourcePdfSpanRects(docId)
      .then((rects) => {
        if (alive) setSpanHitRects((rects as PdfRect[] | null | undefined) || []);
      })
      .catch(() => {
        if (alive) setSpanHitRects([]);
      });
    return () => { alive = false; };
  }, [docId]);

  const externalSelection = useMemo(() => (
    nodeSelection(selectedNodeId, nodeById, sourceSpans, 'external')
  ), [selectedNodeId, nodeById, sourceSpans]);
  const activeSelection = useMemo(() => {
    if (!selectedNodeId) return null;
    if (selection?.nodeId !== null && selection?.nodeId !== undefined && String(selection.nodeId) === String(selectedNodeId)) {
      return selection;
    }
    return externalSelection;
  }, [selection, selectedNodeId, externalSelection]);
  // 选区与悬停分两层互不替换：选区是常驻淡色底（父节点选中会覆盖全部
  // 后代正文，染太亮等于"全选"），悬停是亮色跟手层（指哪亮哪）。
  // 合并成一个 ranges 会让悬停反复抹掉/恢复选区底色，大面积闪烁。
  const selectionRanges = activeSelection?.ranges || null;
  const selectionRangesKey = rangesKey(selectionRanges);
  const hoverRangesKey = rangesKey(hoverRanges);

  useEffect(() => {
    let alive = true;
    if (!selectionRanges?.length) {
      setSelectionRects([]);
      return () => { alive = false; };
    }
    readSourcePdfHighlights({
      docId,
      ranges: selectionRanges.map((range) => ({ start: range.start, end: range.end }))
    }).then((rects) => {
      if (alive) setSelectionRects((rects as PdfRect[] | null | undefined) || []);
    }).catch(() => {
      if (alive) setSelectionRects([]);
    });
    return () => { alive = false; };
  }, [docId, selectionRangesKey]);

  useEffect(() => {
    let alive = true;
    if (!hoverRanges?.length) {
      setHoverRects([]);
      return () => { alive = false; };
    }
    readSourcePdfHighlights({
      docId,
      ranges: hoverRanges.map((range) => ({ start: range.start, end: range.end }))
    }).then((rects) => {
      if (alive) setHoverRects((rects as PdfRect[] | null | undefined) || []);
    }).catch(() => {
      if (alive) setHoverRects([]);
    });
    return () => { alive = false; };
  }, [docId, hoverRangesKey]);

  const selectionRectsByPage = useMemo(() => groupRectsByPage(selectionRects), [selectionRects]);
  const hoverRectsByPage = useMemo(() => groupRectsByPage(hoverRects), [hoverRects]);

  const pages = sourcePdfPages.length > 0
    ? sourcePdfPages
    : Array.from({ length: pdfDoc?.numPages || 0 }, (_, index) => ({
      page_number: index + 1,
      width: 595,
      height: 842
    }));

  // 取消选中必须连 hover 一起清：再次单击取消时鼠标还停在原句上，
  // hover 高亮不清的话取消前后画面一个像素都不变，看起来就是"取消没生效"。
  function clearSelection() {
    setSelection(null);
    setHoverRanges(null);
    pdfScrollKeyRef.current = '';
    setSelectedNodeId(null);
  }

  function scrollPdfToRect(rect: PdfRect | null | undefined): boolean {
    const container = pageStackRef.current;
    const page = container?.querySelector?.(`[data-page-number="${Number(rect?.page_number)}"]`) as HTMLElement | null;
    if (!container || !page || !rect) return false;
    const targetTop = page.offsetTop + Number(rect.y0 || 0) * scale;
    const pageTop = page.offsetTop;
    container.scrollTo({
      left: container.scrollLeft,
      top: Math.max(0, Math.max(pageTop - PDF_PAGE_EDGE_PADDING, targetTop - PDF_SCROLL_TOP_PADDING)),
      behavior: 'auto'
    });
    return true;
  }

  function spanFromHitRect(rect: PdfRect): PdfSourceSpan {
    const fallback: PdfSourceSpan = {
      id: rect.span_id,
      node_id: rect.node_id ?? null,
      sentence_index: rect.sentence_index,
      start_offset: rect.start_offset,
      end_offset: rect.end_offset
    };
    return spanByKey.get(String(rect.span_id || '')) || spanByKey.get(String(sourceSpanKey(fallback))) || fallback;
  }

  function selectPdfSpan(rect: PdfRect) {
    const span = spanFromHitRect(rect);
    const next = spanSelection(span, 'pdf');
    if (!next) return;
    if (activeSelection?.key === next.key) {
      clearSelection();
      return;
    }
    setSelection(next);
    setSelectedNodeId(span.node_id || null);
  }

  function hoverPdfSpan(rect: PdfRect) {
    const span = spanFromHitRect(rect);
    setHoverRanges(sourceRangesForSpans(span ? [span] : []));
  }

  useEffect(() => {
    if (!activeSelection || activeSelection.origin === 'pdf') return;
    const scrollKey = `${activeSelection.origin}:${activeSelection.key}`;
    if (pdfScrollKeyRef.current === scrollKey) return;
    const firstRect = firstRectForRanges(spanHitRects, activeSelection.ranges);
    if (firstRect && scrollPdfToRect(firstRect)) pdfScrollKeyRef.current = scrollKey;
  }, [activeSelection, spanHitRects, pdfDoc, pages.length, scale]);

  return (
    <div className="rich-surface pdf-rich-surface">
      <section className="pdf-page-stack" ref={pageStackRef} onClick={clearSelection}>
        {!pdfDoc && !pdfError ? <div className="empty-state">{messages.content.pdfLoading}</div> : null}
        {pdfError ? <div className="empty-state">{pdfError}</div> : null}
        {pdfDoc ? pages.map((page) => (
          <PdfPageView
            key={page.page_number}
            pdfDoc={pdfDoc}
            pageInfo={page}
            scale={scale}
            outputScale={outputScale}
            selectionHighlights={selectionRectsByPage.get(Number(page.page_number)) || []}
            hoverHighlights={hoverRectsByPage.get(Number(page.page_number)) || []}
            hitRects={hitRectsByPage.get(Number(page.page_number)) || []}
            onHitHover={hoverPdfSpan}
            onHitLeave={() => {
              setHoverRanges(null);
            }}
            onHitClick={selectPdfSpan}
          />
        )) : null}
      </section>
    </div>
  );
}

export interface PdfPageViewProps {
  pdfDoc: PDFDocumentProxy;
  pageInfo: PdfPageInfo;
  scale: number;
  outputScale: number;
  selectionHighlights?: PdfRect[];
  hoverHighlights?: PdfRect[];
  hitRects?: PdfRect[];
  onHitHover?: (rect: PdfRect) => void;
  onHitLeave?: () => void;
  onHitClick?: (rect: PdfRect) => void;
}

export function PdfPageView({ pdfDoc, pageInfo, scale, outputScale, selectionHighlights = [], hoverHighlights = [], hitRects = [], onHitHover, onHitLeave, onHitClick }: PdfPageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const pageNumber = Number(pageInfo.page_number);
  // 出图密度 = devicePixelRatio × Electron 界面缩放（zoomFactor），由 PdfRichTextView
  // 单例算好经 props 传入（每页各自调 useDisplayScale 会是 N 个 interval/监听的资源放大）。

  useEffect(() => {
    // pdfjs 的 PDFPageProxy.render 返回 RenderTask；用 ReturnType 取签名免去显式 import RenderTask。
    type RenderTaskLike = ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>;
    let renderTask: RenderTaskLike | null = null;
    let cancelled = false;
    const canvas = canvasRef.current;
    const shell = shellRef.current;
    if (!canvas || !shell || !pdfDoc || !pageNumber) return () => {};

    // 先把旧位图按新 CSS 尺寸拉伸占位（不动 backing store 就不会清屏），
    // 可见页随后立即高清重绘，屏外页滚近了再绘——整书逐页 eager 重绘会让缩放卡死。
    canvas.style.width = `${Number(pageInfo.width || 595) * scale}px`;
    canvas.style.height = `${Number(pageInfo.height || 842) * scale}px`;

    const renderPage = async (attempt = 0): Promise<void> => {
      const page = await pdfDoc.getPage(pageNumber);
      if (cancelled) return;
      const cssViewport = page.getViewport({ scale });
      // HiDPI：直接用放大 viewport 出图（不走 transform 参数，少一层不确定），
      // backing store 按物理像素分配、CSS 尺寸不变，合成器 1:1 贴图才不会发虚。
      // 总倍率封顶 4.5：极端组合（300% 缩放 × 高 DPR）下保住显存。
      const pixelScale = Math.min(4.5, scale * outputScale);
      const pixelViewport = page.getViewport({ scale: pixelScale });
      // 上下文只给 { alpha: false }（页面不透明、pdfjs 默认铺白底）；
      // 绝不传 desynchronized——低延迟画布在 Windows + 小数 DPR 下会被低质量合成。
      // canvas.getContext('2d', ...) 返回 union RenderingContext；'2d' 实际就是 CanvasRenderingContext2D。
      const context = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null;
      if (!context) return;
      canvas.width = Math.max(1, Math.round(pixelViewport.width));
      canvas.height = Math.max(1, Math.round(pixelViewport.height));
      canvas.style.width = `${cssViewport.width}px`;
      canvas.style.height = `${cssViewport.height}px`;
      try {
        renderTask = page.render({ canvas, canvasContext: context, viewport: pixelViewport });
        await renderTask.promise;
      } catch (error) {
        if (cancelled) return;
        // pdfjs 同一 canvas 不允许并发渲染；缩放连调时上一帧可能还没释放。
        // 该错误以 promise 拒绝的形式异步到达——让出事件循环等旧任务收尾后重试一次，
        // 否则这次缩放就永远停留在拉伸旧位图的糊态。
        const message = String((error as { message?: unknown } | null)?.message || error || '');
        if (attempt < 2 && /same canvas/i.test(message)) {
          renderTask = null;
          await new Promise((resolve) => setTimeout(resolve, 80));
          if (!cancelled) await renderPage(attempt + 1);
        }
      }
    };

    if (typeof IntersectionObserver !== 'function') {
      void renderPage();
      return () => {
        cancelled = true;
        if (renderTask) renderTask.cancel();
      };
    }
    // root 缺省 = 窗口视口，嵌套滚动容器的裁剪也参与计算；留 800px 余量让相邻页提前出图。
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void renderPage();
    }, { rootMargin: '800px 0px' });
    observer.observe(shell);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (renderTask) renderTask.cancel();
    };
  }, [pdfDoc, pageNumber, scale, outputScale, pageInfo.width, pageInfo.height]);

  const width = Number(pageInfo.width || 595) * scale;
  const height = Number(pageInfo.height || 842) * scale;

  return (
    <div className="pdf-page-shell" data-page-number={pageNumber} ref={shellRef} style={{ width, minHeight: height }}>
      <canvas ref={canvasRef} className="pdf-page-canvas" />
      <div className="pdf-highlight-layer">
        {(selectionHighlights || []).map((rect, index) => (
          <span
            key={`sel-${pageNumber}-${index}`}
            className="pdf-highlight-rect is-selection"
            style={pdfRectStyle(rect, scale)}
          />
        ))}
        {(hoverHighlights || []).map((rect, index) => (
          <span
            key={`hover-${pageNumber}-${index}`}
            className="pdf-highlight-rect"
            style={pdfRectStyle(rect, scale)}
          />
        ))}
      </div>
      <div className="pdf-hit-layer">
        {(hitRects || []).map((rect, index) => (
          <span
            key={`${pageNumber}-${rect.span_id || rect.sentence_index}-${index}`}
            role="button"
            tabIndex={-1}
            className="pdf-hit-rect"
            style={pdfRectStyle(rect, scale)}
            onMouseEnter={() => onHitHover?.(rect)}
            onMouseLeave={() => onHitLeave?.()}
            onClick={(event) => {
              event.stopPropagation();
              onHitClick?.(rect);
            }}
          />
        ))}
      </div>
    </div>
  );
}
