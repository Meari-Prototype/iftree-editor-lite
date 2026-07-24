// 主题切换：theme.css 定义两套 token（obsidian / pine），这里负责持久化与 DOM 落地。

const THEME_STORAGE_KEY = 'iftree.theme';
const THEMES = ['obsidian', 'pine'] as const;

export type ThemeName = (typeof THEMES)[number];

function normalizeTheme(value: unknown): ThemeName {
  return THEMES.includes(value as ThemeName) ? (value as ThemeName) : 'obsidian';
}

export function currentTheme(): ThemeName {
  return normalizeTheme(document.documentElement.dataset.theme);
}

export function applyTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage 不可用时主题仅在本次会话生效
  }
}

export function toggleTheme(): ThemeName {
  const next = currentTheme() === 'obsidian' ? 'pine' : 'obsidian';
  applyTheme(next);
  return next;
}

export function initTheme() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    stored = null;
  }
  document.documentElement.dataset.theme = normalizeTheme(stored);
}
