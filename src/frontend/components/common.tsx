import { ChevronDown, FileText, ListTree, LocateFixed, Minus, Square, Upload, X
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUiLanguage } from '../../lang/ui.js';
import { callIftree, hasIftreeMethod } from '../data/iftree-api.js';
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from '../data/window-service.js';

interface ImportModeOption {
  mode: string;
  label: string;
  title?: string;
}

export interface VectorImportOptions {
  chunkSize: number;
  /** 相邻块重叠 = 块长比例（0~0.9），与后端 normalizeVectorChunkOptions 口径一致。 */
  overlap: number;
}

export interface LibraryEntryLike {
  name?: string;
  type?: string;
}

// 向量式导入参数对话框：块大小 + 重叠百分比（界面按 % 收，回调换算为比例）。
function VectorImportParamsDialog({ onConfirm, onCancel }: {
  onConfirm(options: VectorImportOptions): void;
  onCancel(): void;
}) {
  const { messages } = useUiLanguage();
  const text = messages.import;
  const [chunkSizeText, setChunkSizeText] = useState('512');
  const [overlapText, setOverlapText] = useState('10');
  const chunkSize = Math.floor(Number(chunkSizeText));
  const overlapPercent = Number(overlapText);
  const chunkSizeValid = Number.isFinite(chunkSize) && chunkSize >= 1;
  // 上限 90%：与后端 normalizeVectorChunkOptions 的 0.9 夹紧一致（重叠 ≥ 块长切不动）。
  const overlapValid = Number.isFinite(overlapPercent) && overlapPercent >= 0 && overlapPercent <= 90;
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog-box node-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-header">{text.vectorParameters}</header>
        <label className="dialog-field">
          <span>{text.chunkSize}</span>
          <input
            className="dialog-input"
            type="number"
            min={1}
            value={chunkSizeText}
            onChange={(event) => setChunkSizeText(event.target.value)}
            autoFocus
          />
        </label>
        <label className="dialog-field">
          <span>{text.chunkOverlap}</span>
          <input
            className="dialog-input"
            type="number"
            min={0}
            max={90}
            value={overlapText}
            onChange={(event) => setOverlapText(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button
            type="button"
            disabled={!chunkSizeValid || !overlapValid}
            onClick={() => onConfirm({ chunkSize, overlap: overlapPercent / 100 })}
          >
            {messages.common.import}
          </button>
          <button type="button" onClick={onCancel}>{messages.common.cancel}</button>
        </div>
      </div>
    </div>
  );
}

interface ViewPromptCardProps {
  selectedLibraryEntry: LibraryEntryLike | null | undefined;
  onImport?: (mode: string, options?: VectorImportOptions) => void;
}

// 下划线链接式按钮：打开 library 文件夹。Electron 下经主进程 shell.openPath 打开系统
// 文件管理器；纯 Web 预览没有原生通道，退回 readLibraryTree 拿绝对路径展示给用户。
// 悬停 title 显示真实目录地址（挂载时拉取，两种模式下都有 tooltip）。
function OpenLibraryFolderLink({ label }: { label: string }) {
  const [libraryPath, setLibraryPath] = useState('');
  const openPathAvailable = hasIftreeMethod('openPath');

  useEffect(() => {
    let alive = true;
    void callIftree<{ fullPath?: unknown }>('readLibraryTree')
      .then((tree) => {
        if (alive) setLibraryPath(String(tree?.fullPath || ''));
      })
      .catch(() => {
        // 路径拿不到只影响 tooltip，不阻断链接本身。
      });
    return () => { alive = false; };
  }, []);

  const openLibraryFolder = async (): Promise<void> => {
    try {
      if (openPathAvailable) await callIftree('openPath', 'library');
    } catch {
      // 打开失败（路径无效等）不打断空状态页；主进程返回值已携带失败原因。
    }
  };

  return (
    <button
      type="button"
      className="view-prompt-link"
      title={libraryPath || undefined}
      onClick={() => void openLibraryFolder()}
    >
      {label}
    </button>
  );
}

export function ViewPromptCard({ selectedLibraryEntry, onImport }: ViewPromptCardProps) {
  const { messages } = useUiLanguage();
  const text = messages.import;
  const importModeOptions: ImportModeOption[] = [
    { mode: 'simple', label: text.simple },
    { mode: 'complete', label: text.complete },
    { mode: 'smart', label: text.smart, title: text.smartDescription },
    { mode: 'direct', label: text.direct },
    { mode: 'vector', label: text.vector, title: text.vectorDescription }
  ];
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [vectorParamsOpen, setVectorParamsOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!importMenuOpen) return undefined;
    const closeImportMenu = (event: PointerEvent): void => {
      if (!importMenuRef.current?.contains(event.target as Node)) setImportMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeImportMenu);
    return () => window.removeEventListener('pointerdown', closeImportMenu);
  }, [importMenuOpen]);

  const runImport = (mode: string): void => {
    setImportMenuOpen(false);
    // 向量式导入先收 chunkSize/overlap 参数再执行；其它模式直接跑。
    if (mode === 'vector') {
      setVectorParamsOpen(true);
      return;
    }
    onImport?.(mode);
  };

  if (!selectedLibraryEntry) {
    return (
      <div className="view-prompt-card view-prompt-welcome">
        <span className="view-prompt-emblem" aria-hidden="true"><ListTree size={24} /></span>
        <div className="view-prompt-copy">
          <strong>{text.startWithDocument}</strong>
          <span>{text.startWithDocumentDescription}</span>
          <span>
            {text.startWithDocumentHintBeforeLink}
            <OpenLibraryFolderLink label={text.startWithDocumentHintLink} />
            {text.startWithDocumentHintAfterLink}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="view-prompt-card">
      <div className="view-prompt-title">
        <FileText size={18} />
        <strong>{selectedLibraryEntry.name}</strong>
      </div>
      <span>{text.sourceNotImported}</span>
      <div className="view-import-actions import-menu-anchor" ref={importMenuRef}>
        <button type="button" onClick={() => runImport('simple')}>
          <Upload size={14} />
          {text.manualImport}
        </button>
        <button
          type="button"
          className="import-menu-toggle view-import-toggle"
          title={text.selectMode}
          aria-label={text.selectMode}
          onClick={() => setImportMenuOpen((open) => !open)}
        >
          <ChevronDown size={12} />
        </button>
        {importMenuOpen && (
          <div className="import-mode-menu view-import-mode-menu">
            {importModeOptions.map((option) => (
              <button
                key={option.mode}
                type="button"
                title={option.title || option.label}
                onClick={() => runImport(option.mode)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {vectorParamsOpen && (
        <VectorImportParamsDialog
          onConfirm={(options) => {
            setVectorParamsOpen(false);
            onImport?.('vector', options);
          }}
          onCancel={() => setVectorParamsOpen(false)}
        />
      )}
    </div>
  );
}

interface ViewAlignedEmptyStateProps {
  activeTab?: string;
  selectedLibraryEntry: LibraryEntryLike | null | undefined;
  onImport?: (mode: string, options?: VectorImportOptions) => void;
}

export function ViewAlignedEmptyState({ activeTab, selectedLibraryEntry, onImport }: ViewAlignedEmptyStateProps) {
  const prompt = <ViewPromptCard selectedLibraryEntry={selectedLibraryEntry} onImport={onImport} />;
  if (activeTab === 'rich') {
    return (
      <div className="rich-surface source-rich-surface">
        <article className="source-document missing-source">
          <div className="source-reader">
            <div className="source-block source-missing-block">
              <span className="source-gutter-cell" aria-hidden="true" />
              <span className="source-gutter-cell source-gutter-sentence" aria-hidden="true" />
              <div className="source-block-body">{prompt}</div>
            </div>
          </div>
        </article>
      </div>
    );
  }
  return (
    <div className="view-empty-canvas">
      {prompt}
    </div>
  );
}

export function WindowTitlebar({ onClose, title }: { onClose?: () => void; title?: string }) {
  const { messages } = useUiLanguage();
  const close = onClose || (() => closeWindow?.());
  const resolvedTitle = title || messages.shell.appTitle;
  return (
    <header className="app-titlebar">
      <div className="app-titlebar-drag" onDoubleClick={() => toggleMaximizeWindow?.()}>
        <span className="app-titlebar-icon"><ListTree size={13} /></span>
        <span className="app-titlebar-title">{resolvedTitle}</span>
      </div>
      <div className="app-titlebar-controls">
        <button type="button" title={messages.common.minimize} aria-label={messages.common.minimize} onClick={() => minimizeWindow?.()}>
          <Minus size={13} />
        </button>
        <button type="button" title={messages.common.maximizeOrRestore} aria-label={messages.common.maximizeOrRestore} onClick={() => toggleMaximizeWindow?.()}>
          <Square size={12} />
        </button>
        <button type="button" className="app-titlebar-close" title={messages.common.close} aria-label={messages.common.close} onClick={close}>
          <X size={14} />
        </button>
      </div>
    </header>
  );
}

export interface ChoiceDialogAction {
  value: string;
  label: string;
  autoFocus?: boolean;
}

interface ChoiceDialogProps {
  open: boolean;
  title?: ReactNode;
  message?: ReactNode;
  actions?: ChoiceDialogAction[];
  backdropValue?: string;
  onChoose?: (value: string | undefined) => void;
}

// 统一的命令式确认弹窗。actions 自上而下渲染为按钮，每个 { value, label, autoFocus? }
// 点击时回调 onChoose(value)；点击遮罩回调 onChoose(backdropValue)。
export function ChoiceDialog({ open, title, message, actions = [], backdropValue, onChoose }: ChoiceDialogProps) {
  if (!open) return null;
  return (
    <div className="dialog-overlay" onClick={() => onChoose?.(backdropValue)}>
      <div className="dialog-box" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-header">{title}</header>
        <p className="dialog-message">{message}</p>
        <div className="dialog-actions">
          {actions.map((action) => (
            <button
              key={action.value}
              type="button"
              autoFocus={action.autoFocus === true}
              onClick={() => onChoose?.(action.value)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DepthCollapseOneIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.2 2.2" fill="none" />
      <path d="M13 8H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M10 5 7 8l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function DepthExpandOneIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="1.2 2.2" fill="none" />
      <path d="M8 8h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M10 5 13 8l-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

interface IconButtonProps {
  children?: ReactNode;
  title?: string;
  onClick?: () => void;
  disabled?: boolean;
}

export function IconButton({ children, title, onClick, disabled = false }: IconButtonProps) {
  return (
    <button
      className="icon-button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick?.();
      }}
    >
      {children}
    </button>
  );
}

interface LocateNodeButtonProps {
  title?: string;
  label?: string;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
}

export function LocateNodeButton({ title, label, className = '', disabled = false, onClick }: LocateNodeButtonProps) {
  const { messages } = useUiLanguage();
  const resolvedTitle = title || messages.common.locateNode;
  const resolvedLabel = label || messages.common.locateNode;
  return (
    <button
      type="button"
      className={`locate-node-button ${className}`.trim()}
      title={resolvedTitle}
      aria-label={resolvedTitle}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick?.();
      }}
    >
      <LocateFixed size={14} />
      <span>{resolvedLabel}</span>
    </button>
  );
}
