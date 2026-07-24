// 设置屏「个性化」分类面板：回复语气（agent.tone.* 提示词段）+ 自定义指令（personalPrompt）。
// 两者都存 llm.agent（iftree.config.json），经 saveAgentSettings 落盘；记忆类配置本项目没有，不放。

import { Sparkles } from 'lucide-react';
import { useUiLanguage } from '../../../lang/ui.js';

type SettingsObject = Record<string, unknown>;

interface PersonalizationSettingsPanelProps {
  agentSettings?: (SettingsObject & { personalPrompt?: string; tone?: string }) | null;
  onAgentChange?: (settings: SettingsObject) => void;
}

export function PersonalizationSettingsPanel({ agentSettings, onAgentChange }: PersonalizationSettingsPanelProps) {
  const { messages } = useUiLanguage();
  const text = messages.settings.personalization;
  // Values map to system_prompt.md agent.tone.* keys; labels belong to the UI pack.
  const toneOptions: ReadonlyArray<{ value: string; label: string; description: string }> = [
    { value: '', label: text.toneDefault, description: text.toneDefaultDescription },
    { value: 'pragmatic', label: text.tonePragmatic, description: text.tonePragmaticDescription },
    { value: 'rigorous', label: text.toneRigorous, description: text.toneRigorousDescription },
    { value: 'concise', label: text.toneConcise, description: text.toneConciseDescription },
    { value: 'warm', label: text.toneWarm, description: text.toneWarmDescription }
  ];
  if (!agentSettings) {
    return (
      <header className="settings-header">
        <h1>{text.title}</h1>
        <p>{text.loading}</p>
      </header>
    );
  }
  const tone = toneOptions.some((option) => option.value === agentSettings.tone)
    ? String(agentSettings.tone)
    : '';
  const activeTone = toneOptions.find((option) => option.value === tone) || toneOptions[0];
  const save = (patch: SettingsObject) => onAgentChange?.({ ...agentSettings, ...patch });

  return (
    <>
      <header className="settings-header">
        <h1>{text.title}</h1>
        <p>{text.description}</p>
      </header>

      <section className="settings-group">
        <header>
          <h2>{text.personality}</h2>
          <span>{text.autoSave}</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><Sparkles size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.responseTone}</strong>
              <span>{activeTone.description}</span>
            </div>
            <div className="settings-row-control">
              <select
                value={tone}
                onChange={(event) => save({ tone: event.target.value })}
              >
                {toneOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>{text.customInstructions}</h2>
          <span>{text.autoSave}</span>
        </header>
        <div className="llm-settings-card">
          <label className="llm-field llm-field-wide">
            <textarea
              value={agentSettings.personalPrompt || ''}
              placeholder={text.customInstructionsPlaceholder}
              onChange={(event) => save({ personalPrompt: event.target.value })}
            />
          </label>
        </div>
      </section>
    </>
  );
}
