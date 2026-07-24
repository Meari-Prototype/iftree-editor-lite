// 设置屏「常规」分类面板：权限、存储目录、阅读、语言、调试五组（外观已拆到独立分类）。
// 本地偏好（权限/语言/PDF 策略）走 ui-prefs 的 localStorage；调试开关走后端 iftree.config.json。

import { BookOpen, Bot, Bug, Database, FolderOpen, HardDrive, Languages, Shield } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { callIftree, hasIftreeMethod } from '../../data/iftree-api.js';
import { setDebugLoggingEnabled } from '../../lib/debug-log.js';
import {
  readAgentDefaultMode,
  readPdfZoomPolicy,
  writeAgentDefaultMode,
  writePdfZoomPolicy,
  type AgentDefaultMode,
  type PdfZoomPolicy
} from '../../lib/ui-prefs.js';
import { UI_LANGUAGE_PACKS, type UiLanguagePreference } from '../../../lang/catalog.js';
import { useUiLanguage } from '../../../lang/ui.js';
import { SettingsSegment } from './SettingsSegment.jsx';

type SettingsObject = Record<string, unknown>;

interface GeneralSettingsPanelProps {
  generalSettings?: SettingsObject | null; // readGeneralSettings 的 payload
  onGeneralChange?: (patch: { debugLogging?: boolean }) => void;
}

export function GeneralSettingsPanel({ generalSettings, onGeneralChange }: GeneralSettingsPanelProps) {
  const { preference, messages, setPreference } = useUiLanguage();
  const text = messages.settings.general;
  const [agentMode, setAgentMode] = useState<AgentDefaultMode>(() => readAgentDefaultMode());
  const [zoomPolicy, setZoomPolicy] = useState<PdfZoomPolicy>(() => readPdfZoomPolicy());
  const agentModeOptions: ReadonlyArray<{ value: AgentDefaultMode; label: string; description: string }> = [
    { value: 'qa', label: text.modeQa, description: text.modeQaDescription },
    { value: 'edit', label: text.modeEdit, description: text.modeEditDescription },
    { value: 'full', label: text.modeFull, description: text.modeFullDescription }
  ];
  const pdfZoomPolicyOptions: ReadonlyArray<{ value: PdfZoomPolicy; label: string }> = [
    { value: 'last', label: text.rememberLast },
    { value: 'fixed-125', label: text.fixed125 },
    { value: 'fixed-100', label: text.fixed100 },
    { value: 'fit-width', label: text.fitWidth }
  ];
  const languageOptions: ReadonlyArray<{ value: UiLanguagePreference; label: string }> = [
    { value: 'auto', label: messages.common.auto },
    ...Object.values(UI_LANGUAGE_PACKS).map((pack) => ({ value: pack.locale, label: pack.nativeName }))
  ];

  const paths = (generalSettings?.paths || {}) as SettingsObject;
  const envOverrides = (generalSettings?.envOverrides || {}) as SettingsObject;
  const loading = generalSettings == null;
  // openPath 走 Electron 主进程 shell.openPath，纯浏览器/Web 预览下没有这条原生通道。
  const openPathAvailable = hasIftreeMethod('openPath');
  const openPath = (path: unknown) => {
    void callIftree('openPath', String(path || '')).catch(() => {
      // 打开失败（路径刚被移走等）不打断设置页；失败原因由主进程返回值携带。
    });
  };

  const activeMode = agentModeOptions.find((option) => option.value === agentMode) || agentModeOptions[0];
  // envOverrides 对应关系：主数据库看 IFTREE_DB；agent/向量库派生自 appHome（IFTREE_HOME）；library 看 IFTREE_LIBRARY_ROOT。
  const pathRows: Array<{ icon: ReactNode; label: string; detail: string; path: unknown; overridden: boolean }> = [
    { icon: <Database size={17} />, label: text.mainDatabase, detail: text.mainDatabaseDescription, path: paths.mainDb, overridden: envOverrides.db === true },
    { icon: <Bot size={17} />, label: text.agentDatabase, detail: text.agentDatabaseDescription, path: paths.agentDb, overridden: envOverrides.home === true },
    { icon: <HardDrive size={17} />, label: text.vectorDatabase, detail: text.vectorDatabaseDescription, path: paths.vectorDb, overridden: envOverrides.home === true },
    { icon: <FolderOpen size={17} />, label: text.libraryFolder, detail: text.libraryFolderDescription, path: paths.libraryDir, overridden: envOverrides.library === true }
  ];

  return (
    <>
      <header className="settings-header">
        <h1>{text.title}</h1>
        <p>{text.description}</p>
      </header>

      <section className="settings-group">
        <header>
          <h2>{text.permission}</h2>
          <span>{text.permissionHint}</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><Shield size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.defaultPermission}</strong>
              <span>{activeMode.description}{text.permissionTail}</span>
            </div>
            <div className="settings-row-control">
              <SettingsSegment
                value={agentMode}
                options={agentModeOptions}
                onChange={(next) => {
                  writeAgentDefaultMode(next);
                  setAgentMode(next);
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>{text.storage}</h2>
          <span>{text.readOnly}</span>
        </header>
        <div className="settings-list">
          {pathRows.map((row) => (
            <div key={row.label} className="settings-row">
              <div className="settings-row-icon">{row.icon}</div>
              <div className="settings-row-text">
                <strong>{row.label}</strong>
                <span>{row.detail}{row.overridden ? text.environmentOverride : ''}</span>
              </div>
              <div className="settings-row-control settings-path-control">
                <code>{loading ? messages.common.loading : String(row.path || '')}</code>
                <button
                  type="button"
                  disabled={!openPathAvailable || loading || !row.path}
                  title={openPathAvailable ? text.showInFileManager : text.desktopOnly}
                  onClick={() => openPath(row.path)}
                >
                  {messages.common.open}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>{text.reading}</h2>
          <span>{text.readingHint}</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><BookOpen size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.pdfDefaultZoom}</strong>
              <span>{text.pdfDefaultZoomDescription}</span>
            </div>
            <div className="settings-row-control">
              <select
                value={zoomPolicy}
                onChange={(event) => {
                  const next = event.target.value as PdfZoomPolicy;
                  writePdfZoomPolicy(next);
                  setZoomPolicy(next);
                }}
              >
                {pdfZoomPolicyOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>{text.language}</h2>
          <span>{text.languageHint}</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><Languages size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.interfaceLanguage}</strong>
              <span>{text.interfaceLanguageDescription}</span>
            </div>
            <div className="settings-row-control">
              <select
                value={preference}
                onChange={(event) => {
                  setPreference(event.target.value as UiLanguagePreference);
                }}
              >
                {languageOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>{text.debug}</h2>
          <span>{text.autoSave}</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><Bug size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.debugLogging}</strong>
              <span>{text.debugLoggingDescription}</span>
            </div>
            <div className="settings-row-control">
              <label className="settings-inline-toggle">
                <input
                  type="checkbox"
                  checked={generalSettings?.debugLogging === true}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    // 前端调试开关立即生效；后端持久化走 onGeneralChange → saveGeneralSettings。
                    setDebugLoggingEnabled(checked);
                    onGeneralChange?.({ debugLogging: checked });
                  }}
                />
                <span>{text.enableDebugLogging}</span>
              </label>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
