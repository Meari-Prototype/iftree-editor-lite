// 设置屏（frontend-refactor.md §6 阶段 3）：activeScreen==='settings' 的整屏渲染。
// 数据经 useAppState / useAppUIContext——不收装配根 props。

import { WindowTitlebar } from '../components/common.jsx';
import { SettingsView } from '../components/SettingsView.jsx';
import { useAppUIContext } from '../hooks/useAppUI.js';
import { useAppState } from '../app-context.js';

export function SettingsScreen() {
  const { busy, notice, progress, setNotice, setActiveScreen } = useAppUIContext();
  const { settingsState, agentChat, misc } = useAppState();
  const {
    vectorSettings, llmSummarySettings, generalSettings,
    saveVectorSettings, saveLlmSummarySettings, saveGeneralSettings
  } = settingsState;
  return (
    <>
      <WindowTitlebar onClose={misc.handleCloseWindow} />
      <SettingsView
        vectorSettings={vectorSettings}
        llmSummarySettings={llmSummarySettings}
        agentSettings={agentChat.settings}
        generalSettings={generalSettings}
        notice={notice}
        clearNotice={() => setNotice('')}
        onBack={() => setActiveScreen('editor')}
        onChange={saveVectorSettings}
        onLlmSummaryChange={saveLlmSummarySettings}
        onAgentChange={misc.saveAgentSettings}
        onGeneralChange={saveGeneralSettings}
        onChooseLocalModelRoot={misc.chooseLocalModelRoot}
        onDownloadVectorModel={misc.downloadVectorModel}
        progress={progress}
        busy={busy}
      />
    </>
  );
}
