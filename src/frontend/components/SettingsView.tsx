import { ArrowLeft, Bot, Cog, Cpu, Database, ExternalLink, Gauge, HardDrive, Palette, Power, Settings, SlidersHorizontal, Sparkles, Upload, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useUiLanguage } from '../../lang/ui.js';
import { progressCountText } from '../lib/ui-utils.js';
import { IconButton } from './common.jsx';
import { AgentSettingsPanel } from './settings/AgentSettingsPanel.jsx';
import { AppearanceSettingsPanel } from './settings/AppearanceSettingsPanel.jsx';
import { GeneralSettingsPanel } from './settings/GeneralSettingsPanel.jsx';
import { TreeViewSettingsPanel } from './settings/TreeViewSettingsPanel.jsx';
import { PersonalizationSettingsPanel } from './settings/PersonalizationSettingsPanel.jsx';

// 向量模型 / 计算目标的下拉选项形态：来自 settingsRepository 返回值，字段 optional 兼容渐次扩展。
interface ModelOption {
  id: string;
  label: string;
  baseModelName?: string;
  dimensions?: number;
  minDimensions?: number;
  maxDimensions?: number;
  adjustableDimensions?: boolean;
  runtime?: string;
  supportsLocalDownload?: boolean;
}

interface ComputeOption {
  id: string;
  label: string;
}

// 向量模块设置完整字段集（覆盖本组件实际访问的全部字段）。
interface VectorSettings {
  enabled?: boolean;
  disabledReason?: string;
  modelOptions?: ModelOption[];
  computeOptions?: ComputeOption[];
  modelId?: string;
  computeTarget?: string;
  computePolicy?: string;
  localModelRoot?: string;
  remoteModelHost?: string;
  importVectors?: boolean;
  workerCount?: number;
  batchSize?: number;
  modelName?: string;
  ollamaModelName?: string;
  modelPath?: string;
  backend?: string;
  device?: string;
  dtype?: string;
  pooling?: string;
  renderer?: string;
  dimensions?: number;
  minDimensions?: number;
  maxDimensions?: number;
  adjustableDimensions?: boolean;
  runtime?: string;
  supportsLocalDownload?: boolean;
  modelCachePath?: string;
  detectedOllamaBgeM3Path?: string;
  lanceDbPath?: string;
  vectorTable?: string;
}

interface ProgressInfo {
  label?: string;
  total?: number;
  step?: number;
}

// useSettings 上游用 Record<string, unknown> 宽松形态接 IPC 返回；本组件 props 沿用宽松形态，
// 内部一处 cast 收口成具体接口——AppBody 传 props 时无需改造。
type SettingsObjectLike = Record<string, unknown> | null | undefined;
type SettingsSection = 'general' | 'appearance' | 'personalization' | 'vector' | 'agent' | 'treeNodeLayout';

export interface SettingsViewProps {
  vectorSettings: SettingsObjectLike;
  llmSummarySettings: SettingsObjectLike;
  agentSettings: SettingsObjectLike;
  generalSettings: SettingsObjectLike;
  notice?: string;
  clearNotice?: () => void;
  onBack?: () => void;
  onChange?: (patch: Partial<VectorSettings>) => void;
  onLlmSummaryChange?: (patch: Record<string, unknown>) => void;
  onAgentChange?: (patch: Record<string, unknown>) => void;
  onGeneralChange?: (patch: { debugLogging?: boolean }) => void;
  onChooseLocalModelRoot?: () => void;
  onDownloadVectorModel?: () => void;
  progress?: ProgressInfo | null;
  busy?: boolean;
}

export function SettingsView({
  vectorSettings,
  llmSummarySettings,
  agentSettings,
  generalSettings,
  notice,
  clearNotice,
  onBack,
  onChange,
  onLlmSummaryChange,
  onAgentChange,
  onGeneralChange,
  onChooseLocalModelRoot,
  onDownloadVectorModel,
  progress,
  busy
}: SettingsViewProps) {
  const { messages } = useUiLanguage();
  const settingsText = messages.settings;
  const vectorText = settingsText.vector;
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  // 边界 cast 收口：vectorSettings 上游是 Record<string, unknown>（IPC 返回经 useSettings 中转），
  // 本组件内部用 VectorSettings 严格类型操作；运行时形态由 useSettings 守恒，无运行风险。
  const settings: VectorSettings = (vectorSettings || {}) as VectorSettings;
  const vectorEnabled = settings.enabled !== false;
  const modelOptions: ModelOption[] = Array.isArray(settings.modelOptions) ? settings.modelOptions : [];
  const computeOptions: ComputeOption[] = Array.isArray(settings.computeOptions) ? settings.computeOptions : [];
  const selectedModel = modelOptions.find((option) => option.id === settings.modelId);
  const selectedCompute = computeOptions.find((option) => option.id === settings.computeTarget);
  const [dimensionDraft, setDimensionDraft] = useState('');
  const save = (patch: Partial<VectorSettings>) => onChange?.(patch);
  const saveNumber = (key: keyof VectorSettings, value: string) => {
    const next = Number(value);
    if (Number.isFinite(next) && next > 0) save({ [key]: next } as Partial<VectorSettings>);
  };
  useEffect(() => {
    setDimensionDraft(settings.dimensions ? String(settings.dimensions) : '');
  }, [settings.dimensions, settings.modelId]);
  const saveDimensions = () => {
    const next = Number(dimensionDraft);
    const min = Number(selectedModel?.minDimensions ?? settings.minDimensions);
    const max = Number(selectedModel?.maxDimensions ?? settings.maxDimensions);
    if (Number.isInteger(next) && next >= min && next <= max) {
      if (next !== settings.dimensions) save({ dimensions: next });
      return;
    }
    setDimensionDraft(settings.dimensions ? String(settings.dimensions) : '');
  };

  const infoRows = [
    {
      icon: <HardDrive size={17} />,
      label: vectorText.modelSource,
      value: settings.runtime === 'ollama'
        ? settings.ollamaModelName || settings.modelName || vectorText.loading
        : settings.localModelRoot || settings.modelName || vectorText.loading,
      detail: settings.runtime === 'ollama'
        ? vectorText.ollamaSource
        : settings.localModelRoot ? vectorText.localSource(String(settings.modelPath || '')) : settings.modelPath || ''
    },
    {
      icon: <Zap size={17} />,
      label: vectorText.runtimeBackend,
      value: settings.backend || selectedCompute?.label || vectorText.loading,
      detail: settings.runtime === 'ollama'
        ? vectorText.ollamaCompute(String(settings.pooling || ''))
        : settings.renderer ? `device=${settings.device} / dtype=${settings.dtype} / pooling=${settings.pooling}` : ''
    },
    {
      icon: <Database size={17} />,
      label: vectorText.databaseDimensions,
      value: settings.dimensions ? vectorText.dimensions(settings.dimensions) : vectorText.waitingForModel,
      detail: settings.adjustableDimensions
        ? vectorText.dimensionRange(Number(settings.minDimensions), Number(settings.maxDimensions))
        : settings.minDimensions ? vectorText.dimensionFixed(settings.minDimensions) : ''
    },
    ...(settings.runtime === 'ollama' ? [] : [
      {
        icon: <HardDrive size={17} />,
        label: vectorText.browserModelCache,
        value: settings.modelCachePath || vectorText.loading,
        detail: vectorText.browserModelCacheDescription
      },
      {
        icon: <HardDrive size={17} />,
        label: vectorText.detectedOllamaBge,
        value: settings.detectedOllamaBgeM3Path || vectorText.notDetected,
        detail: vectorText.ollamaBlobDescription
      }
    ]),
    {
      icon: <HardDrive size={17} />,
      label: vectorText.vectorDatabase,
      value: settings.lanceDbPath || vectorText.loading,
      detail: settings.vectorTable ? vectorText.lanceTable(settings.vectorTable) : ''
    }
  ];

  return (
    <main className="settings-shell">
      <aside className="settings-sidebar">
        <div className="settings-topbar">
          <IconButton title={settingsText.backToEditor} onClick={onBack}><ArrowLeft size={16} /></IconButton>
          <span>{settingsText.title}</span>
        </div>
        <nav className="settings-nav" aria-label={settingsText.categoryLabel}>
          <button
            className={`settings-nav-item ${settingsSection === 'general' ? 'active' : ''}`}
            onClick={() => setSettingsSection('general')}
          >
            <Cog size={16} />
            <span>{settingsText.navigation.general}</span>
          </button>
          <button
            className={`settings-nav-item ${settingsSection === 'appearance' ? 'active' : ''}`}
            onClick={() => setSettingsSection('appearance')}
          >
            <Palette size={16} />
            <span>{settingsText.navigation.appearance}</span>
          </button>
          <button
            className={`settings-nav-item ${settingsSection === 'personalization' ? 'active' : ''}`}
            onClick={() => setSettingsSection('personalization')}
          >
            <Sparkles size={16} />
            <span>{settingsText.navigation.personalization}</span>
          </button>
          <button
            className={`settings-nav-item ${settingsSection === 'vector' ? 'active' : ''}`}
            onClick={() => setSettingsSection('vector')}
          >
            <Settings size={16} />
            <span>{settingsText.navigation.vector}</span>
          </button>
          <button
            className={`settings-nav-item ${settingsSection === 'agent' ? 'active' : ''}`}
            onClick={() => setSettingsSection('agent')}
          >
            <Bot size={16} />
            <span>{settingsText.navigation.agent}</span>
          </button>
          <button
            className={`settings-nav-item ${settingsSection === 'treeNodeLayout' ? 'active' : ''}`}
            onClick={() => setSettingsSection('treeNodeLayout')}
          >
            <SlidersHorizontal size={16} />
            <span>{settingsText.navigation.treeView}</span>
          </button>
        </nav>
      </aside>

      <section className="settings-main">
        <div className="settings-content">
          {notice && (
            <div className="settings-warning settings-notice" onClick={clearNotice}>
              {notice}
            </div>
          )}
          {settingsSection === 'general' ? (
            <GeneralSettingsPanel generalSettings={generalSettings} onGeneralChange={onGeneralChange} />
          ) : settingsSection === 'appearance' ? (
            <AppearanceSettingsPanel />
          ) : settingsSection === 'personalization' ? (
            <PersonalizationSettingsPanel agentSettings={agentSettings as (Record<string, unknown> & { personalPrompt?: string; tone?: string }) | null} onAgentChange={onAgentChange} />
          ) : settingsSection === 'treeNodeLayout' ? (
            <TreeViewSettingsPanel />
          ) : settingsSection === 'agent' ? (
            agentSettings && llmSummarySettings ? (
              <AgentSettingsPanel
                agentSettings={agentSettings}
                onAgentChange={onAgentChange}
                llmSummarySettings={llmSummarySettings}
                onLlmSummaryChange={onLlmSummaryChange}
              />
            ) : (
              <header className="settings-header">
                <h1>{settingsText.agent.title}</h1>
                <p>{settingsText.agent.loading}</p>
              </header>
            )
          ) : (
            <>
          <header className="settings-header settings-header-row">
            <div>
              <h1>{vectorText.title}</h1>
              <p>{vectorText.description}</p>
            </div>
            <div className="vector-toggle-stack">
              <div className={`vector-status ${vectorEnabled ? 'enabled' : ''}`}>
                <span />
                {vectorEnabled ? vectorText.enabledStatus : vectorText.disabledStatus}
              </div>
              <button
                type="button"
                className={`vector-toggle-button ${vectorEnabled ? 'enabled' : ''}`}
                onClick={() => save({ enabled: !vectorEnabled })}
                title={vectorEnabled ? vectorText.disableTitle : vectorText.enableTitle}
                aria-pressed={vectorEnabled}
              >
                <Power size={16} />
                <span>{vectorEnabled ? vectorText.disable : vectorText.enable}</span>
              </button>
            </div>
          </header>

          <section className="settings-group">
            <header>
              <h2>{vectorText.modelAndCompute}</h2>
              <span>{vectorText.autoSave}</span>
            </header>
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-row-icon"><Database size={17} /></div>
                <div className="settings-row-text">
                  <strong>{vectorText.vectorModel}</strong>
                  <span>{selectedModel?.baseModelName ? vectorText.baseModel(selectedModel.baseModelName) : vectorText.selectModel}</span>
                </div>
                <div className="settings-row-control">
                  <select
                    value={settings.modelId || ''}
                    disabled={!modelOptions.length}
                    onChange={(event) => save({ modelId: event.target.value })}
                  >
                    {modelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} / {vectorText.dimensionOption(Number(option.dimensions), option.adjustableDimensions === true)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><SlidersHorizontal size={17} /></div>
                <div className="settings-row-text">
                  <strong>{vectorText.vectorDimensions}</strong>
                  <span>
                    {selectedModel?.adjustableDimensions
                      ? vectorText.adjustableDimensions(Number(selectedModel.minDimensions), Number(selectedModel.maxDimensions))
                      : vectorText.fixedDimensions(Number(selectedModel?.dimensions || settings.dimensions))}
                  </span>
                </div>
                <div className="settings-row-control">
                  <input
                    type="number"
                    min={selectedModel?.minDimensions}
                    max={selectedModel?.maxDimensions}
                    value={dimensionDraft}
                    disabled={!selectedModel?.adjustableDimensions}
                    onChange={(event) => setDimensionDraft(event.target.value)}
                    onBlur={saveDimensions}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                  />
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><Cpu size={17} /></div>
                <div className="settings-row-text">
                  <strong>{vectorText.computeTarget}</strong>
                  <span>{settings.computePolicy || vectorText.selectComputeTarget}</span>
                </div>
                <div className="settings-row-control">
                  <select
                    value={settings.computeTarget || ''}
                    disabled={!computeOptions.length || selectedModel?.runtime === 'ollama'}
                    onChange={(event) => save({ computeTarget: event.target.value })}
                  >
                    {computeOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><HardDrive size={17} /></div>
                <div className="settings-row-text">
                  <strong>{vectorText.localModelPath}</strong>
                  <span>
                    {selectedModel?.supportsLocalDownload === false
                      ? vectorText.ollamaNoLocalPath
                      : vectorText.localPathDescription}
                  </span>
                </div>
                <div className="settings-row-control settings-path-control">
                  <input
                    type="text"
                    value={selectedModel?.supportsLocalDownload === false ? '' : settings.localModelRoot || ''}
                    readOnly
                    disabled={selectedModel?.supportsLocalDownload === false}
                    placeholder={selectedModel?.supportsLocalDownload === false ? vectorText.ollamaManagesFiles : vectorText.huggingFaceFallback}
                    onClick={onChooseLocalModelRoot}
                  />
                  <button type="button" disabled={selectedModel?.supportsLocalDownload === false} onClick={onChooseLocalModelRoot}>{vectorText.select}</button>
                  <button type="button" disabled={busy || selectedModel?.supportsLocalDownload === false} onClick={onDownloadVectorModel}>{vectorText.download}</button>
                  <button type="button" disabled={selectedModel?.supportsLocalDownload === false} onClick={() => save({ localModelRoot: '' })}>{messages.common.clear}</button>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><ExternalLink size={17} /></div>
                <div className="settings-row-text">
                  <strong>{vectorText.mirrorAddress}</strong>
                  <span>{vectorText.mirrorDescription}</span>
                </div>
                <div className="settings-row-control settings-path-control">
                  <input
                    type="text"
                    value={settings.remoteModelHost || ''}
                    placeholder={vectorText.mirrorPlaceholder}
                    onChange={(event) => save({ remoteModelHost: event.target.value.trim() })}
                  />
                  <button type="button" onClick={() => save({ remoteModelHost: '' })}>{messages.common.clear}</button>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><Upload size={17} /></div>
                <div className="settings-row-text">
                  <strong>{vectorText.vectorizeOnImport}</strong>
                  <span>{vectorText.vectorizeOnImportDescription}</span>
                </div>
                <div className="settings-row-control">
                  <select
                    value={settings.importVectors === false ? 'off' : 'on'}
                    onChange={(event) => save({ importVectors: event.target.value !== 'off' })}
                  >
                    <option value="on">{messages.common.enabled}</option>
                    <option value="off">{vectorText.skip}</option>
                  </select>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><Gauge size={17} /></div>
                <div className="settings-row-text">
                  <strong>{vectorText.workerCount}</strong>
                  <span>{vectorText.workerCountDescription}</span>
                </div>
                <div className="settings-row-control">
                  <input
                    type="number"
                    min="1"
                    max="8"
                    value={settings.workerCount || 1}
                    onChange={(event) => saveNumber('workerCount', event.target.value)}
                  />
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-icon"><Gauge size={17} /></div>
                <div className="settings-row-text">
                  <strong>{vectorText.batchSize}</strong>
                  <span>{vectorText.batchSizeDescription}</span>
                </div>
                <div className="settings-row-control">
                  <input
                    type="number"
                    min="1"
                    max="128"
                    value={settings.batchSize || 1}
                    onChange={(event) => saveNumber('batchSize', event.target.value)}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="settings-group">
            <header>
              <h2>{vectorText.effectiveValues}</h2>
              <span>{vectorText.derivedFromModel}</span>
            </header>
            <div className="settings-list">
              {infoRows.map((row) => (
                <div key={row.label} className="settings-row">
                  <div className="settings-row-icon">{row.icon}</div>
                  <div className="settings-row-text">
                    <strong>{row.label}</strong>
                    <span>{row.detail}</span>
                  </div>
                  <code>{row.value}</code>
                </div>
              ))}
            </div>
          </section>
            </>
          )}
        </div>
      </section>

      {progress && (() => {
        const total = progress.total ?? 0;
        const step = progress.step ?? 0;
        return (
          <div className="progress-overlay">
            <div className="progress-header">
              <span className="progress-label">{progress.label}</span>
              {total > 0 && (
                <span className="progress-count">{progressCountText(progress)}</span>
              )}
            </div>
            <div className="progress-track">
              <div
                className={`progress-fill${total === 0 ? ' progress-fill--indeterminate' : ''}`}
                style={total > 0 ? { width: `${Math.round(step / total * 100)}%` } : undefined}
              />
            </div>
          </div>
        );
      })()}
    </main>
  );
}
