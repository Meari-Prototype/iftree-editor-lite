import { normalizeAgentToolSettings
} from '../../lib/summary-utils.js';
import { useUiLanguage } from '../../../lang/ui.js';
import { LlmSummarySettingsPanel } from './LlmSummarySettingsPanel.jsx';
import { SummaryStrategySettingsPanel } from './SummaryStrategySettingsPanel.jsx';

type SettingsObject = Record<string, unknown>;
type InputValue = string | number | readonly string[] | undefined;
interface AgentSettings extends SettingsObject {
  personalPrompt?: string;
  toolSettings?: Partial<Record<'searchResultLimit' | 'searchBlockMaxChars' | 'fetchContentMaxChars' | 'webSearchResultLimit' | 'webOpenCharLimit', InputValue>>;
}
type SettingsChange = (settings: SettingsObject) => void;

interface AgentSettingsPanelProps {
  agentSettings?: AgentSettings | null;
  onAgentChange?: SettingsChange;
  llmSummarySettings?: (SettingsObject & { independent?: boolean }) | null;
  onLlmSummaryChange?: SettingsChange;
}

export function AgentSettingsPanel({
  agentSettings,
  onAgentChange,
  llmSummarySettings,
  onLlmSummaryChange
}: AgentSettingsPanelProps) {
  const { messages } = useUiLanguage();
  const text = messages.settings.agent;
  const summaryIndependent = llmSummarySettings?.independent === true;
  const toolSettings = normalizeAgentToolSettings(agentSettings?.toolSettings || {});
  const setSummaryIndependent = (enabled: boolean) => {
    onLlmSummaryChange?.({ ...(llmSummarySettings || {}), independent: enabled });
  };
  const updateToolSettings = (patch: SettingsObject) => {
    onAgentChange?.({
      ...(agentSettings || {}),
      toolSettings: normalizeAgentToolSettings({ ...toolSettings, ...patch })
    });
  };

  return (
    <>
      <header className="settings-header">
        <h1>{text.title}</h1>
        <p>{text.description}</p>
      </header>

      <section className="settings-submodule-title">
        <h2>{text.providersAndApis}</h2>
        <p>{text.providersAndApisDescription}</p>
      </section>
      <LlmSummarySettingsPanel
        settings={agentSettings}
        onChange={onAgentChange}
        currentLabel={text.currentSharedApi}
        showHeader={false}
      />

      <section className="settings-submodule-title">
        <h2>{text.searchTools}</h2>
        <p>{text.searchToolsDescription}</p>
      </section>
      <div className="llm-settings-card">
        <div className="llm-form-grid">
          <label className="llm-field">
            <span>{text.documentSearchResults}</span>
            <input type="number" min="1" max="80" value={toolSettings.searchResultLimit} onChange={(event) => updateToolSettings({ searchResultLimit: event.target.value })} />
          </label>
          <label className="llm-field">
            <span>{text.searchTextBlockLimit}</span>
            <input type="number" min="200" max="50000" value={toolSettings.searchBlockMaxChars} onChange={(event) => updateToolSettings({ searchBlockMaxChars: event.target.value })} />
          </label>
          <label className="llm-field">
            <span>{text.readContentLimit}</span>
            <input type="number" min="200" max="100000" value={toolSettings.fetchContentMaxChars} onChange={(event) => updateToolSettings({ fetchContentMaxChars: event.target.value })} />
          </label>
          <label className="llm-field">
            <span>{text.webSearchResults}</span>
            <input type="number" min="1" max="10" value={toolSettings.webSearchResultLimit} onChange={(event) => updateToolSettings({ webSearchResultLimit: event.target.value })} />
          </label>
          <label className="llm-field">
            <span>{text.webContentLimit}</span>
            <input type="number" min="1000" max="50000" value={toolSettings.webOpenCharLimit} onChange={(event) => updateToolSettings({ webOpenCharLimit: event.target.value })} />
          </label>
        </div>
      </div>

      <section className="settings-submodule-title settings-submodule-row">
        <div>
          <h2>{text.summaryGeneration}</h2>
          <p>{summaryIndependent ? text.summaryIndependent : text.summaryShared}</p>
        </div>
        <label className="settings-inline-toggle">
          <input
            type="checkbox"
            checked={summaryIndependent}
            onChange={(event) => setSummaryIndependent(event.target.checked)}
          />
          <span>{text.enableIndependentSummary}</span>
        </label>
      </section>
      <SummaryStrategySettingsPanel
        settings={llmSummarySettings}
        onChange={onLlmSummaryChange}
      />
      {summaryIndependent ? (
        <LlmSummarySettingsPanel
          settings={llmSummarySettings}
          onChange={onLlmSummaryChange}
          currentLabel={text.currentSummaryApi}
          showHeader={false}
        />
      ) : (
        <div className="settings-shared-summary">
          {text.summaryUsesShared}
        </div>
      )}
    </>
  );
}
