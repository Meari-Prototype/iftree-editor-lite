import { useCallback, useEffect, useRef, type MutableRefObject, type Dispatch, type SetStateAction } from 'react';

import type { DocListItem } from '../../backend/query-api.js';
import type { DocFolderRow } from '../../backend/db/schema.js';
import type { LibraryEntry } from '../../backend/library/library-fs.js';
import { normalizeDocId, normalizeNodeLayoutSettingsByView, readPersistedActiveDocId, persistActiveDocId, sameDocId } from '../lib/doc-utils.js';
import { debugLog } from '../lib/debug-log.js';
import {
  agentRepository,
  documentRepository,
  settingsRepository
} from '../data/repositories.js';
import { useAppUIContext } from './useAppUI.js';
import type { AgentBranch, AgentSettingsLike } from '../lib/agent-utils.js';
import { useUiLanguage } from '../../lang/ui.js';

type AnyRecord = Record<string, unknown>;

interface CurrentDoc {
  doc?: { id?: unknown; node_count?: unknown; [extra: string]: unknown } | null;
  tree?: unknown;
  flatTree?: unknown;
  editBranch?: unknown;
  [extra: string]: unknown;
}

interface DocSummary {
  id?: unknown;
  node_count?: unknown;
  nodeCount?: unknown;
  [extra: string]: unknown;
}

interface PendingBranchSummary {
  id?: unknown;
  base_doc_id?: unknown;
  node_count?: unknown;
  [extra: string]: unknown;
}

interface StartupRenderReadyInfo {
  docId?: unknown;
  renderBackend?: string | null;
  nodeCount?: unknown;
  visual?: AnyRecord;
  [extra: string]: unknown;
}

interface RenderUnlockPending {
  docId: string;
  reason: string;
}

interface OpenDocOptions {
  includeEditBranch?: boolean;
  onComplete?: (doc: unknown) => void;
  onFailure?: (error: unknown) => void;
}

export interface UseStartupOptions {
  lastUiActionRef?: MutableRefObject<unknown> | null;
  startupOpenRequestedRef?: MutableRefObject<boolean> | null;
  // setter 字段直接对齐上游真签名（useDocumentState / useSettings / useAgentChat），让 AppBody 传 Dispatch 进来天然兼容。
  setDocs: Dispatch<SetStateAction<DocListItem[]>>;
  setDocFolders: Dispatch<SetStateAction<DocFolderRow[]>>;
  setLibraryTree: Dispatch<SetStateAction<LibraryEntry | null>>;
  setVectorSettings: Dispatch<SetStateAction<Record<string, unknown>>>;
  setLlmSummarySettings: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  setNodeLayoutSettings: Dispatch<SetStateAction<Record<string, unknown>>>;
  setAgentSettings: Dispatch<SetStateAction<AgentSettingsLike | null>>;
  setAgentDiffs: Dispatch<SetStateAction<AgentBranch[]>>;
  refreshAgentSessions: () => Promise<unknown>;
  openDoc: (docId: unknown, options?: OpenDocOptions) => Promise<unknown>;
  promptStartupEditBranchChoice: (branch: unknown) => Promise<unknown>;
  editBranchBaseDocId: (editBranch?: unknown) => unknown;
}

// 启动编排：启动文档打开（含待恢复编辑分支三选）与首帧渲染解锁。
// UI 横切态（activeTab/setNotice/setProgress/setOperationLock）从 useAppUIContext 读。
export function useStartup({
  lastUiActionRef = null,
  startupOpenRequestedRef = null,
  setDocs,
  setDocFolders,
  setLibraryTree,
  setVectorSettings,
  setLlmSummarySettings,
  setNodeLayoutSettings,
  setAgentSettings,
  setAgentDiffs,
  refreshAgentSessions,
  openDoc,
  promptStartupEditBranchChoice,
  editBranchBaseDocId
}: UseStartupOptions): {
  armRenderUnlock: (docId: unknown, reason?: string) => boolean;
  handleMindMapRenderReady: (info?: StartupRenderReadyInfo) => void;
} {
  const { messages } = useUiLanguage();
  const { activeTab, setNotice, setProgress, setOperationLock } = useAppUIContext();
  const renderReadyLogSignatureRef = useRef<string>('');
  const renderUnlockPendingRef = useRef<RenderUnlockPending | null>(null);
  const armRenderUnlock = useCallback((docId: unknown, reason: string = 'open-doc'): boolean => {
    const normalizedDocId = normalizeDocId(docId);
    if (!normalizedDocId || activeTab !== 'tree') return false;
    renderUnlockPendingRef.current = { docId: normalizedDocId, reason };
    return true;
  }, [activeTab]);
  const releaseRenderUnlock = useCallback((docId: unknown): boolean => {
    const pending = renderUnlockPendingRef.current;
    if (!pending || !sameDocId(docId, pending.docId)) return false;
    renderUnlockPendingRef.current = null;
    setProgress(null);
    setOperationLock(null);
    return true;
  }, [setOperationLock, setProgress]);
  const handleMindMapRenderReady = useCallback((info: StartupRenderReadyInfo = {}): void => {
    const visual = (info.visual || {}) as { visibleNodeCount?: unknown; visibleEdgeCount?: unknown };
    const signature = [
      info.docId ?? '',
      info.renderBackend || '',
      Number(info.nodeCount) || 0,
      Number(visual.visibleNodeCount) || 0,
      Number(visual.visibleEdgeCount) || 0
    ].join('|');
    if (renderReadyLogSignatureRef.current !== signature) {
      renderReadyLogSignatureRef.current = signature;
      debugLog('frontend.render.ready', info);
    }
    releaseRenderUnlock(info.docId);
  }, [releaseRenderUnlock]);

  useEffect(() => {
    let alive = true;
    const rendererErrorPayload = (error: unknown, extra: AnyRecord = {}): AnyRecord => ({
      message: String((error as { message?: string } | null | undefined)?.message || error || '').slice(0, 240),
      stack: String((error as { stack?: string } | null | undefined)?.stack || '').slice(0, 800),
      lastUiAction: lastUiActionRef?.current ?? null,
      ...extra
    });
    const reportWindowError = (event: ErrorEvent): void => {
      const error = event?.error || event?.message || 'renderer-error';
      debugLog('renderer.window.error', rendererErrorPayload(error, {
        sourceId: String(event?.filename || '').slice(0, 200),
        lineNumber: event?.lineno ?? null,
        columnNumber: event?.colno ?? null
      }));
    };
    const reportUnhandledRejection = (event: PromiseRejectionEvent): void => {
      const reason = event?.reason || 'renderer-unhandled-rejection';
      debugLog('renderer.window.unhandledrejection', rendererErrorPayload(reason));
    };
    window.addEventListener('error', reportWindowError);
    window.addEventListener('unhandledrejection', reportUnhandledRejection);
    documentRepository.listDocFolders()
      .then((folders) => { if (alive) setDocFolders((Array.isArray(folders) ? folders : []) as DocFolderRow[]); })
      .catch((error) => { if (alive) setNotice((error as { message?: string }).message || ''); });
    documentRepository.readLibraryTree()
      .then((tree) => { if (alive && tree) setLibraryTree(tree as LibraryEntry); })
      .catch((error) => { if (alive) setNotice((error as { message?: string }).message || ''); });
    Promise.all([
      documentRepository.listDocs(),
      // 启动时发现文档唯一草稿并提示恢复审阅。
      documentRepository.getPendingEditBranches({}).catch(() => ({ branches: [] }))
    ]).then(async ([list = [], pendingEdit = {}]) => {
      // listDocs IPC 返回 unknown，本 hook 把它当 DocListItem[]（真行类型，DocSummary 是历史 minimal 子集）。
      const docsList = (Array.isArray(list) ? list : []) as DocListItem[];
      setDocs(docsList);
      const requestedDocId = readPersistedActiveDocId();
      const persistedDoc = requestedDocId
        ? docsList.find((doc) => normalizeDocId(doc.id) === normalizeDocId(requestedDocId))
        : null;
      const pendingBranches: PendingBranchSummary[] = Array.isArray((pendingEdit as { branches?: unknown }).branches)
        ? (pendingEdit as { branches: PendingBranchSummary[] }).branches
        : [];
      debugLog('frontend.startup.options', {
        requestedDocId,
        docCount: docsList.length,
        pendingBranchCount: pendingBranches.length
      });
      const pendingBranch = pendingBranches.find((branch) => (
        !requestedDocId || sameDocId(branch.base_doc_id, requestedDocId)
      )) || null;
      const pendingBranchChoice = pendingBranch
        ? await promptStartupEditBranchChoice(pendingBranch)
        : null;
      if (!alive) return;
      const pendingBaseDoc = pendingBranch
        ? (docsList.find((doc) => sameDocId(doc.id, pendingBranch.base_doc_id)) || ({
            id: pendingBranch.base_doc_id,
            node_count: pendingBranch.node_count
          } as DocSummary))
        : null;
      if (pendingBranch && pendingBranchChoice === 'discard') {
        try {
          await documentRepository.discardEditBranch({
            docId: pendingBranch.base_doc_id,
            includeDoc: false
          });
        } catch (error) {
          setNotice((error as { message?: string }).message || '');
          return;
        }
      }
      const openTargetDocId = pendingBranchChoice === 'restore'
        ? pendingBranch?.base_doc_id
        : (pendingBranch ? pendingBranch.base_doc_id : persistedDoc?.id);
      const openBaseDoc = pendingBranchChoice === 'restore'
        ? pendingBaseDoc
        : (pendingBranch ? pendingBaseDoc : persistedDoc);
      if (!openTargetDocId && requestedDocId && pendingBranchChoice !== 'restore') {
        persistActiveDocId(null);
      }
      if (!alive || (startupOpenRequestedRef && startupOpenRequestedRef.current)) return;
      if (!openTargetDocId) {
        debugLog('frontend.startup.open.skip', {
          reason: 'no-open-target',
          requestedDocId,
          docCount: docsList.length
        });
        return;
      }
      if (startupOpenRequestedRef) startupOpenRequestedRef.current = true;
      window.setTimeout(() => {
        if (!alive) return;
        const openStartupDoc = (targetDocId: unknown, baseDoc: DocSummary | null | undefined, choice: string | null): void => {
          const pendingNodeCount = baseDoc?.node_count ?? baseDoc?.nodeCount ?? pendingBranch?.node_count ?? 0;
          debugLog('frontend.startup.open.start', {
            docId: targetDocId,
            nodeCount: pendingNodeCount,
            pendingBranchChoice: choice
          });
          openDoc(targetDocId, {
            includeEditBranch: pendingBranch ? choice === 'restore' : undefined,
            onComplete(rawDoc) {
              const doc = rawDoc as CurrentDoc | null | undefined;
              const renderDocId = doc?.doc?.id || targetDocId;
              const docId = editBranchBaseDocId(doc?.editBranch) || renderDocId;
              const nodeCount = doc?.doc?.node_count ?? baseDoc?.node_count ?? baseDoc?.nodeCount ?? 0;
              debugLog('frontend.startup.open.complete', {
                docId,
                renderDocId,
                nodeCount,
                hasTree: Boolean(doc?.tree),
                flatTree: Boolean(doc?.flatTree)
              });
              persistActiveDocId(docId as string);
            }
          }).catch((error: unknown) => {
            if (!alive) return;
            if (choice === 'restore' && pendingBranch?.base_doc_id && !sameDocId(targetDocId, pendingBranch.base_doc_id)) {
              setNotice(messages.notices.restoreEditFailedStashed(String((error as { message?: string }).message || error)));
              debugLog('frontend.startup.restore.fallback-stash', {
                targetDocId,
                baseDocId: pendingBranch.base_doc_id,
                error: (error as { message?: string } | null | undefined)?.message || String(error || 'open-doc-failed')
              });
              openStartupDoc(pendingBranch.base_doc_id, pendingBaseDoc, 'stash');
              return;
            }
            setNotice((error as { message?: string }).message || '');
            debugLog('frontend.startup.open.failure', {
              docId: targetDocId,
              nodeCount: baseDoc?.node_count ?? baseDoc?.nodeCount ?? null,
              error: (error as { message?: string } | null | undefined)?.message || String(error || 'open-doc-failed')
            });
          });
        };
        openStartupDoc(openTargetDocId, openBaseDoc, (pendingBranchChoice as string) || 'open');
      }, 0);
    }).catch((error: unknown) => {
      if (alive) {
        setNotice((error as { message?: string }).message || '');
      }
    });
    settingsRepository.readVectorSettings()
      .then((settings) => setVectorSettings((settings || { enabled: true, disabledReason: '' }) as Record<string, unknown>))
      .catch((error) => {
        if (alive) setNotice((error as { message?: string }).message || '');
      });
    settingsRepository.readLlmSummarySettings()
      .then((settings) => setLlmSummarySettings((settings || null) as Record<string, unknown> | null))
      .catch((error) => setNotice((error as { message?: string }).message || ''));
    settingsRepository.readAgentSettings()
      .then((settings) => setAgentSettings((settings || null) as Record<string, unknown> | null))
      .catch((error) => setNotice((error as { message?: string }).message || ''));
    const agentTimer = window.setTimeout(() => {
      agentRepository.listDiffs()
        .then((diffs) => setAgentDiffs(Array.isArray(diffs) ? diffs : []))
        .catch((error) => setNotice((error as { message?: string }).message || ''));
      refreshAgentSessions().catch((error) => setNotice((error as { message?: string }).message || ''));
    }, 300);
    settingsRepository.readNodeLayoutSettings()
      .then((settings) => setNodeLayoutSettings(normalizeNodeLayoutSettingsByView(settings) as Record<string, unknown>))
      .catch((error) => setNotice((error as { message?: string }).message || ''));
    return () => {
      alive = false;
      window.clearTimeout(agentTimer);
      window.removeEventListener('error', reportWindowError);
      window.removeEventListener('unhandledrejection', reportUnhandledRejection);
    };
  }, []);

  return {
    armRenderUnlock,
    handleMindMapRenderReady
  };
}
