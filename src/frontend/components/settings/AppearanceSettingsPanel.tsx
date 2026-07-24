// 设置屏「外观」分类面板：目前只有配色主题（obsidian / pine 两套 token）。
// 字体、对比度等 Codex 式自定义项本项目不存在对应子系统，按约定不放。

import { Palette } from 'lucide-react';
import { useState } from 'react';

import { applyTheme, currentTheme, type ThemeName } from '../../lib/theme.js';
import { useUiLanguage } from '../../../lang/ui.js';
import { SettingsSegment } from './SettingsSegment.jsx';

export function AppearanceSettingsPanel() {
  const { messages } = useUiLanguage();
  const text = messages.settings.appearance;
  const themeOptions: ReadonlyArray<{ value: ThemeName; label: string }> = [
    { value: 'obsidian', label: text.obsidian },
    { value: 'pine', label: text.pine }
  ];
  const [theme, setTheme] = useState<ThemeName>(() => currentTheme());

  return (
    <>
      <header className="settings-header">
        <h1>{text.title}</h1>
        <p>{text.description}</p>
      </header>

      <section className="settings-group">
        <header>
          <h2>{text.theme}</h2>
          <span>{text.immediate}</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><Palette size={17} /></div>
            <div className="settings-row-text">
              <strong>{text.colorTheme}</strong>
              <span>{text.colorThemeDescription}</span>
            </div>
            <div className="settings-row-control">
              <SettingsSegment
                value={theme}
                options={themeOptions}
                onChange={(next) => {
                  applyTheme(next);
                  setTheme(next);
                }}
              />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
