// 界面偏好（纯 localStorage）：Agent 默认权限、PDF 默认缩放策略、树视图偏好。
// 读写模式对齐 lib/theme.ts——读取做白名单归一化，写入 try/catch（localStorage 不可用时静默）。

const AGENT_DEFAULT_MODE_STORAGE_KEY = 'iftree.agentDefaultMode';
const AGENT_MODES = ['qa', 'edit', 'full'] as const;
export type AgentDefaultMode = (typeof AGENT_MODES)[number];

export function readAgentDefaultMode(): AgentDefaultMode {
  try {
    const stored = localStorage.getItem(AGENT_DEFAULT_MODE_STORAGE_KEY);
    return AGENT_MODES.includes(stored as AgentDefaultMode) ? (stored as AgentDefaultMode) : 'qa';
  } catch {
    return 'qa';
  }
}

export function writeAgentDefaultMode(mode: AgentDefaultMode): void {
  try {
    localStorage.setItem(AGENT_DEFAULT_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时偏好仅在本次会话生效
  }
}

const PDF_ZOOM_POLICY_STORAGE_KEY = 'iftree.pdfZoomPolicy';
const PDF_ZOOM_POLICIES = ['last', 'fit-width', 'fixed-100', 'fixed-125'] as const;
export type PdfZoomPolicy = (typeof PDF_ZOOM_POLICIES)[number];

export function readPdfZoomPolicy(): PdfZoomPolicy {
  try {
    const stored = localStorage.getItem(PDF_ZOOM_POLICY_STORAGE_KEY);
    return PDF_ZOOM_POLICIES.includes(stored as PdfZoomPolicy) ? (stored as PdfZoomPolicy) : 'last';
  } catch {
    return 'last';
  }
}

export function writePdfZoomPolicy(policy: PdfZoomPolicy): void {
  try {
    localStorage.setItem(PDF_ZOOM_POLICY_STORAGE_KEY, policy);
  } catch {
    // localStorage 不可用时偏好仅在本次会话生效
  }
}

// ─── 树视图偏好 ─────────────────────────────────────────
// 即时生效通道：设置面板写完任一偏好即派发本事件，C2DMapView / 摘要备注状态监听后重读。
export const TREE_VIEW_PREFS_CHANGED_EVENT = 'iftree:tree-view-prefs-changed';

const TREE_DEFAULT_COLUMN_WIDTH_STORAGE_KEY = 'iftree.treeDefaultColumnWidth';

// 树视图默认列宽（px）：0 = 自动（视口宽度的 30%，下限 180px）；非法值归 0。
export function readTreeDefaultColumnWidth(): number {
  try {
    const stored = localStorage.getItem(TREE_DEFAULT_COLUMN_WIDTH_STORAGE_KEY);
    if (stored === null) return 0;
    const value = Math.floor(Number(stored));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeTreeDefaultColumnWidth(width: number): void {
  try {
    const value = Math.floor(Number(width));
    localStorage.setItem(TREE_DEFAULT_COLUMN_WIDTH_STORAGE_KEY, String(Number.isFinite(value) && value > 0 ? value : 0));
  } catch {
    // localStorage 不可用时偏好仅在本次会话生效
  }
}

const TREE_COLUMN_GAP_STORAGE_KEY = 'iftree.treeColumnGap';
const TREE_COLUMN_GAP_DEFAULT = 40;

// 相邻两列的间隔（px）：默认 40，读取钳在 16–120。
export function readTreeColumnGap(): number {
  try {
    const stored = localStorage.getItem(TREE_COLUMN_GAP_STORAGE_KEY);
    if (stored === null) return TREE_COLUMN_GAP_DEFAULT;
    const value = Math.floor(Number(stored));
    if (!Number.isFinite(value)) return TREE_COLUMN_GAP_DEFAULT;
    return Math.min(120, Math.max(16, value));
  } catch {
    return TREE_COLUMN_GAP_DEFAULT;
  }
}

export function writeTreeColumnGap(gap: number): void {
  try {
    const value = Math.floor(Number(gap));
    const clamped = Number.isFinite(value) ? Math.min(120, Math.max(16, value)) : TREE_COLUMN_GAP_DEFAULT;
    localStorage.setItem(TREE_COLUMN_GAP_STORAGE_KEY, String(clamped));
  } catch {
    // localStorage 不可用时偏好仅在本次会话生效
  }
}

const TREE_SHOW_NOTES_DEFAULT_STORAGE_KEY = 'iftree.treeShowNotesDefault';

// 打开文档时摘要备注的默认显隐；逐文档手动切换过（有持久值）的文档不受其影响。
// 出厂默认 true：与旧版硬编码"默认显示备注"的行为对齐，避免老用户升级后备注凭空消失。
export function readTreeShowNotesDefault(): boolean {
  try {
    const raw = localStorage.getItem(TREE_SHOW_NOTES_DEFAULT_STORAGE_KEY);
    if (raw === null || raw === '') return true;
    return raw === '1';
  } catch {
    return true;
  }
}

export function writeTreeShowNotesDefault(visible: boolean): void {
  try {
    localStorage.setItem(TREE_SHOW_NOTES_DEFAULT_STORAGE_KEY, visible ? '1' : '0');
  } catch {
    // localStorage 不可用时偏好仅在本次会话生效
  }
}

const TREE_DEFAULT_DEPTH_STORAGE_KEY = 'iftree.treeDefaultDepth';

// 新文档默认展开深度：0 = 内置默认；合法值 1–6，其余归 0。
export function readTreeDefaultDepth(): number {
  try {
    const stored = localStorage.getItem(TREE_DEFAULT_DEPTH_STORAGE_KEY);
    if (stored === null) return 0;
    const value = Math.floor(Number(stored));
    return Number.isFinite(value) && value >= 1 && value <= 6 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeTreeDefaultDepth(depth: number): void {
  try {
    const value = Math.floor(Number(depth));
    localStorage.setItem(TREE_DEFAULT_DEPTH_STORAGE_KEY, String(Number.isFinite(value) && value >= 1 && value <= 6 ? value : 0));
  } catch {
    // localStorage 不可用时偏好仅在本次会话生效
  }
}
