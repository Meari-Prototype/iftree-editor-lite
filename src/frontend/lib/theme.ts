// 主题系统：一个主题就是一组四色映射（accent / background / backgroundAlt / foreground）。
// 内置 pine / obsidian 两套只读；用户可新建、删除自定义主题，存 localStorage。
// 选中主题即把其四色以 inline custom property 覆盖到 <html>，其余 token 由 color-mix 派生。

const ACTIVE_THEME_KEY = 'iftree.theme';
const CUSTOM_THEMES_KEY = 'iftree.customThemes';

// ── 主题模型 ───────────────────────────────────────────────────────────────

export interface ThemeColors {
  accent: string;        // --interactive-accent
  background: string;    // --background-primary
  backgroundAlt: string; // --background-secondary
  foreground: string;    // --text-normal
}

export interface ThemeDef {
  id: string;
  name: string;
  builtin: boolean;
  colors: ThemeColors;
}

// 与 theme.css 的 token 一一对应。其余 token 由这四色经 color-mix 派生，不单独暴露。
const COLOR_VARS: Record<keyof ThemeColors, string> = {
  accent: '--interactive-accent',
  background: '--background-primary',
  backgroundAlt: '--background-secondary',
  foreground: '--text-normal'
};

// 内置主题：色值取自 theme.css（pine / obsidian）。pine 为默认。
const BUILTIN_THEMES: ThemeDef[] = [
  {
    id: 'pine',
    name: '松绿',
    builtin: true,
    colors: { accent: '#2f6655', background: '#fbfcfa', backgroundAlt: '#f3f5f2', foreground: '#202724' }
  },
  {
    id: 'obsidian',
    name: '黑曜',
    builtin: true,
    colors: { accent: '#7b5ce6', background: '#ffffff', backgroundAlt: '#f6f6f6', foreground: '#1f1f1f' }
  }
];

function normalizeHex(value: unknown): string {
  const text = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : '';
}

function normalizeThemeColors(raw: unknown): ThemeColors | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const colors: Partial<ThemeColors> = {};
  for (const key of Object.keys(COLOR_VARS) as Array<keyof ThemeColors>) {
    const hex = normalizeHex(source[key]);
    if (!hex) return null;
    colors[key] = hex;
  }
  return colors as ThemeColors;
}

// ── 主题目录（内置 + 自定义）────────────────────────────────────────────────

export function readCustomThemes(): ThemeDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const colors = normalizeThemeColors(item?.colors);
        const id = String(item?.id || '').trim();
        if (!colors || !id) return null;
        return { id, name: String(item?.name || id), builtin: false, colors };
      })
      .filter((item): item is ThemeDef => Boolean(item));
  } catch {
    return [];
  }
}

export function allThemes(): ThemeDef[] {
  return [...BUILTIN_THEMES, ...readCustomThemes()];
}

export function themeById(id: string): ThemeDef | null {
  return allThemes().find((theme) => theme.id === id) || null;
}

// ── 主题应用 ───────────────────────────────────────────────────────────────

function applyThemeColors(colors: ThemeColors) {
  const root = document.documentElement;
  for (const [key, varName] of Object.entries(COLOR_VARS) as Array<[keyof ThemeColors, string]>) {
    root.style.setProperty(varName, colors[key]);
  }
  // accent 的 hover 档：未单独建模，按 accent 变暗派生，保证按钮/链接/图标跟主题走
  // （否则 --interactive-accent-hover 停留在内置主题值，自定义主题下按钮色不跟随）。
  const hover = darken(colors.accent, 0.82);
  root.style.setProperty('--interactive-accent-hover', hover);

  // ── 由四色派生的配套 token（theme.css 里写死在 :root / pine，自定义主题须派生覆盖）──
  // accent 系：soft（柔和底）、border（两档描边）、文字 accent 两档。
  root.style.setProperty('--accent-soft', mix(colors.accent, colors.background, 0.12));
  root.style.setProperty('--accent-border', mix(colors.accent, colors.background, 0.45));
  root.style.setProperty('--accent-border-light', mix(colors.accent, colors.background, 0.28));
  root.style.setProperty('--text-accent-strong', darken(colors.accent, 0.5));
  root.style.setProperty('--text-accent-muted', mix(colors.accent, colors.foreground, 0.55));
  // 边框与悬停：由前景/背景派生，保持与主题明度一致。
  root.style.setProperty('--background-modifier-border', mix(colors.foreground, colors.background, 0.13));
  root.style.setProperty('--background-modifier-border-strong', mix(colors.foreground, colors.background, 0.2));
  root.style.setProperty('--background-modifier-hover', withAlpha(colors.foreground, 0.06));

  // accent / 文本主色变了，对应 rgb 变体同步（透明表面、scrollbar 用）。
  setRgb('--interactive-accent-rgb', colors.accent);
  setRgb('--interactive-accent-hover-rgb', hover);
  setRgb('--text-normal-rgb', colors.foreground);
  setRgb('--background-primary-rgb', colors.background);
  setRgb('--background-secondary-rgb', colors.backgroundAlt);
  setRgb('--background-modifier-border-rgb', mix(colors.foreground, colors.background, 0.13));

  function setRgb(varName: string, hex: string) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    root.style.setProperty(varName, `${r}, ${g}, ${b}`);
  }
}

// 两个 #rrggbb 按 weight（前色占比）线性混合，返回 #rrggbb。
function mix(a: string, b: string, weightA: number): string {
  const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar * weightA + br * (1 - weightA));
  const g = Math.round(ag * weightA + bg * (1 - weightA));
  const bl = Math.round(ab * weightA + bb * (1 - weightA));
  const to = (n: number) => n.toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(bl)}`;
}

// #rrggbb → rgba 字符串（用于 --background-modifier-hover 这类带透明度 token）。
function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 把 #rrggbb 按比例压暗（向 0 缩），用于 accent → accent-hover 派生。
function darken(hex: string, factor: number): string {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * factor);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * factor);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * factor);
  const to = (n: number) => n.toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function currentThemeId(): string {
  try {
    const stored = localStorage.getItem(ACTIVE_THEME_KEY);
    if (stored && themeById(stored)) return stored;
  } catch {
    // ignore
  }
  return 'pine';
}

export function applyTheme(id: string) {
  const theme = themeById(id) || themeById('pine');
  if (!theme) return;
  document.documentElement.dataset.theme = theme.builtin ? theme.id : 'custom';
  // 内置主题：清掉所有内联覆盖，让 theme.css 的 :root / [data-theme] 原生 token 生效；
  // 自定义主题：把四色 + 派生 token 内联覆盖到 <html>。
  if (theme.builtin) {
    clearInlineOverrides();
  } else {
    applyThemeColors(theme.colors);
  }
  try {
    localStorage.setItem(ACTIVE_THEME_KEY, theme.id);
  } catch {
    // localStorage 不可用时主题仅在本次会话生效
  }
}

// 切回内置主题时，清掉 applyThemeColors 写过的所有内联 custom property。
function clearInlineOverrides() {
  const root = document.documentElement;
  const vars = [
    ...Object.values(COLOR_VARS),
    '--interactive-accent-hover',
    '--accent-soft', '--accent-border', '--accent-border-light',
    '--text-accent-strong', '--text-accent-muted',
    '--background-modifier-border', '--background-modifier-border-strong', '--background-modifier-hover',
    '--interactive-accent-rgb', '--interactive-accent-hover-rgb', '--text-normal-rgb',
    '--background-primary-rgb', '--background-secondary-rgb', '--background-modifier-border-rgb'
  ];
  for (const varName of vars) root.style.removeProperty(varName);
}

// 「更多」菜单的二态切换 → 多主题循环：按目录顺序切到下一个。
export function toggleTheme(): string {
  const themes = allThemes();
  const current = currentThemeId();
  const index = themes.findIndex((theme) => theme.id === current);
  const next = themes[(index + 1 + themes.length) % themes.length] || themes[0];
  applyTheme(next.id);
  return next.id;
}

// ── 自定义主题增删 ─────────────────────────────────────────────────────────

function saveCustomThemes(themes: ThemeDef[]) {
  try {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes));
  } catch {
    // ignore
  }
}

// 新建自定义主题：以某主题为底（默认当前主题），返回新主题 id。
export function createCustomTheme(name: string, baseId?: string): ThemeDef {
  const base = themeById(baseId || currentThemeId()) || themeById('pine');
  const themes = readCustomThemes();
  const id = `custom-${Date.now().toString(36)}`;
  const theme: ThemeDef = {
    id,
    name: name.trim() || `自定义 ${themes.length + 1}`,
    builtin: false,
    colors: { ...(base?.colors as ThemeColors) }
  };
  saveCustomThemes([...themes, theme]);
  return theme;
}

export function updateCustomTheme(id: string, patch: Partial<Pick<ThemeDef, 'name'>> & { colors?: Partial<ThemeColors> }) {
  const themes = readCustomThemes();
  const next = themes.map((theme) => {
    if (theme.id !== id) return theme;
    const colors = normalizeThemeColors({ ...theme.colors, ...(patch.colors || {}) });
    return {
      ...theme,
      name: patch.name !== undefined ? String(patch.name) : theme.name,
      colors: colors || theme.colors
    };
  });
  saveCustomThemes(next);
  // 改的是当前主题则即时重应用
  if (currentThemeId() === id) applyTheme(id);
}

export function deleteCustomTheme(id: string) {
  const wasActive = currentThemeId() === id;
  saveCustomThemes(readCustomThemes().filter((theme) => theme.id !== id));
  // 删的是当前主题则回退默认（先记 wasActive，否则删完 currentThemeId 已失效）
  if (wasActive) applyTheme('pine');
}

// ── 初始化 ─────────────────────────────────────────────────────────────────

export function initTheme() {
  applyTheme(currentThemeId());
}
