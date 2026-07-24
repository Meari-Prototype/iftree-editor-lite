// PDF 阅读面缩放：档位常量 + 钳制 + 模式 + 持久化。
// 供 PdfRichTextView（渲染消费）与 WorkspacePane（状态栏缩放控件持状态）两处共用，避免各存一份。

import { readPdfZoomPolicy } from './ui-prefs.js';

export const PDF_ZOOM_DEFAULT = 1.25;
export const PDF_ZOOM_MIN = 0.5;
export const PDF_ZOOM_MAX = 3;
// ± 按钮与 Ctrl+滚轮的步进（10% 一档）。
export const PDF_ZOOM_STEP = 0.1;
export const PDF_ZOOM_WHEEL_STEP = 0.1;
export const PDF_ZOOM_STORAGE_KEY = 'iftree.pdfZoom';

// 下拉菜单里的固定档位（对齐桌面查看器习惯）。
export const PDF_ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

// custom=固定百分比；fit-width/fit-page=随容器尺寸解析（窗口变化会重算）。
export type PdfZoomMode = 'custom' | 'fit-width' | 'fit-page';

export interface PdfZoomState {
  mode: PdfZoomMode;
  /** custom 模式下的档位；fit 模式下是最近一次解析出的百分比（仅用于显示/持久化）。 */
  value: number;
}

const PDF_ZOOM_MODES: readonly string[] = ['custom', 'fit-width', 'fit-page'];

// 钳制到档位区间并归一到 0.01 精度——滑杆 step 0.05 会产生 1.7999999… 这类浮点尾巴。
export function clampPdfZoom(value: number): number {
  if (!Number.isFinite(value)) return PDF_ZOOM_DEFAULT;
  const clamped = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, value));
  return Math.round(clamped * 100) / 100;
}

export function readStoredPdfZoomState(): PdfZoomState {
  const fallback: PdfZoomState = { mode: 'custom', value: PDF_ZOOM_DEFAULT };
  // 初始缩放策略（设置屏「常规 → PDF 默认缩放」）：固定档位直接返回初始值，
  // 'last' 才读上次记录；运行期缩放照常写 localStorage，策略只管初始值。
  const policy = readPdfZoomPolicy();
  if (policy === 'fit-width') return { mode: 'fit-width', value: PDF_ZOOM_DEFAULT };
  if (policy === 'fixed-100') return { mode: 'custom', value: 1 };
  if (policy === 'fixed-125') return { mode: 'custom', value: PDF_ZOOM_DEFAULT };
  try {
    const raw = globalThis.localStorage?.getItem(PDF_ZOOM_STORAGE_KEY);
    if (!raw) return fallback;
    // 旧版存的是纯数字字符串，迁移为 custom 模式。
    if (!raw.startsWith('{')) return { mode: 'custom', value: clampPdfZoom(Number(raw)) };
    const parsed = JSON.parse(raw) as Partial<PdfZoomState> | null;
    return {
      mode: PDF_ZOOM_MODES.includes(String(parsed?.mode)) ? (parsed?.mode as PdfZoomMode) : 'custom',
      value: clampPdfZoom(Number(parsed?.value))
    };
  } catch {
    return fallback;
  }
}

export function writeStoredPdfZoomState(state: PdfZoomState): void {
  try {
    globalThis.localStorage?.setItem(PDF_ZOOM_STORAGE_KEY, JSON.stringify(state));
  } catch { /* 私密模式等写不进去就跳过 */ }
}

// 状态栏页码指示的上报形态（PdfRichTextView → WorkspacePane）。
export interface PdfVisiblePageInfo {
  page: number;
  total: number;
}
