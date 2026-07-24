import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { clampVerticalSplitSize } from '../../core/sidebar-split.js';
import {
  clamp,
  DEFAULT_SIDEBAR_WIDTH,
  MIN_DOC_PANEL_HEIGHT,
  MIN_LEFT_WIDTH,
  MIN_OUTLINE_PANEL_HEIGHT,
  MIN_RIGHT_WIDTH,
  PANEL_SPLIT_RAIL_SIZE,
  RIBBON_WIDTH
} from '../lib/doc-utils.js';
import { startResizeRailGesture } from '../lib/mindmap-utils.js';

// 侧栏拉动范围：分隔条最多拖到距对面边缘 10% 窗口宽的位置（中栏只保 10% 最小宽度）。
// 固定像素上限（右 760 / 左 560）在大屏上会把分隔条卡死在中段；改为纯比例约束，
// 两侧逻辑对称。绝对上限仅作超宽屏兜底。
const DIVIDER_EDGE_GAP_RATIO = 0.1;
const PANEL_ABSOLUTE_MAX = 4096;

function edgeGapFor(windowWidth: number): number {
  return Math.floor(windowWidth * DIVIDER_EDGE_GAP_RATIO);
}

function maxRightPanelWidth(windowWidth: number, leftWidth: number, leftCollapsed: boolean): number {
  const occupied = RIBBON_WIDTH + (leftCollapsed ? 0 : leftWidth) + edgeGapFor(windowWidth);
  return Math.max(MIN_RIGHT_WIDTH, Math.min(PANEL_ABSOLUTE_MAX, windowWidth - occupied));
}

function maxLeftPanelWidth(windowWidth: number, rightWidth: number, rightCollapsed: boolean): number {
  const occupied = RIBBON_WIDTH + (rightCollapsed ? 0 : rightWidth) + edgeGapFor(windowWidth);
  return Math.max(MIN_LEFT_WIDTH, Math.min(PANEL_ABSOLUTE_MAX, windowWidth - occupied));
}

export function useLayout() {
  const [leftWidth, setLeftWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [docPanelHeight, setDocPanelHeight] = useState<number | null>(null);
  const [outlineCollapsedDown, setOutlineCollapsedDown] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  // 右侧 LLM 栏默认收起：初始界面只留 文件 + 正文，需要时经 header 按钮或 Ctrl+Shift+B 展开
  const [rightCollapsed, setRightCollapsed] = useState(true);

  const leftSidebarRef = useRef<HTMLDivElement | null>(null);
  const docPanelRef = useRef<HTMLDivElement | null>(null);
  const docPanelHeightBeforeCollapseRef = useRef<number | null>(null);

  const toggleLeft = useCallback(() => {
    setLeftCollapsed((value) => !value);
  }, []);

  const toggleRight = useCallback(() => {
    setRightCollapsed((value) => !value);
  }, []);

  // 窗口收窄时把两侧栏压回动态上限内，避免大屏拉宽的侧栏在小窗口里把中栏挤没。
  useEffect(() => {
    const onResize = () => {
      const windowWidth = globalThis.innerWidth || 1920;
      setRightWidth((width) => Math.min(width, maxRightPanelWidth(windowWidth, leftWidth, leftCollapsed)));
      setLeftWidth((width) => Math.min(width, maxLeftPanelWidth(windowWidth, rightWidth, rightCollapsed)));
    };
    globalThis.addEventListener?.('resize', onResize);
    return () => globalThis.removeEventListener?.('resize', onResize);
  }, [leftWidth, leftCollapsed, rightWidth, rightCollapsed]);

  const toggleOutlineCollapseDown = useCallback(() => {
    const sidebar = leftSidebarRef.current;
    const docPanel = docPanelRef.current;
    if (!sidebar || !docPanel) return;
    if (outlineCollapsedDown) {
      setDocPanelHeight(docPanelHeightBeforeCollapseRef.current);
      setOutlineCollapsedDown(false);
      return;
    }

    const sidebarRect = sidebar.getBoundingClientRect();
    const docRect = docPanel.getBoundingClientRect();
    const docTop = docRect.top - sidebarRect.top;
    const availableSize = sidebarRect.height - docTop - PANEL_SPLIT_RAIL_SIZE;
    docPanelHeightBeforeCollapseRef.current = docPanelHeight;
    setDocPanelHeight(Math.max(MIN_DOC_PANEL_HEIGHT, availableSize));
    setOutlineCollapsedDown(true);
  }, [docPanelHeight, outlineCollapsedDown]);

  const startSidebarResize = useCallback((
    side: 'left' | 'right',
    event: PointerEvent,
    options: { clickToToggle?: boolean } = {}
  ) => {
    const isLeft = side === 'left';
    const isCollapsed = isLeft ? leftCollapsed : rightCollapsed;
    const toggleSidebar = isLeft ? toggleLeft : toggleRight;
    const startWidth = isLeft ? leftWidth : rightWidth;
    const resizeClass = isLeft ? 'is-resizing-left-sidebar' : 'is-resizing-right-sidebar';
    const clickToToggle = options.clickToToggle !== false;

    startResizeRailGesture(event, {
      collapsed: isCollapsed,
      onExpand: toggleSidebar,
      bodyClasses: ['is-resizing-horizontal', resizeClass],
      onDrag: (moveEvent, { startX }) => {
        const delta = moveEvent.clientX - startX;
        const windowWidth = globalThis.innerWidth || 1920;
        if (isLeft) {
          setLeftCollapsed(false);
          setLeftWidth(clamp(startWidth + delta, MIN_LEFT_WIDTH, maxLeftPanelWidth(windowWidth, rightWidth, rightCollapsed)));
        } else {
          setRightCollapsed(false);
          setRightWidth(clamp(startWidth - delta, MIN_RIGHT_WIDTH, maxRightPanelWidth(windowWidth, leftWidth, leftCollapsed)));
        }
      },
      onClick: clickToToggle ? toggleSidebar : undefined
    });
  }, [leftCollapsed, leftWidth, rightCollapsed, rightWidth, toggleLeft, toggleRight]);

  const startDocOutlineResize = useCallback((event: PointerEvent) => {
    const sidebar = leftSidebarRef.current;
    const docPanel = docPanelRef.current;
    if (!sidebar || !docPanel) return;

    const sidebarRect = sidebar.getBoundingClientRect();
    const docRect = docPanel.getBoundingClientRect();
    const docTop = docRect.top - sidebarRect.top;
    const availableSize = sidebarRect.height - docTop - PANEL_SPLIT_RAIL_SIZE;
    const startSize = docRect.height;

    startResizeRailGesture(event, {
      collapsed: outlineCollapsedDown,
      onExpand: toggleOutlineCollapseDown,
      bodyClasses: ['is-resizing-vertical', 'is-resizing-left-split'],
      onDrag: (moveEvent, { startY }) => {
        setOutlineCollapsedDown(false);
        setDocPanelHeight(clampVerticalSplitSize({
          startSize,
          startY,
          currentY: moveEvent.clientY,
          availableSize,
          minTop: MIN_DOC_PANEL_HEIGHT,
          minBottom: MIN_OUTLINE_PANEL_HEIGHT
        }));
      },
      onClick: toggleOutlineCollapseDown
    });
  }, [outlineCollapsedDown, toggleOutlineCollapseDown]);

  return useMemo(() => ({
    leftWidth,
    rightWidth,
    leftCollapsed,
    rightCollapsed,
    docPanelHeight,
    outlineCollapsedDown,
    leftSidebarRef,
    docPanelRef,
    startSidebarResize,
    startDocOutlineResize,
    toggleLeft,
    toggleRight,
    toggleOutlineCollapseDown
  }), [
    docPanelHeight,
    leftCollapsed,
    leftWidth,
    outlineCollapsedDown,
    rightCollapsed,
    rightWidth,
    startDocOutlineResize,
    startSidebarResize,
    toggleLeft,
    toggleOutlineCollapseDown,
    toggleRight
  ]);
}
