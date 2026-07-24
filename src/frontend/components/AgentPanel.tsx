import { ArrowUp, Bot, Brain, Check, ChevronDown, ChevronRight, Trash2, X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { RichMarkdown, type AddressLinkHandlers } from './RichMarkdown';
import { extractAddressCandidates } from '../../core/address-link.js';
import { documentRepository } from '../data/document-repository.js';
import type { DocListItem } from '../../backend/query-api.js';
import { useUiLanguage } from '../../lang/ui.js';
import type { AgentImageAttachment } from '../../agent/agent-message.js';

import {
  agentBashToolDisplay, agentBranchDocLabel, agentBranchEntries, agentContextUsageView, agentModeLabel, agentReasoningLabel, agentReasoningOptions, agentReasoningShortLabel,
  agentSessionTime, agentSessionTitle, agentStatusText, agentToolArgsSummary, agentToolNameText, agentToolStatusText, buildAgentModelOptions, compactAgentModelLabel,
  defaultAgentModelKey, formatAgentElapsed,
  type AgentBranch, type AgentMessageLike, type AgentModelOption,
  type AgentSegment, type AgentSession, type AgentSettingsLike,
  type AgentToolEvent, type AgentUsage
} from '../lib/agent-utils.js';
import { readAgentDefaultMode } from '../lib/ui-prefs.js';

// AgentPanel 是 Agent 子面板：消费 agent-utils 已 export 的真类型（messages/diffs/sessions/usage 等），
// 内部 3 个子组件 + groupSegments + 主组件 props 都按真类型收紧；docs 字段沿用 agentBranchDocLabel 的最小形参形态。

type AgentDocOption = Pick<DocListItem, 'id' | 'title'>;
type AgentToolByIdMap = Map<string, AgentToolEvent>;
type AgentMode = 'qa' | 'edit' | 'full';
type AgentMenuView = 'main' | 'models';
type ReasoningEffort = string;

// 渲染前把连续的 tool 段聚合成组：text/reasoning 段原样保留，连续 tool 段合成一个 tool-group。
interface AgentToolGroupSegment {
  kind: 'tool-group';
  tools: string[];
}
type AgentGroupedSegment =
  | Extract<AgentSegment, { kind: 'text' }>
  | Extract<AgentSegment, { kind: 'reasoning' }>
  | AgentToolGroupSegment;

interface AgentToolRowProps {
  tool: AgentToolEvent;
}

interface AgentToolGroupProps {
  toolIds: string[];
  toolById: AgentToolByIdMap;
}

interface AgentReasoningProps {
  text: string;
  live?: boolean;
}

export interface AgentRunRequest {
  mode: AgentMode;
  prompt: string;
  attachments: AgentImageAttachment[];
  modelOption: AgentModelOption | null;
  reasoningEffort: ReasoningEffort;
}

export interface AgentPanelProps {
  agentSettings?: AgentSettingsLike | null;
  messages?: AgentMessageLike[];
  diffs?: AgentBranch[];
  docs?: AgentDocOption[];
  sessions?: AgentSession[];
  activeSessionId?: number | string | null;
  busy?: boolean;
  contextUsage?: AgentUsage | null;
  currentDocId?: string | null;
  onLocateAddress?: (docId: string | null, address: string) => void;
  onRun?: (payload: AgentRunRequest) => boolean | Promise<boolean>;
  onCancel?: () => void;
  onApply?: (branchId: number) => void;
  onReject?: (branchId: number) => void;
  onApplyAll?: () => void;
  onRejectAll?: () => void;
  onLoadSession?: (sessionId: number | string) => void;
  onDeleteSession?: (sessionId: number | string) => void;
  onNewSession?: () => void;
  onTraceDiff?: (branch: AgentBranch) => void;
}

function pastedImageAttachment(file: File): Promise<AgentImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read pasted image'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        reject(new Error('Invalid pasted image data'));
        return;
      }
      resolve({
        id: crypto.randomUUID(),
        name: file.name || '',
        mediaType: file.type,
        data: dataUrl.slice(comma + 1)
      });
    };
    reader.readAsDataURL(file);
  });
}

// 用户图片附件（已发送消息 / 输入区待发）：单击图片弹灯箱看大图（复用工具截图同款灯箱）；
// 待发态的 × 移除按钮浮在图上，点击互不干扰。
function AgentAttachmentImage({ attachment, label }: { attachment: AgentImageAttachment; label: string }) {
  const [lightbox, setLightbox] = useState(false);
  return (
    <>
      <img
        src={`data:${attachment.mediaType};base64,${attachment.data}`}
        alt={label}
        onClick={() => setLightbox(true)}
      />
      {lightbox && <AgentImageLightbox image={attachment} onClose={() => setLightbox(false)} />}
    </>
  );
}

function AgentImageAttachments({
  attachments,
  fallbackLabel,
  removeLabel,
  onRemove
}: {
  attachments: AgentImageAttachment[];
  fallbackLabel: string;
  removeLabel?: (name: string) => string;
  onRemove?: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="agent-image-list">
      {attachments.map((attachment, index) => {
        const label = attachment.name || `${fallbackLabel} ${index + 1}`;
        return (
          <div className="agent-image-item" key={attachment.id || `${attachment.mediaType}-${index}`}>
            <AgentAttachmentImage attachment={attachment} label={label} />
            {onRemove ? (
              <button
                type="button"
                aria-label={removeLabel?.(label) || label}
                title={removeLabel?.(label) || label}
                onClick={() => onRemove(attachment.id)}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// 长文本预览：默认截断成定高、不产生内部滚动条——滚轮始终归聊天区，不会在嵌套小框里「卡住」；
// 点「展开全部」才完整铺开（聊天区自己滚）。短文本原样渲染、无任何附加交互。
function AgentPreviewPre({ text }: { text: string }) {
  const { messages: uiMessages } = useUiLanguage();
  const labels = uiMessages.agent;
  const [expanded, setExpanded] = useState(false);
  const [truncatable, setTruncatable] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = preRef.current;
    if (el) setTruncatable(el.scrollHeight > el.clientHeight + 4);
  }, [text]);
  const wrapClass = `agent-pre-wrap${expanded ? ' expanded' : ''}${truncatable && !expanded ? ' truncated' : ''}`;
  return (
    <div className={wrapClass}>
      <pre
        ref={preRef}
        onClick={truncatable ? () => setExpanded((value) => !value) : undefined}
        title={truncatable ? (expanded ? labels.clickCollapse : labels.clickExpandAll) : undefined}
      >
        {text}
      </pre>
      {truncatable && (
        <button type="button" className="agent-pre-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? labels.collapse : labels.expandAll}
        </button>
      )}
    </div>
  );
}

// 截图类工具（db screenshot）结果图片的灯箱：全屏遮罩看大图，Esc / 点遮罩 / × 收起。
// portal 到 body，避免面板内 transform/overflow 影响 fixed 定位。
function AgentImageLightbox({ image, onClose }: { image: AgentImageAttachment; onClose: () => void }) {
  const { messages } = useUiLanguage();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return createPortal(
    <div className="agent-image-lightbox" onClick={onClose}>
      <img
        src={`data:${image.mediaType};base64,${image.data}`}
        alt={image.name || ''}
        onClick={(event) => event.stopPropagation()}
      />
      <button
        type="button"
        className="agent-image-lightbox-close"
        aria-label={messages.common.close}
        title={messages.common.close}
        onClick={onClose}
      >
        <X size={16} />
      </button>
    </div>,
    document.body
  );
}

// 工具行下方的结果缩略图：单击弹灯箱查看大图。
function AgentToolImage({ image }: { image: AgentImageAttachment }) {
  const [lightbox, setLightbox] = useState(false);
  return (
    <>
      <img
        className="agent-tool-image"
        src={`data:${image.mediaType};base64,${image.data}`}
        alt={image.name || ''}
        onClick={() => setLightbox(true)}
      />
      {lightbox && <AgentImageLightbox image={image} onClose={() => setLightbox(false)} />}
    </>
  );
}

// 单个工具调用卡片：segments 交错渲染与旧会话两段式回退共用一处。默认折叠、可展开看参数 / 返回 / 错误。
function AgentToolRow({ tool }: AgentToolRowProps) {
  const { messages } = useUiLanguage();
  const labels = messages.agent;
  const hasDisplayPreview = Object.prototype.hasOwnProperty.call(tool, 'displayPreview');
  const resultText = hasDisplayPreview ? tool.displayPreview : tool.resultPreview;
  const status = tool.status === 'done' || tool.status === 'error' ? tool.status : 'running';
  // bash 走 db 契约语义显示（db find --semantic → 语义检索(...)），其余工具维持原名 + 参数摘要。
  const bashDisplay = tool.name === 'bash' ? agentBashToolDisplay(tool) : null;
  const nameText = bashDisplay?.name || agentToolNameText(tool.name);
  const argsSummary = bashDisplay ? bashDisplay.args : agentToolArgsSummary(tool);
  // 图片回执（db screenshot）：展开内容就是纯图片（codex 式），不渲染参数/返回文本块；
  // 行结构与流式状态切换无关（始终是 details），不干扰追加式渲染。
  const images = Array.isArray(tool.images)
    ? tool.images.filter((image) => (
      Boolean(image)
      && String(image?.mediaType || '').startsWith('image/')
      && Boolean(String(image?.data || ''))
    ))
    : [];
  if (images.length > 0) {
    // 携图请求被接口拒绝（非视觉模型）时，行改判「阅读失败」并展示报错，图片本身仍可点开查看。
    const failed = status === 'error';
    return (
      <details className={`agent-tool-row ${status}`}>
        <summary>
          <span className="agent-tool-status-dot" aria-hidden="true" />
          <span className="agent-tool-name">{failed ? labels.viewImageFailed : nameText}</span>
          {argsSummary && <span className="agent-tool-args">({argsSummary})</span>}
          <em className="agent-tool-state">{agentToolStatusText(status)}</em>
        </summary>
        {tool.error && (
          <div className="agent-tool-body">
            <span className="agent-tool-label">{labels.error}</span>
            <AgentPreviewPre text={tool.error} />
          </div>
        )}
        <div className="agent-tool-images">
          {images.map((image, index) => (
            <AgentToolImage key={image.id || index} image={image} />
          ))}
        </div>
      </details>
    );
  }
  return (
    <details className={`agent-tool-row ${status}`}>
      <summary>
        <span className="agent-tool-status-dot" aria-hidden="true" />
        <span className="agent-tool-name">{nameText}</span>
        {argsSummary && <span className="agent-tool-args">({argsSummary})</span>}
        <em className="agent-tool-state">{agentToolStatusText(status)}</em>
      </summary>
      <div className="agent-tool-body">
        {tool.argsPreview && (
          <>
            <span className="agent-tool-label">{labels.parameters}</span>
            <AgentPreviewPre text={tool.argsPreview} />
          </>
        )}
        {resultText && (
          <>
            <span className="agent-tool-label">{labels.result}</span>
            <AgentPreviewPre text={resultText} />
          </>
        )}
        {tool.error && (
          <>
            <span className="agent-tool-label">{labels.error}</span>
            <AgentPreviewPre text={tool.error} />
          </>
        )}
      </div>
    </details>
  );
}

// 连续工具聚合成组（CC 式"已使用 N 个工具"）：单个直接一行,多个折叠成组、展开看各工具（组 → 工具 → 详情三层）。
function AgentToolGroup({ toolIds, toolById }: AgentToolGroupProps) {
  const { messages } = useUiLanguage();
  const labels = messages.agent;
  const tools = toolIds
    .map((id) => toolById.get(id))
    .filter((tool): tool is AgentToolEvent => Boolean(tool));
  if (tools.length === 0) return null;
  if (tools.length === 1) return <AgentToolRow tool={tools[0]} />;
  const running = tools.some((tool) => tool.status !== 'done' && tool.status !== 'error');
  return (
    <details className="agent-tool-group">
      <summary>
        <span className={`agent-tool-status-dot ${running ? 'running' : 'done'}`} aria-hidden="true" />
        <span className="agent-tool-name">{labels.toolsUsed(tools.length)}</span>
        <em className="agent-tool-state">{running ? labels.running : labels.completed}</em>
      </summary>
      <div className="agent-tool-group-body">
        {tools.map((tool) => <AgentToolRow key={tool.id} tool={tool} />)}
      </div>
    </details>
  );
}

// 思考链：默认折叠成一行,展开看全文；流式途中默认展开看实时思考。
function AgentReasoning({ text, live }: AgentReasoningProps) {
  const { messages } = useUiLanguage();
  return (
    <details className="agent-reasoning" open={live || undefined}>
      <summary>
        <Brain size={12} />
        <span className="agent-reasoning-label">{messages.agent.reasoning}</span>
        {live && <span className="agent-stream-cursor" />}
      </summary>
      <div className="agent-reasoning-body">{text}</div>
    </details>
  );
}

interface AgentProcessProps {
  live?: boolean;
  toolCount: number;
  reasoningCount?: number;
  children?: ReactNode;
}

// 处理过程折叠块：最终回答之前的所有步骤（思考 / 工具 / 中间叙述）收成一组。
// 流式途中默认展开看实时进度,结束后收起成一行「已使用 N 个工具」；旧会话回退列表也复用它。
function AgentProcess({ live, toolCount, reasoningCount = 0, children }: AgentProcessProps) {
  const { messages } = useUiLanguage();
  const labels = messages.agent;
  const parts: string[] = [];
  if (toolCount > 0) parts.push(labels.toolsUsed(toolCount));
  if (reasoningCount > 0) parts.push(labels.reasoningSegments(reasoningCount));
  const summary = parts.join(' · ') || labels.process;
  return (
    <details className="agent-process" open={live || undefined}>
      <summary>
        <span className={`agent-tool-status-dot ${live ? 'running' : 'done'}`} aria-hidden="true" />
        <span className="agent-process-label">{live ? labels.processing : summary}</span>
        {live && summary !== labels.process && <span className="agent-process-hint">{summary}</span>}
        {!live && <em className="agent-tool-state">{labels.completed}</em>}
      </summary>
      <div className="agent-process-body">{children}</div>
    </details>
  );
}

// 渲染前把连续的 tool 段聚合成组,text / reasoning 段原样保留时间线顺序。
function groupSegments(segments: AgentSegment[]): AgentGroupedSegment[] {
  const groups: AgentGroupedSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === 'tool') {
      const last = groups[groups.length - 1];
      if (last && last.kind === 'tool-group') last.tools.push(segment.toolId);
      else groups.push({ kind: 'tool-group', tools: [segment.toolId] });
    } else {
      groups.push(segment);
    }
  }
  return groups;
}

// 从消息的 default_context 工具事件里解析文档行——当轮系统注入的文档就是这条回复的
// 所属文档（地址链接按它判定存在性、按它跳转；同一会话切多少次文档都各归各）。
// 文档行标签：新格式为「当前目标文档：doc:<id>」，旧格式（存量会话）为「文档：doc:<id>」——
// 前者包含后者作子串，同一正则兼容。每轮预览只含本轮拼接段、文档行只有一条；旧格式前段
// 可能混入历史轮次的旧文档行——取【最后一个】匹配对两种格式都稳定命中当轮文档。
function agentMessageDocId(message: AgentMessageLike): string | null {
  const events = Array.isArray(message?.toolEvents) ? message.toolEvents : [];
  for (const event of events) {
    if (event?.name !== 'default_context') continue;
    const text = String(event?.resultPreview || '');
    let docId: string | null = null;
    for (const match of text.matchAll(/文档：doc:(\S+)/g)) docId = match[1];
    if (docId) return docId;
  }
  return null;
}

export function AgentPanel({
  agentSettings,
  messages = [],
  diffs = [],
  docs = [],
  sessions = [],
  activeSessionId = null,
  busy = false,
  contextUsage = null,
  currentDocId = null,
  onLocateAddress,
  onRun,
  onCancel,
  onApply,
  onReject,
  onApplyAll,
  onRejectAll,
  onLoadSession,
  onDeleteSession,
  onNewSession,
  onTraceDiff
}: AgentPanelProps) {
  const { messages: uiMessages } = useUiLanguage();
  const labels = uiMessages.agent;
  const reasoningOptions = agentReasoningOptions();
  // 初始档位读设置屏「常规 → 默认协作权限」偏好；下拉切换仍只改会话内档位，不回写偏好。
  const [mode, setMode] = useState<AgentMode>(() => readAgentDefaultMode());
  const [input, setInput] = useState<string>('');
  const [attachments, setAttachments] = useState<AgentImageAttachment[]>([]);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [modelKey, setModelKey] = useState<string>('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('auto');
  const [sessionMenuOpen, setSessionMenuOpen] = useState<boolean>(false);
  const [modeMenuOpen, setModeMenuOpen] = useState<boolean>(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState<boolean>(false);
  const [agentMenuView, setAgentMenuView] = useState<AgentMenuView>('main');
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToChatBottomRef = useRef<boolean>(true);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const pendingCount = diffs.length;
  const activeSession = sessions.find((session) => Number(session.id) === Number(activeSessionId)) || null;
  const modelOptions = useMemo(() => buildAgentModelOptions(agentSettings ?? {}), [agentSettings]);
  const selectedModel = modelOptions.find((option) => option.key === modelKey) || modelOptions[0] || null;
  const supportedReasoningEfforts = useMemo(() => new Set(selectedModel?.reasoningEfforts || []), [selectedModel]);
  const contextView = agentContextUsageView(contextUsage);
  const modelFullLabel = selectedModel?.label || selectedModel?.model || labels.unconfigured;
  const modelShortLabel = selectedModel ? compactAgentModelLabel(modelFullLabel) : labels.configure;
  const reasoningLabel = agentReasoningLabel(reasoningEffort);
  const reasoningShortLabel = agentReasoningShortLabel(reasoningEffort);

  // 地址内联链接：目标文档逐条消息取——assistant 消息的 default_context 工具事件里
  // 就带「文档：doc:<id>」行（当时查过的 docId，即该条回复的所属文档；同一会话里
  // a/b 文档交替也能各归各）。没有该事件的旧消息退到会话 doc_id，再退当前文档。
  // 候选地址逐个走 db 契约直查（node.get）判定是否真实存在——存在的才渲染成链接；
  // 1-2-18674 这种不存在的、100-300 这种区间表达保持纯文本。判定按 docId 缓存，
  // 同一地址只查一次；纯渲染层能力，不改消息、不碰 agent 上下文。
  const sessionDocId = String(activeSession?.doc_id || '') || null;
  const fallbackDocId = sessionDocId || currentDocId || null;
  const [addressCheckVersion, setAddressCheckVersion] = useState(0);
  const addressValidityRef = useRef(new Map<string, Map<string, boolean>>());
  const addressPendingRef = useRef(new Set<string>());

  useEffect(() => {
    if (!onLocateAddress) return;
    const wanted = new Map<string, Set<string>>();
    for (const message of messages) {
      if (message?.role !== 'assistant') continue;
      const docId = agentMessageDocId(message) || fallbackDocId;
      if (!docId) continue;
      let text = typeof message.answer === 'string' ? message.answer : '';
      if (Array.isArray(message.segments)) {
        for (const segment of message.segments) {
          if (segment?.kind === 'text') text += `\n${segment.text || ''}`;
        }
      }
      const candidates = extractAddressCandidates(text);
      if (candidates.length === 0) continue;
      let bucket = wanted.get(docId);
      if (!bucket) {
        bucket = new Set();
        wanted.set(docId, bucket);
      }
      for (const candidate of candidates) bucket.add(candidate);
    }
    for (const [docId, candidates] of wanted) {
      let validity = addressValidityRef.current.get(docId);
      if (!validity) {
        validity = new Map();
        addressValidityRef.current.set(docId, validity);
      }
      for (const address of candidates) {
        if (validity.has(address)) continue;
        const pendingKey = `${docId}${address}`;
        if (addressPendingRef.current.has(pendingKey)) continue;
        addressPendingRef.current.add(pendingKey);
        void documentRepository.getNode({ docId, address })
          .then((row) => { validity!.set(address, Boolean((row as { id?: unknown } | null)?.id)); })
          .catch(() => { validity!.set(address, false); })
          .finally(() => {
            addressPendingRef.current.delete(pendingKey);
            setAddressCheckVersion((version) => version + 1);
          });
      }
    }
  }, [messages, fallbackDocId, onLocateAddress, addressCheckVersion]);

  const buildAddressLinks = (docId: string | null): AddressLinkHandlers | null => {
    if (!onLocateAddress || !docId) return null;
    return {
      resolve: (address: string) => addressValidityRef.current.get(docId)?.get(address) === true,
      onLocate: (address: string) => onLocateAddress(docId, address)
    };
  };

  useEffect(() => {
    const scroll = chatScrollRef.current;
    if (scroll && stickToChatBottomRef.current) scroll.scrollTop = scroll.scrollHeight;
  }, [messages, pendingCount, busy]);

  useEffect(() => {
    if (pendingCount > 0) setExpanded(true);
  }, [pendingCount]);

  useEffect(() => {
    const nextKey = defaultAgentModelKey(agentSettings ?? {}, modelOptions);
    setModelKey((current) => (modelOptions.some((option) => option.key === current) ? current : nextKey));
  }, [agentSettings, modelOptions]);

  useEffect(() => {
    if (reasoningEffort !== 'auto' && !supportedReasoningEfforts.has(reasoningEffort)) {
      setReasoningEffort('auto');
    }
  }, [reasoningEffort, supportedReasoningEfforts]);

  useEffect(() => {
    if (!agentMenuOpen) return undefined;
    const closeMenu = (event: PointerEvent) => {
      if (!agentMenuRef.current?.contains(event.target as Node | null)) setAgentMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [agentMenuOpen]);

  useEffect(() => {
    if (!sessionMenuOpen) return undefined;
    const closeMenu = (event: PointerEvent) => {
      if (!sessionMenuRef.current?.contains(event.target as Node | null)) setSessionMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [sessionMenuOpen]);

  useEffect(() => {
    if (!modeMenuOpen) return undefined;
    const closeMenu = (event: PointerEvent) => {
      if (!modeMenuRef.current?.contains(event.target as Node | null)) setModeMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [modeMenuOpen]);

  const submit = async () => {
    const prompt = input.trim();
    if ((!prompt && attachments.length === 0) || busy || !onRun) return;
    const draftInput = input;
    const draftAttachments = attachments;
    stickToChatBottomRef.current = true;
    setInput('');
    setAttachments([]);
    const succeeded = await onRun({
      mode,
      prompt,
      attachments: draftAttachments,
      modelOption: selectedModel,
      reasoningEffort
    });
    if (!succeeded) {
      setInput(draftInput);
      setAttachments(draftAttachments);
    }
  };

  const reviewPanel = pendingCount > 0 ? (
    <div className="agent-review-box agent-review-dock">
      <div className="agent-review-head">
        <strong>{labels.pendingChanges(pendingCount)}</strong>
        <div>
          <button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? labels.collapse : labels.review}</button>
          <button type="button" onClick={onRejectAll}>{labels.rejectAll}</button>
          <button type="button" onClick={onApplyAll}><Check size={13} /> {labels.acceptAll}</button>
        </div>
      </div>
      {expanded && (
        <div className="agent-diff-list">
          {diffs.map((branch) => {
            const entries = agentBranchEntries(branch);
            return (
              <div key={String(branch.id ?? '')} className="agent-diff-card">
                <header>
                  <div className="agent-diff-title">
                    <strong>{agentBranchDocLabel(branch, docs)}</strong>
                    <span>{labels.pendingChangesInDraft(entries.length)}</span>
                  </div>
                </header>
                {entries.map((entry) => (
                  <div key={entry.key} className="agent-field-diff">
                    <span>{entry.label}</span>
                    <div><code>{entry.address || '—'}</code></div>
                  </div>
                ))}
                <footer>
                  <button type="button" onClick={() => onTraceDiff?.(branch)}>{labels.viewDiff}</button>
                  <button type="button" onClick={() => onReject?.(branch.id)}>{labels.rejectBatch}</button>
                  <button type="button" onClick={() => onApply?.(branch.id)}><Check size={13} /> {labels.acceptBatch}</button>
                </footer>
              </div>
            );
          })}
        </div>
      )}
    </div>
  ) : null;

  return (
    <section className="agent-panel">
      <header className="agent-chat-header">
        <span className="agent-title"><Bot size={15} /> {labels.title}</span>
        <div className="agent-session-anchor" ref={sessionMenuRef}>
          <button
            type="button"
            className="agent-session-button"
            title={labels.agentSessions}
            onClick={() => setSessionMenuOpen((open) => !open)}
          >
            <span>{activeSession ? agentSessionTitle(activeSession) : labels.session}</span>
            <ChevronDown size={12} />
          </button>
          {sessionMenuOpen && (
            <div className="agent-session-menu">
              <div className="agent-session-head">
                <span>{labels.sessions}</span>
                <button
                  type="button"
                  onClick={() => {
                    onNewSession?.();
                    setSessionMenuOpen(false);
                  }}
                >
                  {labels.newSession}
                </button>
              </div>
              <div className="agent-session-list">
                {sessions.length > 0 ? sessions.map((session) => (
                  <div
                    key={session.id}
                    className={`agent-session-item ${Number(session.id) === Number(activeSessionId) ? 'active' : ''}`}
                  >
                    <button
                      type="button"
                      className="agent-session-load"
                      onClick={() => {
                        onLoadSession?.(session.id);
                        setSessionMenuOpen(false);
                      }}
                    >
                      <span>{agentSessionTitle(session)}</span>
                      <em>{agentSessionTime(session)}{session.pending_diff_count ? ` · ${labels.pendingReview(session.pending_diff_count)}` : ''}</em>
                    </button>
                    <button
                      type="button"
                      className="agent-session-delete"
                      title={labels.deleteSession}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteSession?.(session.id);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )) : (
                  <p className="agent-session-empty">{labels.noSavedSessions}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="agent-chat-shell">
        <div
          ref={chatScrollRef}
          className={`agent-chat-scroll${messages.length === 0 && pendingCount === 0 && !busy ? ' empty' : ''}`}
          onWheel={(event) => {
            if (event.deltaY < 0) stickToChatBottomRef.current = false;
          }}
          onScroll={(event) => {
            const scroll = event.currentTarget;
            stickToChatBottomRef.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 4;
          }}
        >
          {messages.length > 0 ? (
            <div className="agent-message-list">
              {messages.map((message) => {
                const role = message.role === 'user' ? 'user' : 'assistant';
                // text 是纯文本投影：user 消息正文，或 assistant 没有 segments 时的回退（旧会话）。
                // 正常 assistant 走下面的 segments 渲染——segments 才是展示主真相，answer 只兜底 + 供历史回传。
                const text = role === 'user' ? message.content : message.answer;
                const meta = `${agentStatusText(message.status) || labels.agent}${message.elapsedMs ? ` · ${formatAgentElapsed(message.elapsedMs)}` : ''}`;
                if (role === 'user') {
                  const messageAttachments = Array.isArray(message.attachments) ? message.attachments : [];
                  return (
                    <div key={message.id} className="agent-message-row user">
                      <div className="agent-message-bubble user">
                        <AgentImageAttachments attachments={messageAttachments} fallbackLabel={labels.imageAttachment} />
                        {text ? <p className="agent-message-content">{text}</p> : null}
                      </div>
                    </div>
                  );
                }
                const toolById: AgentToolByIdMap = new Map(
                  (message.toolEvents || []).map((toolEvent): [string, AgentToolEvent] => [String(toolEvent.id ?? ''), toolEvent])
                );
                const segments = Array.isArray(message.segments) ? message.segments : [];
                // 该条回复的所属文档：消息自己的 default_context 事件里解析，缺失再退兜底。
                const messageAddressLinks = buildAddressLinks(agentMessageDocId(message) || fallbackDocId);
                const lastSegmentIndex = segments.length - 1;
                const streamingTail = message.streaming && segments[lastSegmentIndex]?.kind === 'tool';
                // 处理过程折叠：最后一个非 text 组（tool/reasoning）及之前的内容算「过程」，
                // 其后的 text 尾段是最终回答——回答留在折叠块外直接可见；纯文本回答没有过程块。
                const grouped = groupSegments(segments);
                let lastProcessIndex = -1;
                grouped.forEach((group, index) => {
                  if (group.kind !== 'text') lastProcessIndex = index;
                });
                const hasProcess = lastProcessIndex >= 0;
                const processGroups = hasProcess ? grouped.slice(0, lastProcessIndex + 1) : [];
                const answerGroups = hasProcess ? grouped.slice(lastProcessIndex + 1) : grouped;
                const processToolCount = processGroups.reduce((count, group) => count + (group.kind === 'tool-group' ? group.tools.length : 0), 0);
                const processReasoningCount = processGroups.reduce((count, group) => count + (group.kind === 'reasoning' ? 1 : 0), 0);
                const renderGroup = (group: AgentGroupedSegment, index: number, isLiveTail: boolean, keyPrefix: string) => {
                  if (group.kind === 'tool-group') {
                    return <AgentToolGroup key={`${keyPrefix}-${index}`} toolIds={group.tools} toolById={toolById} />;
                  }
                  if (group.kind === 'reasoning') {
                    return <AgentReasoning key={`${keyPrefix}-${index}`} text={group.text} live={isLiveTail} />;
                  }
                  if (isLiveTail) {
                    return (
                      <p key={`${keyPrefix}-${index}`} className="agent-message-content">
                        {group.text}
                        <span className="agent-stream-cursor" />
                      </p>
                    );
                  }
                  return <RichMarkdown key={`${keyPrefix}-${index}`} className="agent-message-rich" markdown={group.text} addressLinks={messageAddressLinks} />;
                };
                return (
                  <div key={message.id} className="agent-message-row assistant">
                    <div className={`agent-answer${message.error ? ' error' : ''}`}>
                      <span className="agent-message-meta">{meta}</span>
                      {segments.length > 0 ? (
                        <div className="agent-segments">
                          {hasProcess && (
                            <AgentProcess
                              live={Boolean(message.streaming)}
                              toolCount={processToolCount}
                              reasoningCount={processReasoningCount}
                            >
                              {processGroups.map((group, index) => renderGroup(
                                group,
                                index,
                                Boolean(message.streaming) && answerGroups.length === 0 && index === processGroups.length - 1,
                                'process'
                              ))}
                              {streamingTail && (
                                <p className="agent-message-content">
                                  {agentStatusText(message.status) || labels.processing}
                                  <span className="agent-stream-cursor" />
                                </p>
                              )}
                            </AgentProcess>
                          )}
                          {answerGroups.map((group, index) => renderGroup(
                            group,
                            index,
                            Boolean(message.streaming) && index === answerGroups.length - 1,
                            'answer'
                          ))}
                          {/* 退化兜底：整段都是过程、没有 text 尾段时，用 answer 投影补出可见回答。 */}
                          {!message.streaming && hasProcess && answerGroups.length === 0 && text ? (
                            <RichMarkdown className="agent-message-rich" markdown={text} addressLinks={messageAddressLinks} />
                          ) : null}
                        </div>
                      ) : (
                        <>
                          {message.toolEvents && message.toolEvents.length > 0 && (
                            <AgentProcess toolCount={message.toolEvents.length}>
                              {message.toolEvents.map((tool) => <AgentToolRow key={tool.id} tool={tool} />)}
                            </AgentProcess>
                          )}
                          {!message.streaming && text ? (
                            <RichMarkdown className="agent-message-rich" markdown={text} addressLinks={messageAddressLinks} />
                          ) : (
                            <p className="agent-message-content">
                              {text || agentStatusText(message.status) || labels.processing}
                              {message.streaming && <span className="agent-stream-cursor" />}
                            </p>
                          )}
                        </>
                      )}
                      {role === 'assistant' && (message.diffCount ?? 0) > 0 && (
                        <span className="agent-message-note">{labels.pendingChanges(message.diffCount ?? 0)}</span>
                      )}
                      {message.imageRequestRejected ? (
                        <span className="agent-message-note">{labels.imageRequestRejected}</span>
                      ) : null}
                      {message.visionFallback ? (
                        <span className="agent-message-note">{labels.visionFallback}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="agent-empty-chat">
              <Bot size={18} />
              <p>{mode === 'full' ? labels.fullDescription : mode === 'edit' ? labels.editDescription : labels.qaDescription}</p>
            </div>
          )}
        </div>

        {reviewPanel}

        <div className="agent-composer">
          <AgentImageAttachments
            attachments={attachments}
            fallbackLabel={labels.imageAttachment}
            removeLabel={labels.removeImage}
            onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
          />
          <textarea
            value={input}
            disabled={busy}
            placeholder={mode === 'full' ? labels.fullPlaceholder : mode === 'edit' ? labels.editPlaceholder : labels.qaPlaceholder}
            onChange={(event) => setInput(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.items)
                .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                .map((item) => item.getAsFile())
                .filter((file): file is File => Boolean(file));
              if (files.length === 0) return;
              event.preventDefault();
              void Promise.all(files.map(pastedImageAttachment)).then((next) => {
                setAttachments((current) => [...current, ...next]);
              });
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent?.isComposing) return;
              if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="agent-control-row">
            <div className="agent-mode-anchor" ref={modeMenuRef}>
              <button
                type="button"
                className="agent-mode-pill"
                title={labels.editPermission}
                disabled={busy}
                onClick={() => setModeMenuOpen((open) => !open)}
              >
                <span className="agent-pill-label">{agentModeLabel(mode)}</span>
                <ChevronDown size={12} />
              </button>
              {modeMenuOpen && (
                <div className="agent-mode-menu">
                  <button
                    type="button"
                    className={`agent-menu-item ${mode === 'qa' ? 'selected' : ''}`}
                    onClick={() => {
                      setMode('qa');
                      setModeMenuOpen(false);
                    }}
                  >
                    <span>{labels.qa}</span>
                    {mode === 'qa' && <Check size={14} />}
                  </button>
                  <button
                    type="button"
                    className={`agent-menu-item ${mode === 'edit' ? 'selected' : ''}`}
                    onClick={() => {
                      setMode('edit');
                      setModeMenuOpen(false);
                    }}
                  >
                    <span>{labels.edit}</span>
                    {mode === 'edit' && <Check size={14} />}
                  </button>
                  <button
                    type="button"
                    className={`agent-menu-item ${mode === 'full' ? 'selected' : ''}`}
                    onClick={() => {
                      setMode('full');
                      setModeMenuOpen(false);
                    }}
                  >
                    <span>{labels.fullAccess}</span>
                    {mode === 'full' && <Check size={14} />}
                  </button>
                </div>
              )}
            </div>
            <div className="agent-run-controls">
              <div
                className={`agent-context-dot ${contextView.level}`}
                title={contextView.title}
                style={{ '--agent-context-ratio': `${Math.round(contextView.ratio * 360)}deg` }}
              >
                <span />
              </div>
              <div className="agent-menu-anchor" ref={agentMenuRef}>
                <button
                  type="button"
                  className="agent-model-depth-pill"
                  title={labels.modelReasoningTitle(selectedModel?.title || labels.switchModel, reasoningLabel)}
                  disabled={busy}
                  onClick={() => {
                    setAgentMenuOpen((open) => !open);
                    setAgentMenuView('main');
                  }}
                >
                  <span className="agent-pill-label agent-model-full">{modelFullLabel}</span>
                  <span className="agent-pill-label agent-model-short">{modelShortLabel}</span>
                  <span className="agent-pill-label agent-depth-full">{reasoningLabel}</span>
                  <span className="agent-pill-label agent-depth-short">{reasoningShortLabel}</span>
                  <ChevronDown size={12} className="agent-pill-chevron" />
                </button>
                {agentMenuOpen && (
                  <div className="agent-model-menu">
                    <div className="agent-menu-section">
                      {reasoningOptions.map((option) => {
                        const enabled = option.value === 'auto' || supportedReasoningEfforts.has(option.value);
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className={`agent-menu-item ${reasoningEffort === option.value ? 'selected' : ''}`}
                            disabled={!enabled}
                            title={enabled ? '' : labels.unsupportedReasoning}
                            onClick={() => {
                              if (!enabled) return;
                              setReasoningEffort(option.value);
                              setAgentMenuOpen(false);
                            }}
                          >
                            <span>{option.label}</span>
                            {reasoningEffort === option.value && <Check size={14} />}
                          </button>
                        );
                      })}
                    </div>
                    {modelOptions.length > 0 && (
                      <>
                        <div className="agent-menu-separator" />
                        <button
                          type="button"
                          className={`agent-menu-item ${agentMenuView === 'models' ? 'selected' : ''}`}
                          onClick={() => setAgentMenuView((view) => (view === 'models' ? 'main' : 'models'))}
                        >
                          <span>{modelFullLabel}</span>
                          {agentMenuView === 'models' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        {agentMenuView === 'models' && (
                          <div className="agent-menu-section agent-menu-scroll agent-menu-subsection">
                            {modelOptions.map((option) => (
                              <button
                                key={option.key}
                                type="button"
                                className={`agent-menu-item ${selectedModel?.key === option.key ? 'selected' : ''}`}
                                onClick={() => {
                                  setModelKey(option.key);
                                  setAgentMenuOpen(false);
                                }}
                              >
                                <span>{option.label}</span>
                                {selectedModel?.key === option.key && <Check size={14} />}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
              {busy ? (
                <button type="button" className="agent-send-button cancel" title={labels.cancelRequest} onClick={onCancel}>
                  <X size={17} strokeWidth={2.4} />
                </button>
              ) : (
                <button
                  type="button"
                  className="agent-send-button"
                  disabled={(!input.trim() && attachments.length === 0) || modelOptions.length === 0}
                  onClick={() => void submit()}
                >
                  <ArrowUp size={17} strokeWidth={2.4} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
