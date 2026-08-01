// 设置屏「外观」分类面板：配色主题管理 + 当前主题四色编辑。
// 一个主题 = 一组四色映射。配色主题栏是可编辑下拉（combobox）：
// 输入框显示并就地编辑当前主题名，右侧小按钮点开下拉列表选主题 / 新建；
// 保存按钮写回名称，删除按钮删当前选中主题（内置不可删）。

import { ChevronDown, Palette, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';

import {
  allThemes,
  applyTheme,
  createCustomTheme,
  currentThemeId,
  deleteCustomTheme,
  themeById,
  updateCustomTheme,
  type ThemeColors,
  type ThemeDef
} from '../../lib/theme.js';
import { useFloatingMenu } from '../../hooks/useFloatingMenu.js';
import { useUiLanguage } from '../../../lang/ui.js';
import { ChoiceDialog } from '../common.jsx';

const NEW_THEME_VALUE = '__new__';

export function AppearanceSettingsPanel() {
  const { messages } = useUiLanguage();
  const text = messages.settings.appearance;
  const [activeId, setActiveId] = useState<string>(() => currentThemeId());
  const [themes, setThemes] = useState<ThemeDef[]>(() => allThemes());
  const [draftName, setDraftName] = useState(() => themeById(currentThemeId())?.name || '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const menu = useFloatingMenu({
    specs: (id) => (id === 'theme' ? { className: 'appearance-theme-menu', width: 260, height: 320 } : null)
  });

  const active = themeById(activeId) || themes[0];
  const colorRows: ReadonlyArray<{ key: keyof ThemeColors; label: string; detail: string }> = [
    { key: 'accent', label: text.accent, detail: text.accentDescription },
    { key: 'background', label: text.background, detail: text.backgroundDescription },
    { key: 'backgroundAlt', label: text.backgroundAlt, detail: text.backgroundAltDescription },
    { key: 'foreground', label: text.foreground, detail: text.foregroundDescription }
  ];

  const refresh = () => setThemes(allThemes());

  const chooseTheme = (value: string) => {
    menu.close();
    if (value === NEW_THEME_VALUE) {
      const created = createCustomTheme('', activeId);
      refresh();
      applyTheme(created.id);
      setActiveId(created.id);
      setDraftName(created.name);
      return;
    }
    applyTheme(value);
    setActiveId(value);
    setDraftName(themeById(value)?.name || '');
  };

  const saveName = () => {
    if (!active || active.builtin) return;
    updateCustomTheme(active.id, { name: draftName });
    refresh();
  };

  const removeActiveTheme = () => {
    if (!active || active.builtin) return;
    setConfirmingDelete(true);
  };

  const doDelete = () => {
    if (!active) return;
    deleteCustomTheme(active.id);
    refresh();
    const fallback = currentThemeId();
    setActiveId(fallback);
    setDraftName(themeById(fallback)?.name || '');
  };

  const setColor = (key: keyof ThemeColors, hex: string) => {
    if (!active) return;
    if (active.builtin) {
      // 内置主题只读：改色即以此主题为底新建自定义主题并应用
      const created = createCustomTheme('', active.id);
      updateCustomTheme(created.id, { colors: { [key]: hex } });
      refresh();
      applyTheme(created.id);
      setActiveId(created.id);
      setDraftName(themeById(created.id)?.name || '');
      return;
    }
    updateCustomTheme(active.id, { colors: { [key]: hex } });
    refresh();
  };

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
            <div className="settings-row-control appearance-theme-control">
              <div className="appearance-combo">
                <input
                  className="appearance-theme-name"
                  value={draftName}
                  placeholder={text.themeNamePlaceholder}
                  disabled={active?.builtin}
                  onChange={(event) => setDraftName(event.target.value)}
                />
                <button
                  type="button"
                  className="appearance-combo-toggle"
                  title={text.colorTheme}
                  aria-label={text.colorTheme}
                  onClick={(event) => menu.toggle('theme', event)}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              {active && !active.builtin && (
                <button
                  type="button"
                  className="appearance-save-button"
                  onClick={saveName}
                >
                  {messages.common.save}
                </button>
              )}
              <button
                type="button"
                className="appearance-icon-button"
                title={text.deleteTheme}
                aria-label={text.deleteTheme}
                disabled={!active || active.builtin}
                onClick={removeActiveTheme}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>{active ? active.name : text.theme}</h2>
          <span>{active?.builtin ? text.colorThemeDescription : text.immediate}</span>
        </header>
        <div className="settings-list">
          {colorRows.map((row) => (
            <div key={row.key} className="settings-row">
              <div className="settings-row-icon">
                <span
                  className="appearance-color-swatch"
                  style={{ background: active?.colors[row.key] }}
                  aria-hidden="true"
                />
              </div>
              <div className="settings-row-text">
                <strong>{row.label}</strong>
                <span>{row.detail}</span>
              </div>
              <div className="settings-row-control appearance-color-control">
                <input
                  type="color"
                  value={active?.colors[row.key] || '#ffffff'}
                  onChange={(event) => setColor(row.key, event.target.value)}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {menu.openId === 'theme' && menu.position && createPortal(
        <div
          className="appearance-theme-menu"
          style={{
            left: `${menu.position.left}px`,
            top: `${menu.position.top}px`,
            width: `${menu.position.width}px`
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {themes.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={theme.id === activeId ? 'active' : ''}
              onClick={() => chooseTheme(theme.id)}
            >
              {theme.builtin ? theme.name : `${theme.name}${text.customThemeSuffix}`}
            </button>
          ))}
          <div className="appearance-theme-menu-sep" />
          <button type="button" onClick={() => chooseTheme(NEW_THEME_VALUE)}>
            {text.newThemePrefix} {text.newTheme}
          </button>
        </div>,
        document.body
      )}

      <ChoiceDialog
        open={confirmingDelete}
        title={text.deleteTheme}
        message={active ? text.confirmDeleteTheme(active.name) : ''}
        backdropValue="cancel"
        actions={[
          { value: 'cancel', label: messages.common.cancel },
          { value: 'confirm', label: messages.common.delete, autoFocus: true }
        ]}
        onChoose={(value) => {
          setConfirmingDelete(false);
          if (value === 'confirm') doDelete();
        }}
      />
    </>
  );
}
