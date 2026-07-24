import { callIftree } from './iftree-api.js';

type SettingsPatch = Record<string, unknown>;

export const settingsRepository = {
  readVectorSettings() {
    return callIftree('readVectorSettings');
  },

  saveVectorSettings(patch: SettingsPatch) {
    return callIftree('saveVectorSettings', patch);
  },

  readLlmSummarySettings() {
    return callIftree('readLlmSummarySettings');
  },

  saveLlmSummarySettings(settings: SettingsPatch) {
    return callIftree('saveLlmSummarySettings', settings);
  },

  readAgentSettings() {
    return callIftree('readAgentSettings');
  },

  saveAgentSettings(settings: SettingsPatch) {
    return callIftree('saveAgentSettings', settings);
  },

  readNodeLayoutSettings() {
    return callIftree('readNodeLayoutSettings');
  },

  saveNodeLayoutSettings(settings: SettingsPatch) {
    return callIftree('saveNodeLayoutSettings', settings);
  },

  readGeneralSettings() {
    return callIftree('readGeneralSettings');
  },

  saveGeneralSettings(patch: SettingsPatch) {
    return callIftree('saveGeneralSettings', patch);
  }
};

export const settingsService = settingsRepository;
