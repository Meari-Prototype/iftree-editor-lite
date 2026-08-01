import { useEffect, useState } from 'react';
import { Database, FileText, KeyRound, Plus, Trash2
} from 'lucide-react';
import { llmProviderPresets, newLlmApi, newLlmProvider,
  normalizeLlmSettingsForEditor, providerMatchesPreset,
  type LlmApi, type LlmProvider, type LlmProviderRaw
} from '../../lib/summary-utils.js';
import { useUiLanguage } from '../../../lang/ui.js';

type LlmSettingsShape = ReturnType<typeof normalizeLlmSettingsForEditor>;

interface LlmSummarySettingsPanelProps {
  settings?: unknown;
  onChange?: (next: LlmSettingsShape) => void;
  title?: string;
  description?: string;
  currentLabel?: string;
  showHeader?: boolean;
}

function needsAnthropicMaxOutput(api: Partial<LlmApi> = {}) {
  return String(api.protocol || 'openai-compatible') === 'anthropic-compatible'
    && Number(api.maxOutputTokens) <= 0;
}

export function LlmSummarySettingsPanel({
  settings,
  onChange,
  title,
  description,
  currentLabel,
  showHeader = true
}: LlmSummarySettingsPanelProps) {
  const { messages } = useUiLanguage();
  const text = messages.settings.llm;
  const resolvedTitle = title || text.title;
  const resolvedDescription = description || text.description;
  const resolvedCurrentLabel = currentLabel || text.currentApi;
  const config = normalizeLlmSettingsForEditor((settings || {}) as Parameters<typeof normalizeLlmSettingsForEditor>[0]);
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const activeProvider = providers.find((provider) => provider.id === config.activeProviderId) || providers[0] || null;
  const apis = Array.isArray(activeProvider?.apis) ? activeProvider.apis : [];
  const activeApi = apis.find((api) => api.id === config.activeApiId) || apis[0] || null;
  const activeReasoningEfforts = Array.isArray(activeApi?.reasoningEfforts)
    ? activeApi.reasoningEfforts.join(',')
    : String(activeApi?.reasoningEfforts || '');
  const [apiValidationMessage, setApiValidationMessage] = useState('');
  const visibleApiValidationMessage = apiValidationMessage || (
    activeApi && needsAnthropicMaxOutput(activeApi) ? text.anthropicOutputRequired : ''
  );
  useEffect(() => {
    setApiValidationMessage('');
  }, [activeApi?.id]);
  const save = (next: LlmSettingsShape) => onChange?.(next);
  const providerPresets = llmProviderPresets();
  const saveProviders = (nextProviders: LlmProvider[], extra: Partial<LlmSettingsShape> = {}) => save({ ...config, providers: nextProviders, ...extra });
  const providerOptions = [
    ...providers.map((provider) => ({ kind: 'provider', value: provider.id, label: provider.name || messages.common.unnamedProvider })),
    ...providerPresets
      .filter((preset) => !providers.some((provider) => providerMatchesPreset(provider, preset)))
      .map((preset) => ({ kind: 'preset', value: `preset:${preset.id}`, label: preset.name }))
  ];

  const addProvider = () => {
    const provider = newLlmProvider(null, providers);
    saveProviders([...providers, provider], {
      activeProviderId: provider.id,
      activeApiId: provider.apis[0].id
    });
  };

  const deleteProvider = () => {
    if (!activeProvider || providers.length <= 1) return;
    const ok = window.confirm(text.confirmDeleteProvider(activeProvider.name || messages.common.unnamedProvider));
    if (!ok) return;
    const nextProviders = providers.filter((provider) => provider.id !== activeProvider.id);
    const nextProvider = nextProviders[0];
    saveProviders(nextProviders, {
      activeProviderId: nextProvider?.id || '',
      activeApiId: nextProvider?.apis?.[0]?.id || ''
    });
  };

  const selectProvider = (providerId: string) => {
    if (providerId.startsWith('preset:')) {
      const preset = providerPresets.find((item) => item.id === providerId.slice('preset:'.length));
      if (!preset) return;
      const provider = newLlmProvider(preset as LlmProviderRaw, providers);
      saveProviders([...providers, provider], {
        activeProviderId: provider.id,
        activeApiId: provider.apis?.[0]?.id || ''
      });
      return;
    }
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) return;
    saveProviders(providers, {
      activeProviderId: provider.id,
      activeApiId: provider.apis?.[0]?.id || ''
    });
  };

  const updateProvider = (patch: Partial<LlmProvider>) => {
    if (!activeProvider) return;
    saveProviders(providers.map((provider) => (
      provider.id === activeProvider.id ? { ...provider, ...patch } : provider
    )));
  };

  const addApi = () => {
    if (!activeProvider) return;
    const api = newLlmApi();
    saveProviders(providers.map((provider) => (
      provider.id === activeProvider.id
        ? { ...provider, apis: [...(provider.apis || []), api] }
        : provider
    )), { activeApiId: api.id });
  };

  const deleteApi = () => {
    if (!activeProvider || !activeApi || apis.length <= 1) return;
    const ok = window.confirm(text.confirmDeleteApi(activeApi.name || messages.common.unnamedApi));
    if (!ok) return;
    const nextApis = apis.filter((api) => api.id !== activeApi.id);
    saveProviders(providers.map((provider) => (
      provider.id === activeProvider.id ? { ...provider, apis: nextApis } : provider
    )), { activeApiId: nextApis[0]?.id || '' });
  };

  const updateApi = (patch: Partial<LlmApi>) => {
    if (!activeProvider || !activeApi) return;
    const nextApi = { ...activeApi, ...patch };
    if (needsAnthropicMaxOutput(nextApi)) {
      setApiValidationMessage(text.anthropicOutputRequired);
      return;
    }
    setApiValidationMessage('');
    saveProviders(providers.map((provider) => (
      provider.id === activeProvider.id
        ? {
          ...provider,
          apis: apis.map((api) => (api.id === activeApi.id ? nextApi : api))
        }
        : provider
    )));
  };

  return (
    <>
      {showHeader && (
        <header className="settings-header">
          <h1>{resolvedTitle}</h1>
          <p>{resolvedDescription}</p>
        </header>
      )}

      <section className="settings-group">
        <header>
          <h2>{text.provider}</h2>
          <span>{text.autoSave}</span>
        </header>
        <div className="llm-settings-card">
          <div className="llm-toolbar">
            <select
              value={activeProvider?.id || ''}
              onChange={(event) => selectProvider(event.target.value)}
            >
              {providerOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button type="button" onClick={addProvider}><Plus size={15} />{text.addProvider}</button>
            <button type="button" disabled={providers.length <= 1} onClick={deleteProvider}><Trash2 size={15} />{messages.common.delete}</button>
          </div>

          {activeProvider && (
            <div className="llm-form-grid">
              <label className="llm-field">
                <span>{text.providerName}</span>
                <input value={activeProvider.name || ''} onChange={(event) => updateProvider({ name: event.target.value })} placeholder={text.providerNamePlaceholder} />
              </label>
              <label className="llm-field">
                <span>{text.note}</span>
                <input value={activeProvider.note || ''} onChange={(event) => updateProvider({ note: event.target.value })} placeholder={text.providerNotePlaceholder} />
              </label>
              <label className="llm-field llm-field-wide">
                <span>{text.website}</span>
                <input value={activeProvider.websiteUrl || ''} onChange={(event) => updateProvider({ websiteUrl: event.target.value })} placeholder={text.websitePlaceholder} />
              </label>
            </div>
          )}
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>{text.apiConfiguration}</h2>
          <span>{activeApi?.enabled === false ? text.disabledApi : text.activeApi}</span>
        </header>
        <div className="llm-settings-card">
          <div className="llm-toolbar">
            <select
              value={activeApi?.id || ''}
              onChange={(event) => save({ ...config, activeApiId: event.target.value })}
            >
              {apis.map((api) => (
                <option key={api.id} value={api.id}>{api.name || messages.common.unnamedApi}</option>
              ))}
            </select>
            <button type="button" disabled={!activeProvider} onClick={addApi}><Plus size={15} />{text.addApi}</button>
            <button type="button" disabled={apis.length <= 1} onClick={deleteApi}><Trash2 size={15} />{messages.common.delete}</button>
          </div>

          {activeApi && (
            <div className="llm-form-grid">
              <label className="llm-field">
                <span>{text.apiName}</span>
                <input value={activeApi.name || ''} onChange={(event) => updateApi({ name: event.target.value })} placeholder={text.apiNamePlaceholder} />
              </label>
              <label className="llm-field">
                <span>{text.note}</span>
                <input value={activeApi.note || ''} onChange={(event) => updateApi({ note: event.target.value })} placeholder={text.apiNotePlaceholder} />
              </label>
              <label className="llm-field llm-field-wide">
                <span>API Key</span>
                <span className="llm-apikey-control">
                  <input
                    type="password"
                    value={activeApi.apiKey || ''}
                    onChange={(event) => updateApi({ apiKey: event.target.value })}
                    placeholder={text.apiKeyPlaceholder}
                  />
                  <button
                    type="button"
                    className="llm-apikey-clear"
                    title={text.clearApiKey}
                    aria-label={text.clearApiKey}
                    disabled={!activeApi.apiKey}
                    onClick={() => updateApi({ apiKey: '' })}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </label>
              <label className="llm-field">
                <span>{text.endpoint}</span>
                <input value={activeApi.baseUrl || ''} onChange={(event) => updateApi({ baseUrl: event.target.value })} placeholder="https://api.deepseek.com" />
              </label>
              <label className="llm-field">
                <span>{text.protocol}</span>
                <select value={activeApi.protocol || 'openai-compatible'} onChange={(event) => updateApi({ protocol: event.target.value })}>
                  <option value="openai-compatible">OpenAI compatible</option>
                  <option value="anthropic-compatible">Anthropic compatible</option>
                </select>
              </label>
              <label className="llm-field">
                <span>{text.model}</span>
                <input value={activeApi.model || ''} onChange={(event) => updateApi({ model: event.target.value })} placeholder="deepseek-v4-pro" />
              </label>
              <label className="llm-field">
                <span>{text.contextWindow}</span>
                <input type="number" min="0" value={Number(activeApi.contextLimit) > 0 ? activeApi.contextLimit : ''} onChange={(event) => updateApi({ contextLimit: Number(event.target.value) })} />
              </label>
              <label className="llm-field">
                <span>{text.maxOutput}</span>
                <input
                  type="number"
                  min="0"
                  value={Number(activeApi.maxOutputTokens) > 0 ? activeApi.maxOutputTokens : ''}
                  onChange={(event) => updateApi({ maxOutputTokens: Number(event.target.value) })}
                  onBlur={(event) => {
                    setApiValidationMessage(needsAnthropicMaxOutput({
                      ...activeApi,
                      maxOutputTokens: Number(event.target.value)
                    }) ? text.anthropicOutputRequired : '');
                  }}
                />
                {visibleApiValidationMessage && <span className="llm-field-error">{visibleApiValidationMessage}</span>}
              </label>
              <label className="llm-field">
                <span>{text.reasoningEffort}</span>
                <input value={activeReasoningEfforts} onChange={(event) => updateApi({ reasoningEfforts: event.target.value.split(',').map((part) => part.trim()).filter(Boolean) })} placeholder="low,medium,high,xhigh" />
              </label>
              <div className="llm-switch-row llm-field-wide">
                <label>
                  <input type="checkbox" checked={activeApi.fullUrl === true} onChange={(event) => updateApi({ fullUrl: event.target.checked })} />
                  {text.endpointIsFullUrl}
                </label>
                <label>
                  <input type="checkbox" checked={activeApi.enabled !== false} onChange={(event) => updateApi({ enabled: event.target.checked })} />
                  {text.enableApi}
                </label>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>{text.effectiveValues}</h2>
          <span>JSON + .env</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><FileText size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.nonSecretConfiguration}</strong>
              <span>{text.nonSecretConfigurationDescription}</span>
            </div>
            <code>{config.configPath || 'iftree.config.json'}</code>
          </div>
          <div className="settings-row">
            <div className="settings-row-icon"><KeyRound size={17} /></div>
            <div className="settings-row-text">
              <strong>API Key</strong>
              <span>{text.secretOnly}</span>
            </div>
            <code>{config.envPath || '.env'}</code>
          </div>
          <div className="settings-row">
            <div className="settings-row-icon"><Database size={17} /></div>
            <div className="settings-row-text">
              <strong>{resolvedCurrentLabel}</strong>
              <span>{activeProvider?.name || messages.common.unconfigured} / {activeApi?.name || messages.common.unconfigured}</span>
            </div>
            <code>{activeApi?.model || text.unconfiguredModel}</code>
          </div>
        </div>
      </section>
    </>
  );
}
